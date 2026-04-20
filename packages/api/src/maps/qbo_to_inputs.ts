/**
 * Map QBO P&L flat summary → 1120S / 1120 input fields
 *
 * Called from /api/returns/compute when an entity has a QBO connection and
 * the caller hasn't provided explicit inputs. Produces a proforma close to
 * what a preparer would file from the same books.
 *
 * Strategy (robust to missing sub-items in QBO's flattened summary):
 * 1. Revenue side: start from `Income (Total)` and subtract known
 *    non-gross-receipts items (Uncategorized Income → other_income,
 *    schedule K items that QBO puts under OtherIncome → schedule_k_*).
 * 2. COGS side: start from `COGS (Total)` and subtract any leaf items we
 *    want to reclassify (charitable, interest expense). Net goes to
 *    cost_of_goods_sold.
 * 3. Expenses side: walk leaf items under Expenses/OtherExpenses, route
 *    each to its specific deduction bucket; anything unmatched falls into
 *    other_deductions.
 * 4. OtherIncome → schedule K portfolio items (1120S) or interest_income /
 *    dividends / capital_gains (1120).
 *
 * Caller can override any field by passing it in `inputs`.
 */
import type { Form1120S_Inputs, Form1120_Inputs } from '../engine/tax_engine.js'

type Pnl = Record<string, number>

// ─── Classification rules ────────────────────────────────────────────────
// Keyword → 1120S deduction bucket (order matters — first match wins).
const DEDUCTION_RULES: Array<{ bucket: keyof Form1120S_Inputs; patterns: RegExp[] }> = [
  { bucket: 'repairs_maintenance', patterns: [/^repairs? ?&? ?maintenance$/i, /^repairs$/i] },
  { bucket: 'rents',              patterns: [/^rent$/i, /^rent expense$/i, /rent or lease/i] },
  { bucket: 'taxes_licenses',     patterns: [/payroll tax/i, /^taxes? & licenses?$/i, /^taxes$/i, /^state tax/i, /^business license/i] },
  { bucket: 'advertising',        patterns: [/^advertising/i, /^marketing$/i, /^ppc/i] },
  { bucket: 'interest',           patterns: [/^interest paid/i, /interest expense/i, /mortgage interest/i, /loan interest/i] },
  { bucket: 'depreciation',       patterns: [/^depreciation/i] },
  { bucket: 'depletion',          patterns: [/^depletion/i] },
  { bucket: 'pension_plans',      patterns: [/pension/i, /401\(?k\)?/i, /retirement plan/i] },
  { bucket: 'employee_benefits',  patterns: [/employee benefit/i] },
  { bucket: 'bad_debts',          patterns: [/^bad debts?/i] },
  { bucket: 'salaries_wages',     patterns: [/^salaries ?& ?wages?$/i, /^wages?$/i] },
  // officer_compensation is intentionally not matched — QBO typically lumps
  // it into Salaries. The preparer decides the officer/non-officer split,
  // so we leave it for the caller to override.
]

// OtherIncome leaves → Schedule K (1120S)
const SCHED_K_RULES: Array<{ bucket: keyof Form1120S_Inputs; patterns: RegExp[] }> = [
  { bucket: 'schedule_k_interest',             patterns: [/^interest (earned|income)/i] },
  { bucket: 'schedule_k_dividends_ordinary',   patterns: [/^dividend income/i, /^dividends$/i] },
  { bucket: 'schedule_k_royalties',            patterns: [/^royalt(y|ies)/i] },
  { bucket: 'schedule_k_st_cap_gain',          patterns: [/sale of investments/i, /^realized gain/i, /^capital gain.*short/i] },
  { bucket: 'schedule_k_lt_cap_gain',          patterns: [/^capital gain.*long/i, /^long.?term capital/i] },
  { bucket: 'schedule_k_tax_exempt_interest',  patterns: [/tax[- ]?exempt interest/i] },
]

// Income leaves that should NOT be in gross_receipts
const REVENUE_EXCLUSIONS: Array<{ target: 'other_income' | null; patterns: RegExp[] }> = [
  { target: 'other_income', patterns: [/uncategorized income/i] },
  // Customer deposits that are released (showing on Income side) IS
  // gross_receipts — contingency releases flow through normal revenue.
  // If a preparer wants to segregate they can override.
]

// Ask-My-Accountant style junk that's often on Expenses but belongs elsewhere.
const EXPENSE_RECLASS: Array<{ target: keyof Form1120S_Inputs; patterns: RegExp[] }> = [
  { target: 'charitable_contrib', patterns: [/contributions? to charit/i, /^charitable/i, /donations?$/i] },
]

// ─── Helpers ─────────────────────────────────────────────────────────────

function matchRule(name: string, rules: Array<{ bucket?: string; target?: string; patterns: RegExp[] }>): string | null {
  for (const r of rules) {
    if (r.patterns.some(p => p.test(name))) return (r.bucket || r.target) as string
  }
  return null
}

/** Collect leaf items under a parent prefix. Returns [{leafName, amount}] */
function collectLeaves(pnl: Pnl, parentPrefix: string): Array<{ name: string; amount: number }> {
  const prefix = parentPrefix.endsWith('>') ? parentPrefix : `${parentPrefix} >`
  const out: Array<{ name: string; amount: number }> = []
  for (const [k, v] of Object.entries(pnl)) {
    if (typeof v !== 'number' || v === 0) continue
    if (!k.startsWith(prefix)) continue
    const leaf = k.slice(prefix.length).trim()
    // Skip nested breadcrumbs — only immediate leaves
    if (leaf.includes(' > ')) continue
    out.push({ name: leaf, amount: v })
  }
  return out
}

function totalOrZero(pnl: Pnl, key: string): number {
  const v = pnl[key]
  return typeof v === 'number' ? v : 0
}

// ─── 1120S mapper ────────────────────────────────────────────────────────

export function build1120SInputsFromQbo(pnl: Pnl): Partial<Form1120S_Inputs> {
  const out: Partial<Form1120S_Inputs> = {}
  const bump = (field: keyof Form1120S_Inputs, amt: number) => {
    const cur = (out[field] as number) || 0
    ;(out as any)[field] = Math.round(cur + amt)
  }

  // ── Revenue ──
  // Start with Income (Total) — most reliable since QBO's own rollup.
  const incomeTotal = totalOrZero(pnl, 'Income (Total)')
  let otherIncome = 0
  let grossReceipts = incomeTotal
  for (const leaf of collectLeaves(pnl, 'Income')) {
    const reclass = matchRule(leaf.name, REVENUE_EXCLUSIONS as any)
    if (reclass === 'other_income') {
      otherIncome += leaf.amount
      grossReceipts -= leaf.amount
    }
  }
  if (grossReceipts)  out.gross_receipts = Math.round(grossReceipts)
  if (otherIncome)    out.other_income   = Math.round(otherIncome)

  // ── Other income ──
  // Schedule K portfolio items (interest, dividends, capital gains) are NOT
  // pulled from QBO — they come from 1099 facts via the auto-merge block
  // in /api/returns/compute. QBO's "Interest earned" / "Dividend Income" /
  // "Sale of investments" ledger accounts mirror the same 1099 data
  // (they're booked from the 1099s), so pulling both would double-count.
  // Non-portfolio OtherIncome leaves still flow to L5 other_income.
  for (const leaf of collectLeaves(pnl, 'OtherIncome')) {
    const isPortfolio = matchRule(leaf.name, SCHED_K_RULES as any)
    if (!isPortfolio) {
      otherIncome += leaf.amount
      out.other_income = Math.round(otherIncome)
    }
  }

  // ── COGS ──
  // Use the leaves so anything that should be reclassified (rare — mostly
  // all of COGS is legit) can be pulled out. If no leaves, use the total.
  const cogsLeaves = collectLeaves(pnl, 'COGS')
  if (cogsLeaves.length) {
    let cogs = 0
    for (const { name, amount } of cogsLeaves) {
      const reclass = matchRule(name, DEDUCTION_RULES as any)
      if (reclass) {
        bump(reclass as keyof Form1120S_Inputs, amount)
      } else {
        cogs += amount
      }
    }
    if (cogs) out.cost_of_goods_sold = Math.round(cogs)
  } else {
    const cogsTotal = totalOrZero(pnl, 'COGS (Total)')
    if (cogsTotal) out.cost_of_goods_sold = Math.round(cogsTotal)
  }

  // ── Expenses (ordinary operating deductions) ──
  for (const parent of ['Expenses', 'OtherExpenses']) {
    for (const { name, amount } of collectLeaves(pnl, parent)) {
      // First check reclassifications (e.g. charity goes to K-1 not L20)
      const reclass = matchRule(name, EXPENSE_RECLASS as any)
      if (reclass) { bump(reclass as keyof Form1120S_Inputs, amount); continue }
      // Then specific deduction line
      const specific = matchRule(name, DEDUCTION_RULES as any)
      if (specific) { bump(specific as keyof Form1120S_Inputs, amount); continue }
      // Fall through: other_deductions (L20)
      bump('other_deductions', amount)
    }
  }

  return out
}

// ─── 1120 mapper ─────────────────────────────────────────────────────────

export function build1120InputsFromQbo(pnl: Pnl): Partial<Form1120_Inputs> {
  // Build the 1120S version first, then translate field names that differ.
  const s = build1120SInputsFromQbo(pnl)
  const out: Partial<Form1120_Inputs> = {}

  const shared = ['gross_receipts','returns_allowances','cost_of_goods_sold',
    'other_income','officer_compensation','salaries_wages','repairs_maintenance',
    'bad_debts','rents','taxes_licenses','depreciation','depletion','advertising',
    'pension_plans','employee_benefits','other_deductions','charitable_contrib'] as const
  for (const k of shared) if (k in s) (out as any)[k] = (s as any)[k]

  // 1120S schedule_k_* → 1120 line items
  if (s.schedule_k_interest)           out.interest_income = s.schedule_k_interest
  if (s.schedule_k_dividends_ordinary) out.dividends       = s.schedule_k_dividends_ordinary
  if (s.schedule_k_st_cap_gain || s.schedule_k_lt_cap_gain) {
    out.capital_gains = (s.schedule_k_st_cap_gain || 0) + (s.schedule_k_lt_cap_gain || 0)
  }
  if (s.schedule_k_royalties) out.gross_royalties = s.schedule_k_royalties
  if (s.interest) out.interest_expense = s.interest

  return out
}
