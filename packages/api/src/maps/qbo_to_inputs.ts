/**
 * Map QBO P&L + Balance Sheet → 1120 / 1120S input packet
 *
 * Called from /api/returns/compute when an entity has a QBO connection and
 * also exposed directly as /api/qbo-to-tax-inputs/:entity_id so the caller
 * can inspect classification decisions before committing them.
 *
 * Returns a structured packet:
 *   { inputs, audit, dropped, warnings }
 * where every QBO leaf account either:
 *   - lands on a tax-form input with an `audit` entry citing source + rule, or
 *   - is recorded in `dropped` with a reason — never silently lost.
 *
 * Coverage:
 *   - Income leaves → gross_receipts (positive) / returns_allowances (contra)
 *   - OtherIncome portfolio leaves (interest, dividend, capital gain, royalty)
 *     → Schedule K lines on 1120S, L4/L5 on 1120
 *   - OtherIncome non-portfolio → other_income (L5 1120 / L5 1120S)
 *   - COGS → cost_of_goods_sold + leaf-level reclass to specific deduction lines
 *     (e.g. payroll under COGS → salaries_wages)
 *   - Expenses + OtherExpenses → DEDUCTION_RULES per leaf, fall through to
 *     other_deductions (L20 1120S / L26 1120) — NEVER drop a leaf
 *   - Parent-direct postings (QBO accounts with values posted at the parent
 *     section header rather than a leaf) are picked up via the (Direct)
 *     markers emitted by flattenReport, classified by parent name, and
 *     surfaced as PARENT_DIRECT_POSTING warnings
 *   - Balance sheet → Schedule L canonical keys
 *
 * NOT covered (other sources are authoritative):
 *   - Officer compensation split — emits OFFICER_COMP_SPLIT_NEEDED warning
 *   - Meals 50% disallowance — emits MEALS_NEEDS_DISALLOWANCE; preparer
 *     applies via meals override + M-1 add-back
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
  /** `rule:<name>` | `fallback:other_deductions` | `aggregate:<parent>` |
   *  `parent_direct:<section>` | `skipped:portfolio_routed_to_sched_k` */
  confidence: string
}

export interface DroppedEntry {
  qbo_source: string
  amount: number
  reason: string
}

export interface Warning {
  code: string
  message: string
  fix_hint?: string
  affected_lines?: string[]
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
  dropped: DroppedEntry[]
  warnings: Warning[]
}

// ─── Classification rules ────────────────────────────────────────────────
// Keyword → 1120S deduction bucket (order matters — first match wins).
const DEDUCTION_RULES: Array<{ bucket: keyof Form1120S_Inputs; patterns: RegExp[]; rule: string }> = [
  { bucket: 'repairs_maintenance', rule: 'repairs',     patterns: [/^repairs? ?&? ?maintenance$/i, /^repairs$/i] },
  { bucket: 'rents',              rule: 'rent',         patterns: [/^rent$/i, /^rent expense$/i, /rent or lease/i] },
  { bucket: 'taxes_licenses',     rule: 'taxes',        patterns: [/payroll tax/i, /^other payroll/i, /^taxes? ?&? ?licenses?$/i, /^taxes$/i, /^state tax/i, /^business license/i, /^permits? (&|and) licenses?/i, /^licenses?$/i] },
  { bucket: 'advertising',        rule: 'advertising',  patterns: [/^advertising/i, /^marketing$/i, /^ppc/i, /lead gen/i, /^promotion/i, /^advertising ?&? ?promotion/i] },
  { bucket: 'interest',           rule: 'interest_exp', patterns: [/^interest paid/i, /interest expense/i, /mortgage interest/i, /loan interest/i] },
  { bucket: 'depreciation',       rule: 'depreciation', patterns: [/^depreciation/i] },
  { bucket: 'depletion',          rule: 'depletion',    patterns: [/^depletion/i] },
  { bucket: 'pension_plans',      rule: 'pension',      patterns: [/pension/i, /401\(?k\)?/i, /retirement plan/i] },
  { bucket: 'employee_benefits',  rule: 'emp_benefits', patterns: [/employee benefit/i, /health insurance/i] },
  { bucket: 'bad_debts',          rule: 'bad_debts',    patterns: [/^bad debts?/i] },
  { bucket: 'salaries_wages',     rule: 'salaries',     patterns: [/^salaries ?&? ?wages?$/i, /^wages?$/i, /^payroll( expenses?)?( \(direct\))?$/i, /contract labor/i, /^(sales )?commissions$/i] },
]

// OtherIncome leaves matching these patterns are PORTFOLIO income — they
// route to Schedule K for 1120S (passthrough to shareholders) or L4/L5 for
// 1120, NOT to ordinary trade/business income.
const PORTFOLIO_PATTERNS: Array<{ kind: 'interest' | 'dividend' | 'cap_gain' | 'royalty' | 'tax_exempt_interest'; patterns: RegExp[] }> = [
  { kind: 'interest',            patterns: [/^interest (earned|income)/i, /^interest$/i, /bank interest/i] },
  { kind: 'dividend',            patterns: [/^dividend(s)?( income)?$/i] },
  { kind: 'cap_gain',            patterns: [/^realized (gain|loss)/i, /^capital (gain|loss)/i, /sale of investments?/i, /investment (gain|loss)/i] },
  { kind: 'royalty',             patterns: [/^royalt(y|ies)/i] },
  { kind: 'tax_exempt_interest', patterns: [/tax[- ]?exempt interest/i, /municipal bond interest/i] },
]

// Income leaves that should NOT be in gross_receipts.
const REVENUE_EXCLUSIONS: Array<{ target: 'other_income'; patterns: RegExp[]; rule: string }> = [
  { target: 'other_income', rule: 'uncategorized_income', patterns: [/uncategorized income/i] },
]

// Expenses that belong elsewhere (e.g. charity → Schedule K line 12a).
const EXPENSE_RECLASS: Array<{ target: keyof Form1120S_Inputs; patterns: RegExp[]; rule: string }> = [
  { target: 'charitable_contrib', rule: 'charitable', patterns: [/contributions? to charit/i, /^charitable/i, /donations?$/i] },
]

// Names that look like contra-revenue regardless of sign — these flow to
// returns_allowances (L1b) rather than netting silently into gross_receipts.
const CONTRA_REVENUE_NAME = /^(refunds?|returns?|discounts?|allowances?|chargebacks?)|customer deposit|contingent refund/i

// ─── Helpers ─────────────────────────────────────────────────────────────

interface Leaf {
  name: string       // last segment of the path (e.g. "Business Insurance")
  path: string       // full QBO path ("Expenses > Insurance > Business Insurance")
  amount: number
  /** True for parent-section direct postings (QBO Header.ColData entries
   *  flattened into "{Section} (Direct)" by qbo.ts:flattenReport). */
  parent_direct?: boolean
}

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

function matchPortfolio(name: string): 'interest' | 'dividend' | 'cap_gain' | 'royalty' | 'tax_exempt_interest' | null {
  for (const p of PORTFOLIO_PATTERNS) {
    if (p.patterns.some(re => re.test(name))) return p.kind
  }
  return null
}

/** Walk EVERY real leaf under a parent prefix, at any depth. Skips section
 *  totals ("(Total)") and parent-direct postings ("(Direct)"). The previous
 *  implementation only handled depth-1 leaves, silently dropping nested QBO
 *  accounts (e.g. `Expenses > Insurance > Business Insurance`). */
function collectAllLeaves(pnl: Pnl, parentPrefix: string): Leaf[] {
  const prefix = parentPrefix.endsWith('>') ? parentPrefix : `${parentPrefix} >`
  const out: Leaf[] = []
  for (const [k, v] of Object.entries(pnl)) {
    if (typeof v !== 'number' || v === 0) continue
    if (!k.startsWith(prefix)) continue
    if (k.endsWith(' (Total)')) continue        // section sum — would double-count
    if (k.endsWith(' (Direct)')) continue       // parent direct posting — handled separately
    const path = k                              // full QBO path for audit
    const tail = k.slice(prefix.length).trim() // e.g. "Insurance > Business Insurance"
    const segments = tail.split(' > ').map(s => s.trim())
    const name = segments[segments.length - 1] // last segment for classification
    out.push({ name, path, amount: v })
  }
  return out
}

/** Walk every (Direct) marker under a parent prefix. These are amounts QBO
 *  posted at a section header rather than to a leaf (e.g. payroll JE at the
 *  parent "Payroll Expenses" account with -395K offset). Without picking
 *  these up we'd silently lose those entries. */
function collectDirectPostings(pnl: Pnl, parentPrefix: string): Leaf[] {
  const prefix = parentPrefix.endsWith('>') ? parentPrefix : `${parentPrefix} >`
  const out: Leaf[] = []
  for (const [k, v] of Object.entries(pnl)) {
    if (typeof v !== 'number' || v === 0) continue
    if (!k.startsWith(prefix)) continue
    if (!k.endsWith(' (Direct)')) continue
    const tail = k.slice(prefix.length, -' (Direct)'.length).trim()
    const segments = tail.split(' > ').map(s => s.trim())
    const name = segments[segments.length - 1]
    out.push({ name, path: k, amount: v, parent_direct: true })
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
  const dropped: DroppedEntry[] = []
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

  const warn = (code: string, message: string, fix_hint?: string, affected_lines?: string[]) => {
    warnings.push({ code, message, ...(fix_hint ? { fix_hint } : {}), ...(affected_lines ? { affected_lines } : {}) })
  }

  // ── Revenue ──
  // Treat parent-direct postings as leaves: Income (Total) already includes
  // them, so adding both would double-count. Combining them with the leaf
  // list lets a single decision (use leaves OR fallback to Total) keep the
  // accounting straight. The Direct entries still get a PARENT_DIRECT_POSTING
  // warning for preparer visibility.
  const incomeTotal      = totalOrZero(pnl, 'Income (Total)')
  const incomeLeaves     = collectAllLeaves(pnl, 'Income')
  const incomeDirects    = collectDirectPostings(pnl, 'Income')
  const incomeAllLeaves  = [...incomeLeaves, ...incomeDirects]
  const contraRevenue: Leaf[] = []
  const grossLeaves: Leaf[] = []
  for (const leaf of incomeAllLeaves) {
    const reclass = matchRevenueExclusion(leaf.name)
    if (reclass) {
      record(reclass.target, leaf.amount, leaf.path, `rule:${reclass.rule}`)
      continue
    }
    if (CONTRA_REVENUE_NAME.test(leaf.name) || leaf.amount < 0) {
      contraRevenue.push(leaf)
    } else {
      grossLeaves.push(leaf)
    }
  }
  if (grossLeaves.length) {
    for (const l of grossLeaves) {
      const conf = l.parent_direct ? `parent_direct:${l.name}` : 'rule:income_leaf'
      record('gross_receipts', l.amount, l.path, conf)
    }
  } else if (incomeTotal) {
    record('gross_receipts', incomeTotal, 'Income (Total)', 'aggregate:Income')
  }
  if (contraRevenue.length) {
    const contraSum = contraRevenue.reduce((s, l) => s + l.amount, 0)
    record('returns_allowances', Math.abs(contraSum), contraRevenue.map(l => l.path).join('; '), 'rule:contra_revenue')
    if (Math.abs(contraSum) > 10000) {
      warn(
        'LARGE_CONTRA_REVENUE',
        `Income section contains ${contraRevenue.length} contra-revenue leaf(s) totaling $${Math.round(Math.abs(contraSum)).toLocaleString()}: ${contraRevenue.map(l => `"${l.name}" ($${Math.round(l.amount).toLocaleString()})`).join(', ')}. Routed to L1b returns_allowances.`,
        'If these adjustments relate to a prior period, consider amending the prior-year return instead of recording against current-year revenue.',
        ['income.L1b_returns'],
      )
    }
    for (const l of contraRevenue) {
      if (/customer deposit|contingent/i.test(l.name)) {
        warn(
          'CONTINGENCY_IN_REVENUE',
          `"${l.name}" appears under Income at $${Math.round(l.amount).toLocaleString()}. Booked as L1b returns_allowances by default — this assumes the contingency was released to revenue.`,
          'If the deposit is still an unreleased liability, override returns_allowances and book as a liability on Schedule L instead.',
        )
      }
    }
  }
  for (const direct of incomeDirects) {
    warn(
      'PARENT_DIRECT_POSTING',
      `Income parent "${direct.name}" has direct postings of $${Math.round(direct.amount).toLocaleString()} not reflected in leaf accounts. Treated as a leaf under Income.`,
      'Reclassify in QBO to a leaf account, or override gross_receipts in inputs.',
      ['income.L1a_gross_receipts'],
    )
  }

  // ── Other income (non-portfolio OtherIncome) + portfolio routing ──
  // Cap gain is intentionally not auto-routed: QBO's "Sale of investments"
  // doesn't carry a holding period. The 1099-B auto-merge has authoritative
  // ST/LT split, so we record an audit-only entry and let that path win
  // (writing here too would dual-count after the auto-merge runs).
  for (const leaf of collectAllLeaves(pnl, 'OtherIncome')) {
    const portfolio = matchPortfolio(leaf.name)
    if (portfolio === 'cap_gain') {
      audit.push({
        tax_field: 'schedule_k_*_cap_gain',
        qbo_source: leaf.path,
        amount: Math.round(leaf.amount),
        confidence: 'skipped:cap_gain_holding_period_unknown_defer_to_1099b',
      })
      continue
    }
    if (portfolio) {
      if (form_type === '1120S') {
        const target =
          portfolio === 'interest'            ? 'schedule_k_interest' :
          portfolio === 'dividend'            ? 'schedule_k_dividends_ordinary' :
          portfolio === 'royalty'             ? 'schedule_k_royalties' :
          /* tax_exempt */                     'schedule_k_tax_exempt_interest'
        record(target, leaf.amount, leaf.path, `rule:portfolio_${portfolio}`)
      } else {
        const target =
          portfolio === 'interest'            ? 'interest_income' :
          portfolio === 'dividend'            ? 'dividends' :
          portfolio === 'royalty'             ? 'gross_royalties' :
          /* tax_exempt — 1120 has no separate slot; defer to other_income */ 'other_income'
        record(target, leaf.amount, leaf.path, `rule:portfolio_${portfolio}`)
      }
      continue
    }
    record('other_income', leaf.amount, leaf.path, 'rule:other_income_nonportfolio')
  }

  // ── COGS ──
  // Same Direct-as-leaf pattern as Income: COGS (Total) already includes
  // any Direct postings, so combining the lists prevents double-count.
  const cogsLeaves   = collectAllLeaves(pnl, 'COGS')
  const cogsDirects  = collectDirectPostings(pnl, 'COGS')
  const cogsAll      = [...cogsLeaves, ...cogsDirects]
  if (cogsAll.length) {
    for (const leaf of cogsAll) {
      const reclass = matchDeduction(leaf.name)
      const conf = leaf.parent_direct ? `parent_direct:${leaf.name}` : (reclass ? `rule:${reclass.rule}` : 'rule:cogs_leaf')
      const target = reclass ? reclass.bucket : 'cost_of_goods_sold'
      record(target, leaf.amount, leaf.path, conf)
    }
  } else {
    const cogsTotal = totalOrZero(pnl, 'COGS (Total)')
    if (cogsTotal) record('cost_of_goods_sold', cogsTotal, 'COGS (Total)', 'aggregate:COGS')
  }
  for (const direct of cogsDirects) {
    warn(
      'PARENT_DIRECT_POSTING',
      `COGS parent "${direct.name}" has direct postings of $${Math.round(direct.amount).toLocaleString()}.`,
      'Reclassify to a leaf account in QBO.',
      ['income.L2_cogs'],
    )
  }

  // ── Expenses + OtherExpenses (ordinary operating deductions) ──
  // Walks every leaf at any depth, classifies via DEDUCTION_RULES /
  // EXPENSE_RECLASS, falls through to other_deductions (L20 1120S / L26
  // 1120) for anything unmatched. Parent-direct postings are picked up
  // from "(Direct)" markers and emit PARENT_DIRECT_POSTING warnings.
  const unmatchedExpenses: Leaf[] = []
  const mealsLeaves: Leaf[] = []
  const uncategorizedExpenseLeaves: Leaf[] = []
  let payrollishDetected = false
  let expensesLeafTotal = 0
  for (const parent of ['Expenses', 'OtherExpenses']) {
    const allItems = [
      ...collectAllLeaves(pnl, parent),
      ...collectDirectPostings(pnl, parent),
    ]
    for (const leaf of allItems) {
      expensesLeafTotal += leaf.amount
      if (/meals|entertainment/i.test(leaf.name)) mealsLeaves.push(leaf)
      if (/uncategorized/i.test(leaf.name)) uncategorizedExpenseLeaves.push(leaf)
      if (/payroll|salar|wages|contract labor|commissions/i.test(leaf.name)) payrollishDetected = true

      const conf = leaf.parent_direct ? `parent_direct:${leaf.name}` : `rule`
      const sourcePath = leaf.path

      const reclass = matchReclass(leaf.name)
      if (reclass) {
        record(reclass.target, leaf.amount, sourcePath, leaf.parent_direct ? conf : `rule:${reclass.rule}`)
        if (leaf.parent_direct) emitParentDirectWarning(warn, parent, leaf, [reclass.target])
        continue
      }
      const specific = matchDeduction(leaf.name)
      if (specific) {
        record(specific.bucket, leaf.amount, sourcePath, leaf.parent_direct ? conf : `rule:${specific.rule}`)
        if (leaf.parent_direct) emitParentDirectWarning(warn, parent, leaf, [`deductions.${specific.bucket}`])
        continue
      }
      // Fallback — every unmatched expense lands on other_deductions (L20
      // on 1120S, L26 on 1120). Never silently dropped.
      unmatchedExpenses.push(leaf)
      record('other_deductions', leaf.amount, sourcePath, leaf.parent_direct ? conf : 'fallback:other_deductions')
      if (parent === 'OtherExpenses') {
        warn(
          'OTHER_EXPENSES_AS_ORDINARY',
          `"${leaf.path}" was on QBO's "Other Expenses" section (below Net Operating Income) — routed to L20 as ordinary. Confirm it is not a §162 capital item or below-the-line.`,
          'Override other_deductions or move the expense into the main Expenses section in QBO if it is operating.',
          ['deductions.other_deductions'],
        )
      }
      if (leaf.parent_direct) emitParentDirectWarning(warn, parent, leaf, ['deductions.other_deductions'])
    }
  }

  // Sanity check: leaves + directs should equal the parent-section totals.
  const expensesTotal = totalOrZero(pnl, 'Expenses (Total)') + totalOrZero(pnl, 'OtherExpenses (Total)')
  if (expensesTotal > 0) {
    const drift = Math.abs(expensesTotal - expensesLeafTotal)
    if (drift > Math.max(100, expensesTotal * 0.02)) {
      warn(
        'EXPENSE_TOTAL_MISMATCH',
        `Sum of Expense leaves+directs ($${Math.round(expensesLeafTotal).toLocaleString()}) differs from Expense totals ($${Math.round(expensesTotal).toLocaleString()}) by $${Math.round(drift).toLocaleString()}. Some postings may not be reaching the tax return.`,
        'Inspect the QBO P&L for accounts on a different basis or with manual JE adjustments.',
      )
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
  if (form_type === '1120') {
    if (inputs.interest !== undefined) {
      inputs.interest_expense = inputs.interest
      delete inputs.interest
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

  if ((inputs.salaries_wages || payrollishDetected) && !inputs.officer_compensation) {
    const sw = (inputs.salaries_wages as number) || 0
    warn(
      'OFFICER_COMP_SPLIT_NEEDED',
      `Payroll-type expenses detected${sw ? ` (salaries_wages = $${sw.toLocaleString()})` : ''} but no officer_compensation provided. QBO does not separate officer compensation from other salaries; 1120/1120S splits them (officer → L7 on 1120S / L12 on 1120, rest → L8 / L13). Currently $0 on the officer line.`,
      `Override officer_compensation in inputs using the officer's W-2 Box 1 (reasonable salary standard for shareholder-employees).`,
      form_type === '1120S'
        ? ['deductions.L7_officer_comp', 'deductions.L8_salaries']
        : ['deductions.L12_officer_comp', 'deductions.L13_salaries'],
    )
  }

  if (unmatchedExpenses.length) {
    const total = unmatchedExpenses.reduce((s, l) => s + l.amount, 0)
    const preview = [...unmatchedExpenses]
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 10)
      .map(l => `${l.path} ($${Math.round(l.amount).toLocaleString()})`)
      .join('; ')
    warn(
      'UNMATCHED_EXPENSE_LINES',
      `${unmatchedExpenses.length} QBO expense account(s) totaling $${Math.round(total).toLocaleString()} had no matching IRS-line rule and fell through to other_deductions (${form_type === '1120S' ? 'L20' : 'L26'}). Top by amount: ${preview}${unmatchedExpenses.length > 10 ? '; …' : ''}.`,
      'Review the list and override the right field in inputs (e.g. salaries_wages, taxes_licenses) if a stricter classification is appropriate.',
      ['deductions.other_deductions'],
    )
  }

  if (mealsLeaves.length) {
    const total = mealsLeaves.reduce((s, l) => s + l.amount, 0)
    warn(
      'MEALS_NEEDS_DISALLOWANCE',
      `Meals/entertainment totaling $${Math.round(total).toLocaleString()} is in other_deductions at 100%. §274(n) limits the business-meal deduction to 50% (and disallows entertainment entirely).`,
      `Reduce other_deductions by 50% of meals and 100% of entertainment, or pass a meals_50pct override if/when the engine adds that bucket.`,
      ['deductions.other_deductions'],
    )
  }

  if (uncategorizedExpenseLeaves.length) {
    const total = uncategorizedExpenseLeaves.reduce((s, l) => s + l.amount, 0)
    warn(
      'UNCATEGORIZED_ACCOUNT',
      `QBO contains Uncategorized Expense leaf(s) totaling $${Math.round(total).toLocaleString()}. These are placeholder accounts and should be reclassified before filing.`,
      'Reclassify the underlying transactions in QBO so they land on the correct IRS line.',
      ['deductions.other_deductions'],
    )
  }
  // Income side too — Bug 5 wanted Uncategorized Income flagged.
  const uncategorizedIncomeLeaves = incomeLeaves.filter(l => /uncategorized/i.test(l.name))
  if (uncategorizedIncomeLeaves.length) {
    const total = uncategorizedIncomeLeaves.reduce((s, l) => s + l.amount, 0)
    warn(
      'UNCATEGORIZED_ACCOUNT',
      `QBO contains Uncategorized Income leaf(s) totaling $${Math.round(total).toLocaleString()}. Placeholder account — review transactions before filing.`,
      'Reclassify in QBO so the income lands on the correct revenue account.',
      ['income.L1a_gross_receipts'],
    )
  }

  return { inputs, audit, dropped, warnings }
}

/** Emit a PARENT_DIRECT_POSTING warning for a (Direct) marker. Hoisted out
 *  of the loop so the body stays scannable. */
function emitParentDirectWarning(
  warn: (code: string, message: string, fix_hint?: string, affected_lines?: string[]) => void,
  parent: string,
  leaf: Leaf,
  affected_lines: string[],
) {
  warn(
    'PARENT_DIRECT_POSTING',
    `${parent} parent "${leaf.name}" has direct postings of $${Math.round(leaf.amount).toLocaleString()} not reflected in any leaf account.`,
    'These are JE-level postings at the parent. Either reclassify in QBO to a leaf account or override the affected input field manually.',
    affected_lines,
  )
}

// ─── Back-compat wrappers ────────────────────────────────────────────────

export function build1120SInputsFromQbo(pnl: Pnl): Partial<Form1120S_Inputs> {
  return buildCorporateInputsFromQbo({ pnl, form_type: '1120S' }).inputs as Partial<Form1120S_Inputs>
}

export function build1120InputsFromQbo(pnl: Pnl): Partial<Form1120_Inputs> {
  return buildCorporateInputsFromQbo({ pnl, form_type: '1120' }).inputs as Partial<Form1120_Inputs>
}
