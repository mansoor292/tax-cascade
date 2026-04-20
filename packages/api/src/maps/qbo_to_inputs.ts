/**
 * Map QBO P&L + Balance Sheet → 1120 / 1120S input packet
 *
 * Called from /api/returns/compute when an entity has a QBO connection and
 * also exposed directly as /api/qbo-to-tax-inputs/:entity_id so the caller
 * can inspect classification decisions before committing them.
 *
 * Returns a structured packet:
 *   { inputs, audit, warnings }
 * where every auto-derived value in `inputs` has a corresponding `audit`
 * entry citing its QBO source + confidence. The caller edits `inputs` in
 * place (overriding any classification) and passes the edited packet back
 * to /api/returns/compute.
 *
 * Coverage:
 *   - P&L → 1120/1120S deduction buckets (COGS, salaries, rents, taxes,
 *     advertising, interest, depreciation, depletion, pension, benefits,
 *     bad_debts, repairs, charitable, other_deductions)
 *   - OtherIncome (non-portfolio) → other_income (L5)
 *   - Balance sheet → Schedule L canonical keys (schedL.L1_cash_eoy_d, etc.)
 *   - Schedule M-1 seed values (net income per books)
 *
 * NOT covered (by design — other sources are authoritative):
 *   - Schedule K portfolio items (interest, dividends, cap gains) — come
 *     from 1099 facts in the /compute auto-merge block to avoid double-
 *     count with QBO's book-level interest/dividend accounts.
 *   - Officer compensation split — emits OFFICER_COMP_UNSPLIT warning
 *     because the preparer's call; QBO doesn't track it separately.
 *
 * Every classification the caller might disagree with emits a warning or
 * is tagged with low-confidence audit so the override path is discoverable.
 */
import type { Form1120S_Inputs, Form1120_Inputs } from '../engine/tax_engine.js'
import { isSstbByNaics } from '../engine/tax_tables.js'
import { buildScheduleL } from './qbo_to_schedule_l.js'

type Pnl = Record<string, number>

// ─── Public types ─────────────────────────────────────────────────────────

export interface AuditEntry {
  tax_field: string
  qbo_source: string
  amount: number
  /** `rule:<name>` | `fallback:other` | `fact:<doc_type>.<key>` | `aggregate:<parent>` */
  confidence: string
}

export interface Warning {
  code: string
  message: string
  fix_hint?: string
}

export interface MapperInput {
  pnl: Pnl
  bs?: Record<string, number>
  priorBs?: Record<string, number>
  form_type: '1120' | '1120S'
  business_code?: string
}

export interface MapperOutput {
  inputs: Record<string, number>
  audit: AuditEntry[]
  warnings: Warning[]
}

// ─── Classification rules ────────────────────────────────────────────────
// Keyword → 1120S deduction bucket (order matters — first match wins).
const DEDUCTION_RULES: Array<{ bucket: keyof Form1120S_Inputs; patterns: RegExp[]; rule: string }> = [
  { bucket: 'repairs_maintenance', rule: 'repairs',     patterns: [/^repairs? ?&? ?maintenance$/i, /^repairs$/i] },
  { bucket: 'rents',              rule: 'rent',         patterns: [/^rent$/i, /^rent expense$/i, /rent or lease/i] },
  { bucket: 'taxes_licenses',     rule: 'taxes',        patterns: [/payroll tax/i, /^taxes? & licenses?$/i, /^taxes$/i, /^state tax/i, /^business license/i] },
  { bucket: 'advertising',        rule: 'advertising',  patterns: [/^advertising/i, /^marketing$/i, /^ppc/i] },
  { bucket: 'interest',           rule: 'interest_exp', patterns: [/^interest paid/i, /interest expense/i, /mortgage interest/i, /loan interest/i] },
  { bucket: 'depreciation',       rule: 'depreciation', patterns: [/^depreciation/i] },
  { bucket: 'depletion',          rule: 'depletion',    patterns: [/^depletion/i] },
  { bucket: 'pension_plans',      rule: 'pension',      patterns: [/pension/i, /401\(?k\)?/i, /retirement plan/i] },
  { bucket: 'employee_benefits',  rule: 'emp_benefits', patterns: [/employee benefit/i] },
  { bucket: 'bad_debts',          rule: 'bad_debts',    patterns: [/^bad debts?/i] },
  { bucket: 'salaries_wages',     rule: 'salaries',     patterns: [/^salaries ?& ?wages?$/i, /^wages?$/i] },
]

// OtherIncome leaves → Schedule K (1120S) — tracked here only so we can SKIP
// them (they're authoritative via 1099 facts, not QBO).
const SCHED_K_PATTERNS: RegExp[] = [
  /^interest (earned|income)/i,
  /^dividend income/i,
  /^dividends$/i,
  /^royalt(y|ies)/i,
  /sale of investments/i,
  /^realized gain/i,
  /^capital gain/i,
  /tax[- ]?exempt interest/i,
]

// Income leaves that should NOT be in gross_receipts
const REVENUE_EXCLUSIONS: Array<{ target: 'other_income'; patterns: RegExp[]; rule: string }> = [
  { target: 'other_income', rule: 'uncategorized_income', patterns: [/uncategorized income/i] },
]

// Expenses that belong elsewhere (e.g. charity → Schedule K line 12a).
const EXPENSE_RECLASS: Array<{ target: keyof Form1120S_Inputs; patterns: RegExp[]; rule: string }> = [
  { target: 'charitable_contrib', rule: 'charitable', patterns: [/contributions? to charit/i, /^charitable/i, /donations?$/i] },
]

// ─── Helpers ─────────────────────────────────────────────────────────────

function matchDeduction(name: string): { bucket: string; rule: string } | null {
  for (const r of DEDUCTION_RULES) {
    if (r.patterns.some(p => p.test(name))) return { bucket: r.bucket as string, rule: r.rule }
  }
  return null
}

function matchReclass(name: string): { target: string; rule: string } | null {
  for (const r of EXPENSE_RECLASS) {
    if (r.patterns.some(p => p.test(name))) return { target: r.target as string, rule: r.rule }
  }
  return null
}

function matchRevenueExclusion(name: string): { target: string; rule: string } | null {
  for (const r of REVENUE_EXCLUSIONS) {
    if (r.patterns.some(p => p.test(name))) return { target: r.target as string, rule: r.rule }
  }
  return null
}

function isScheduleK(name: string): boolean {
  return SCHED_K_PATTERNS.some(p => p.test(name))
}

/** Collect leaf items under a parent prefix (e.g. "Expenses > Foo"). */
function collectLeaves(pnl: Pnl, parentPrefix: string): Array<{ name: string; amount: number }> {
  const prefix = parentPrefix.endsWith('>') ? parentPrefix : `${parentPrefix} >`
  const out: Array<{ name: string; amount: number }> = []
  for (const [k, v] of Object.entries(pnl)) {
    if (typeof v !== 'number' || v === 0) continue
    if (!k.startsWith(prefix)) continue
    const leaf = k.slice(prefix.length).trim()
    if (leaf.includes(' > ')) continue
    out.push({ name: leaf, amount: v })
  }
  return out
}

function totalOrZero(pnl: Pnl, key: string): number {
  const v = pnl[key]
  return typeof v === 'number' ? v : 0
}

// ─── Main entry point ────────────────────────────────────────────────────

export function buildCorporateInputsFromQbo(opts: MapperInput): MapperOutput {
  const { pnl, bs, priorBs, form_type, business_code } = opts
  const inputs: Record<string, number> = {}
  const audit: AuditEntry[] = []
  const warnings: Warning[] = []

  const record = (field: string, amount: number, source: string, confidence: string) => {
    const rounded = Math.round(amount)
    if (rounded === 0) return
    if (inputs[field] !== undefined) {
      inputs[field] = Math.round((inputs[field] as number) + amount)
    } else {
      inputs[field] = rounded
    }
    audit.push({ tax_field: field, qbo_source: source, amount: rounded, confidence })
  }

  const warn = (code: string, message: string, fix_hint?: string) => {
    warnings.push({ code, message, fix_hint })
  }

  // ── Revenue ──
  const incomeTotal = totalOrZero(pnl, 'Income (Total)')
  let grossReceipts = incomeTotal
  let incomeSource = 'Income (Total)'
  let grossReceiptsHasAggregate = incomeTotal > 0
  for (const leaf of collectLeaves(pnl, 'Income')) {
    const reclass = matchRevenueExclusion(leaf.name)
    if (reclass) {
      record(reclass.target, leaf.amount, `Income > ${leaf.name}`, `rule:${reclass.rule}`)
      grossReceipts -= leaf.amount
    }
    if (/customer deposit/i.test(leaf.name)) {
      warn(
        'CONTINGENCY_IN_REVENUE',
        `"${leaf.name}" appears under Income at $${Math.round(leaf.amount).toLocaleString()}. Included in gross_receipts by default — this assumes the contingency was released to revenue.`,
        'If the deposit is still an unreleased liability, override gross_receipts in inputs and book as a liability on Schedule L instead.',
      )
    }
  }
  if (grossReceipts) {
    record('gross_receipts', grossReceipts, incomeSource, grossReceiptsHasAggregate ? 'aggregate:Income' : 'rule:gross_receipts')
  }

  // ── Other income (non-portfolio OtherIncome) ──
  for (const leaf of collectLeaves(pnl, 'OtherIncome')) {
    if (isScheduleK(leaf.name)) {
      // Skip — 1099 facts drive these in the /compute auto-merge block.
      // Emit an informational audit so the caller knows WHY they don't
      // see schedule_k_* fields sourced from QBO here.
      audit.push({
        tax_field: 'schedule_k_*',
        qbo_source: `OtherIncome > ${leaf.name}`,
        amount: Math.round(leaf.amount),
        confidence: 'skipped:portfolio_item_from_1099_facts',
      })
      continue
    }
    record('other_income', leaf.amount, `OtherIncome > ${leaf.name}`, 'rule:other_income_nonportfolio')
  }

  // ── COGS ──
  const cogsLeaves = collectLeaves(pnl, 'COGS')
  if (cogsLeaves.length) {
    for (const { name, amount } of cogsLeaves) {
      const reclass = matchDeduction(name)
      if (reclass) {
        record(reclass.bucket, amount, `COGS > ${name}`, `rule:${reclass.rule}`)
      } else {
        record('cost_of_goods_sold', amount, `COGS > ${name}`, 'rule:cogs_leaf')
      }
    }
  } else {
    const cogsTotal = totalOrZero(pnl, 'COGS (Total)')
    if (cogsTotal) record('cost_of_goods_sold', cogsTotal, 'COGS (Total)', 'aggregate:COGS')
  }

  // ── Expenses + OtherExpenses (ordinary operating deductions) ──
  for (const parent of ['Expenses', 'OtherExpenses']) {
    for (const { name, amount } of collectLeaves(pnl, parent)) {
      const reclass = matchReclass(name)
      if (reclass) {
        record(reclass.target, amount, `${parent} > ${name}`, `rule:${reclass.rule}`)
        continue
      }
      const specific = matchDeduction(name)
      if (specific) {
        record(specific.bucket, amount, `${parent} > ${name}`, `rule:${specific.rule}`)
        continue
      }
      record('other_deductions', amount, `${parent} > ${name}`, 'fallback:other_deductions')
    }
  }

  // ── Schedule L from balance sheet ──
  if (bs) {
    const schedL = buildScheduleL(bs, priorBs)
    for (const [k, v] of Object.entries(schedL)) {
      if (!v) continue
      // Set directly (don't sum) — Schedule L keys are point-in-time.
      inputs[k] = v
      audit.push({
        tax_field: k,
        qbo_source: k.endsWith('_boy_a') || k.endsWith('_boy_b') ? 'QBO BS (prior year)' : 'QBO BS (current year)',
        amount: v,
        confidence: 'rule:schedL',
      })
    }
  }

  // ── 1120 (C-Corp) field-name translation ──
  // The mapping up to this point uses 1120S field names. For 1120 callers
  // we rename the few that differ. 1120 splits portfolio income into
  // dedicated lines; those come from 1099 facts (not here).
  if (form_type === '1120') {
    // interest (L13 1120S deduction) → interest_expense on 1120
    if (inputs.interest !== undefined) {
      inputs.interest_expense = inputs.interest
      delete inputs.interest
      // Retag the audit entry
      for (const e of audit) if (e.tax_field === 'interest') e.tax_field = 'interest_expense'
    }
  }

  // ── Warnings ──
  const sstb = isSstbByNaics(business_code)
  if (sstb.match) {
    warn(
      'SSTB_SUSPECTED',
      `Business code ${business_code} matches "${sstb.category}" — this is a Specified Service Trade or Business under §199A(d)(2). The QBI deduction phases out above the threshold ($383,900 MFJ / $191,950 single for TY2024; $394,600 / $197,300 for TY2025).`,
      `Pass is_sstb:true or is_sstb:false in inputs to confirm. This warning is NOT auto-applied — compute will require explicit confirmation when taxable income exceeds the phaseout.`,
    )
  }

  if (inputs.salaries_wages && !inputs.officer_compensation) {
    warn(
      'OFFICER_COMP_UNSPLIT',
      `Salaries & wages total $${inputs.salaries_wages.toLocaleString()}. QBO does not separate officer compensation from other salaries, but the 1120/1120S form splits them (officer → L7, rest → L8). Current proforma places the entire amount on L8.`,
      `Override officer_compensation in inputs (reasonable salary standard for a S-corp shareholder-employee; pull from W-2 Box 1).`,
    )
  }

  return { inputs, audit, warnings }
}

// ─── Back-compat wrappers ────────────────────────────────────────────────
// The previous signature returned a flat Partial<Form1120S_Inputs>. Kept
// for any callers that haven't migrated to the packet shape yet.

export function build1120SInputsFromQbo(pnl: Pnl): Partial<Form1120S_Inputs> {
  return buildCorporateInputsFromQbo({ pnl, form_type: '1120S' }).inputs as Partial<Form1120S_Inputs>
}

export function build1120InputsFromQbo(pnl: Pnl): Partial<Form1120_Inputs> {
  return buildCorporateInputsFromQbo({ pnl, form_type: '1120' }).inputs as Partial<Form1120_Inputs>
}
