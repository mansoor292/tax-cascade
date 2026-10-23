/**
 * Schedules M-1 and M-2 must follow the income statement, not be restated
 * alongside it.
 *
 * Both schedules were pure pass-through: whatever the caller sent was stored,
 * and nothing re-derived them when the numbers above changed. A return was
 * recomputed with a different taxes-and-licenses figure and a new other-income
 * line, which moved ordinary business income by $33,450 — and M-1 line 8 and
 * M-2 line 2 both kept the previous figure, because the caller had supplied
 * them explicitly on an earlier pass and nothing invalidated that. The ending
 * AAA, and therefore the number a shareholder's basis is computed from, was
 * built on income the return no longer reported.
 *
 * Several of those lines are not judgements at all, they are arithmetic the
 * form prints instructions for: "Add lines 1 through 3", "Combine lines 1
 * through 5", "Subtract line 7 from line 6", and M-2 line 2 is page 1 line 22
 * by definition. Those are derived here and cannot go stale. The rest —
 * opening AAA, the reconciling items, book income — are facts only the
 * caller knows, and are left exactly as given.
 *
 * 2026-10-16 (blind test against the filed 2025 returns): M-2 lines 3, 5 and
 * 7 turned out to be Schedule K too, and the C corporation's M-1/M-2, Form
 * 1125-A and Form 4562 had the same "add lines" arithmetic left to the
 * caller. All of it is derived below; a stated figure the arithmetic
 * contradicts is reported, never silently replaced.
 */

import { SECTION_179_LIMITS } from '../engine/tax_tables.js'

export interface ReconciliationIssue {
  field: string
  expected: number
  found: number
  delta: number
  note: string
}

const n = (fv: Record<string, any>, k: string): number => {
  const v = fv[k]
  return typeof v === 'number' && isFinite(v) ? v : 0
}

/**
 * Fill the derived lines of Schedules M-1 and M-2 from the figures already on
 * the return. Mutates `fv`. Returns anything that still does not tie.
 *
 * Only runs for a schedule the caller actually populated — a return with no
 * M-2 does not acquire an empty one.
 */
export function deriveReconciliation1120S(
  fv: Record<string, any>,
  ordinaryIncome: number,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  const has = (prefix: string) => Object.keys(fv).some(k => k.startsWith(prefix))

  if (has('schedM1.')) {
    // Line 4 = lines 1 + 2 + 3; line 7 = lines 5 + 6; line 8 = line 4 - line 7.
    const l4 = n(fv, 'schedM1.L1_net_income_books') + n(fv, 'schedM1.L2_income_on_K') + n(fv, 'schedM1.L3_expenses_not_K')
    const l7 = n(fv, 'schedM1.L5_income_not_K') + n(fv, 'schedM1.L6_ded_on_K')
    fv['schedM1.L4_add'] = Math.round(l4)
    fv['schedM1.L7_add_5_6'] = Math.round(l7)
    fv['schedM1.L8_income_K18'] = Math.round(l4 - l7)

    // Line 8 is labelled "Income (loss) (Schedule K, line 18)". If the
    // reconciling items do not land there, the items are wrong — say so rather
    // than forcing the number, which would hide the discrepancy.
    const k18 = n(fv, 'schedK.L18_income_loss')
    const delta = Math.round(l4 - l7) - k18
    if (k18 !== 0 && Math.abs(delta) > 1) {
      issues.push({
        field: 'schedM1.L8_income_K18',
        expected: k18,
        found: Math.round(l4 - l7),
        delta,
        note: 'Schedule M-1 line 8 must equal Schedule K line 18. The reconciling '
            + 'items on M-1 lines 2, 3, 5 and 6 do not bridge book income to the '
            + 'total on Schedule K.',
      })
    }
  }

  if (has('schedM2.')) {
    // Ordinary income goes on line 2, a loss on line 4 — never both.
    const income = ordinaryIncome > 0 ? Math.round(ordinaryIncome) : 0
    const loss = ordinaryIncome < 0 ? Math.round(-ordinaryIncome) : 0
    fv['schedM2.L2_ordinary_income'] = income
    fv['schedM2.L4_loss'] = loss

    // Lines 3, 5 and 7 are Schedule K, not judgement (Reg. §1.1368-2(a)):
    // the AAA goes up by the separately stated income items, down by the
    // separately stated deductions and losses and the nondeductible
    // expenses, and out by the distributions. They were left to the caller,
    // and a return that gave none printed an ending AAA of $1,163,353 where
    // the filed return said $283,179 — every dollar distributed still
    // counted as available to distribute tax-free. A stated line is kept and
    // checked against Schedule K; an absent one is derived from it.
    const aaa = aaaFromScheduleK(fv)
    // With no Schedule K on the return there is nothing to check against —
    // absent is not zero.
    const hasK = has('schedK.')
    const stateOrDerive = (key: string, derived: number, what: string) => {
      if (!(key in fv) || fv[key] === null || fv[key] === undefined || fv[key] === '') {
        fv[key] = derived
        return
      }
      if (!hasK) return
      const found = n(fv, key)
      if (Math.abs(found - derived) > 1) {
        issues.push({ field: key, expected: derived, found, delta: found - derived,
          note: `Schedule M-2 ${what} does not match Schedule K. The AAA moves by exactly the Schedule K items (Reg. §1.1368-2(a)); a difference means one of the two is wrong.` })
      }
    }
    stateOrDerive('schedM2.L3_other_additions', aaa.additions, 'line 3 (other additions)')
    stateOrDerive('schedM2.L5_other_reductions', aaa.reductions, 'line 5 (other reductions)')

    const l6 = n(fv, 'schedM2.L1_beg_balance') + income + n(fv, 'schedM2.L3_other_additions')
             - loss - n(fv, 'schedM2.L5_other_reductions')
    fv['schedM2.L6_combine'] = Math.round(l6)

    // Distributions cannot take the AAA below zero (Reg. §1.1368-2(a)(3)(iii));
    // anything beyond it comes out of other accounts or basis, not column (a).
    const distributed = aaa.distributions
    const fromAaa = Math.max(0, Math.min(distributed, Math.round(l6)))
    stateOrDerive('schedM2.L7_distributions', fromAaa, 'line 7 (distributions)')
    if (hasK && distributed > fromAaa && !issues.some(i => i.field === 'schedM2.L7_distributions')) {
      issues.push({ field: 'schedM2.L7_distributions', expected: distributed, found: fromAaa, delta: fromAaa - distributed,
        note: 'Distributions exceed the accumulated adjustments account. Column (a) takes only what the AAA holds; the excess is sourced from previously taxed income, earnings and profits, or the shareholder\'s basis.' })
    }
    fv['schedM2.L8_end_balance'] = Math.round(l6 - n(fv, 'schedM2.L7_distributions'))
  }

  return issues
}

/**
 * A Schedule K line as the return holds it. Each line has two spellings —
 * the one the PDF map uses and the one the engine emits — and either may be
 * the populated one (see SCHEDULE_TWINS in build_return_pdf).
 */
const k = (fv: Record<string, any>, ...keys: string[]): number => {
  for (const key of keys) { const v = n(fv, key); if (v !== 0) return v }
  return 0
}

/** Schedule K lines that are separately stated income items (positive) or losses (negative). */
const K_INCOME: Array<[label: string, keys: string[]]> = [
  ['Net rental real estate income', ['schedK.L2_rental_re']],
  ['Other net rental income', ['schedK.L3c_net_rental']],
  ['Interest income', ['schedK.L4_interest']],
  ['Ordinary dividends', ['schedK.L5a_dividends', 'schedK.L5a_ordinary_dividends']],
  ['Royalties', ['schedK.L6_royalties']],
  ['Net short-term capital gain', ['schedK.L7_st_gain', 'schedK.L7_st_capital_gain']],
  ['Net long-term capital gain', ['schedK.L8a_lt_gain', 'schedK.L8a_lt_capital_gain']],
  ['Net section 1231 gain', ['schedK.L9_1231']],
  ['Other income', ['schedK.L10_other_amount', 'schedK.L10_other_income']],
]
/** Separately stated deductions, and the nondeductible expenses that also reduce the AAA. */
const K_REDUCTIONS: Array<[label: string, keys: string[]]> = [
  ['Section 179 deduction', ['schedK.L11_179', 'schedK.L11_section_179']],
  ['Cash contributions', ['schedK.L12a_cash_charity', 'schedK.L12a_charitable']],
  ['Noncash contributions', ['schedK.L12b_noncash_charity']],
  ['Investment interest expense', ['schedK.L12c_invest_interest']],
  ['Nondeductible expenses', ['schedK.L16c_nondeductible']],
  ['Foreign taxes paid or accrued', ['schedK.L16f_foreign_taxes']],
]

/**
 * The Schedule K side of the AAA: line 3 additions, line 5 reductions (with
 * the item behind each, for the line 3 statement), and the distributions.
 */
export function aaaFromScheduleK(fv: Record<string, any>): {
  additions: number; reductions: number; distributions: number
  additionItems: Array<{ label: string; amount: number }>
} {
  const additionItems: Array<{ label: string; amount: number }> = []
  let reductions = 0
  for (const [label, keys] of K_INCOME) {
    const v = Math.round(k(fv, ...keys))
    if (v > 0) additionItems.push({ label, amount: v })
    else if (v < 0) reductions += -v
  }
  for (const [, keys] of K_REDUCTIONS) reductions += Math.abs(Math.round(k(fv, ...keys)))
  return {
    additions: additionItems.reduce((t, i) => t + i.amount, 0),
    reductions,
    distributions: Math.round(k(fv, 'schedK.L16d_distributions')),
    additionItems,
  }
}


const present = (fv: Record<string, any>, key: string): boolean =>
  key in fv && fv[key] !== null && fv[key] !== undefined && fv[key] !== ''

const itemsTotal = (v: unknown): number =>
  Array.isArray(v) ? v.reduce((t, r) => t + (typeof r?.amount === 'number' && isFinite(r.amount) ? r.amount : 0), 0) : 0

/**
 * A total line made of sub-lines and itemized rows: stated wins, otherwise
 * the sum. A stated total its own components contradict is reported.
 */
function totalOf(
  fv: Record<string, any>, issues: ReconciliationIssue[], key: string,
  parts: string[], items: number, what: string,
): void {
  const anyPart = parts.some(p => present(fv, p)) || items !== 0
  const derived = Math.round(parts.reduce((t, p) => t + n(fv, p), 0) + items)
  if (!present(fv, key)) {
    if (anyPart) fv[key] = derived
    return
  }
  if (anyPart && Math.abs(n(fv, key) - derived) > 1) {
    issues.push({ field: key, expected: derived, found: n(fv, key), delta: n(fv, key) - derived,
      note: `${what} does not equal the lines and items it totals.` })
  }
}

/**
 * Form 1125-A lines 6 and 8 — "Add lines 1 through 5", "Subtract line 7 from
 * line 6". Both printed blank unless typed in. Line 8 is page 1 line 2 by
 * definition, so a disagreement with it is reported.
 */
export function deriveCogs(fv: Record<string, any>): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  const lines = ['cogs.L1_inventory_boy', 'cogs.L2_purchases', 'cogs.L3_labor', 'cogs.L4_additional_263a', 'cogs.L5_other']
  if (!lines.some(l => present(fv, l))) return issues
  const l6 = Math.round(lines.reduce((t, l) => t + n(fv, l), 0))
  fv['cogs.L6_total'] = l6
  fv['cogs.L8_cogs'] = Math.round(l6 - n(fv, 'cogs.L7_inventory_eoy'))
  const page1 = n(fv, 'income.L2_cogs')
  if (present(fv, 'income.L2_cogs') && Math.abs(fv['cogs.L8_cogs'] - page1) > 1) {
    issues.push({ field: 'cogs.L8_cogs', expected: Math.round(page1), found: fv['cogs.L8_cogs'], delta: fv['cogs.L8_cogs'] - Math.round(page1),
      note: 'Form 1125-A line 8 must equal page 1 line 2 (cost of goods sold). The lines of Form 1125-A do not add up to the figure the return deducts.' })
  }
  return issues
}

/**
 * Form 1120 Schedules M-1 and M-2. Line 6/9/10 of M-1 and lines 4/7/8 of M-2
 * are pure arithmetic and always derived; the itemized totals (M-1 lines 4,
 * 5, 7, 8; M-2 lines 3, 6) are summed from their sub-lines and items when not
 * stated; M-2 line 2 is M-1 line 1 (net income per books). M-1 line 10 must
 * be page 1 line 28 — if the reconciling items do not land there, that is
 * reported rather than forced.
 *
 * `inputs` carries the itemized rows (schedM1_L5_items etc.), which are not
 * line values and so never reach field_values.
 */
export function deriveReconciliation1120(
  fv: Record<string, any>,
  inputs: Record<string, any>,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  const has = (prefix: string) => Object.keys(fv).some(k => k.startsWith(prefix))

  if (has('schedM1.')) {
    totalOf(fv, issues, 'schedM1.L4_income_not_recorded', [], itemsTotal(inputs.schedM1_L4_items), 'Schedule M-1 line 4')
    totalOf(fv, issues, 'schedM1.L5_expenses_not_ded',
      ['schedM1.L5a_depreciation', 'schedM1.L5b_charitable', 'schedM1.L5c_travel_ent'],
      itemsTotal(inputs.schedM1_L5_items), 'Schedule M-1 line 5')
    totalOf(fv, issues, 'schedM1.L7_income_not_included', ['schedM1.L7a_tax_exempt_interest'],
      itemsTotal(inputs.schedM1_L7_items), 'Schedule M-1 line 7')
    totalOf(fv, issues, 'schedM1.L8_ded_not_charged', ['schedM1.L8a_depreciation', 'schedM1.L8b_charitable'],
      itemsTotal(inputs.schedM1_L8_items), 'Schedule M-1 line 8')

    const l6 = n(fv, 'schedM1.L1_net_income_books') + n(fv, 'schedM1.L2_fed_tax_books')
      + n(fv, 'schedM1.L3_excess_cap_losses') + n(fv, 'schedM1.L4_income_not_recorded')
      + n(fv, 'schedM1.L5_expenses_not_ded')
    const l9 = n(fv, 'schedM1.L7_income_not_included') + n(fv, 'schedM1.L8_ded_not_charged')
    fv['schedM1.L6_add_1_thru_5'] = Math.round(l6)
    fv['schedM1.L9_add_7_8'] = Math.round(l9)
    fv['schedM1.L10_income_line28'] = Math.round(l6 - l9)

    if (present(fv, 'tax.L28_ti_before_nol')) {
      const l28 = Math.round(n(fv, 'tax.L28_ti_before_nol'))
      const delta = fv['schedM1.L10_income_line28'] - l28
      if (Math.abs(delta) > 1) {
        issues.push({ field: 'schedM1.L10_income_line28', expected: l28, found: fv['schedM1.L10_income_line28'], delta,
          note: 'Schedule M-1 line 10 must equal page 1 line 28. The reconciling items on lines 2 through 8 do not bridge book income to taxable income.' })
      }
    }
  }

  if (has('schedM2.')) {
    // Line 2 is net income per books — the same figure as M-1 line 1.
    if (present(fv, 'schedM1.L1_net_income_books')) {
      const books = Math.round(n(fv, 'schedM1.L1_net_income_books'))
      if (!present(fv, 'schedM2.L2_net_income')) fv['schedM2.L2_net_income'] = books
      else if (Math.abs(n(fv, 'schedM2.L2_net_income') - books) > 1) {
        issues.push({ field: 'schedM2.L2_net_income', expected: books, found: n(fv, 'schedM2.L2_net_income'),
          delta: n(fv, 'schedM2.L2_net_income') - books,
          note: 'Schedule M-2 line 2 and Schedule M-1 line 1 are both net income per books and must agree.' })
      }
    }
    totalOf(fv, issues, 'schedM2.L3_other_increases', [], itemsTotal(inputs.schedM2_L3_items), 'Schedule M-2 line 3')
    totalOf(fv, issues, 'schedM2.L6_other_decreases', [],
      itemsTotal(inputs.schedM2_L6_items) || itemsTotal(inputs.schedM2_other_decreases_detail), 'Schedule M-2 line 6')

    const l4 = n(fv, 'schedM2.L1_beg_balance') + n(fv, 'schedM2.L2_net_income') + n(fv, 'schedM2.L3_other_increases')
    const l7 = n(fv, 'schedM2.L5a_cash_distributions') + n(fv, 'schedM2.L5b_stock_distributions')
      + n(fv, 'schedM2.L5c_property_distributions') + n(fv, 'schedM2.L6_other_decreases')
    fv['schedM2.L4_add'] = Math.round(l4)
    fv['schedM2.L7_add_5_6'] = Math.round(l7)
    fv['schedM2.L8_end_balance'] = Math.round(l4 - l7)

    // Line 8 is the unappropriated retained earnings Schedule L line 25
    // reports at year end.
    if (present(fv, 'schedL.L25_retained_eoy_d')) {
      const re = Math.round(n(fv, 'schedL.L25_retained_eoy_d'))
      const delta = fv['schedM2.L8_end_balance'] - re
      if (Math.abs(delta) > 1) {
        issues.push({ field: 'schedM2.L8_end_balance', expected: re, found: fv['schedM2.L8_end_balance'], delta,
          note: 'Schedule M-2 line 8 must equal Schedule L line 25, column (d). The year\'s increases and decreases do not carry opening retained earnings to the balance sheet figure.' })
      }
    }
  }

  return issues
}

/**
 * Form 4562's computed lines: Part I's limits (1, 3, 4, 5), line 22 (total
 * depreciation) and line 44 (total amortization). Runs only for a return
 * that carries a 4562 (any dep. line). Line 22 is what page 1 deducts, less
 * what went into cost of goods sold, so a mismatch with page 1 is reported.
 */
export function derive4562(
  fv: Record<string, any>,
  inputs: Record<string, any>,
  taxYear: number,
  page1DepreciationKey: string,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  if (!Object.keys(fv).some(k => k.startsWith('dep.'))) return issues

  const lim = SECTION_179_LIMITS[taxYear]
  if (lim) {
    if (!present(fv, 'dep.L1_179_limit')) fv['dep.L1_179_limit'] = lim.limit
    if (!present(fv, 'dep.L3_threshold')) fv['dep.L3_threshold'] = lim.threshold
  }
  if (present(fv, 'dep.L1_179_limit')) {
    const reduction = Math.max(0, n(fv, 'dep.L2_179_cost') - n(fv, 'dep.L3_threshold'))
    if (reduction > 0) fv['dep.L4_179_reduction'] = Math.round(reduction)
    fv['dep.L5_179_dollar_limit'] = Math.round(Math.max(0, n(fv, 'dep.L1_179_limit') - reduction))
  }

  // Line 22: lines 12, 14 through 17, line 19 and 20 column (g), and 21.
  const rows19 = Array.isArray(inputs.macrs_19_detail) ? inputs.macrs_19_detail : []
  const rows20 = Array.isArray(inputs.ads_20_detail) ? inputs.ads_20_detail : []
  const colG = [...rows19, ...rows20].reduce((t: number, r: any) => t + (Number(r?.deduction) || 0), 0)
  const l22parts = ['dep.L12_179_expense', 'dep.L14_special_allowance', 'dep.L15_168f1', 'dep.L16_other',
    'dep.L17_macrs_prior', 'dep.L21_listed']
  if (l22parts.some(p => present(fv, p)) || colG) {
    fv['dep.L22_total'] = Math.round(l22parts.reduce((t, p) => t + n(fv, p), 0) + colG)
    const page1 = n(fv, page1DepreciationKey)
    const inCogs = n(fv, 'dep.L23_263a')
    if (present(fv, page1DepreciationKey) && Math.abs(fv['dep.L22_total'] - inCogs - page1) > 1) {
      issues.push({ field: 'dep.L22_total', expected: Math.round(page1 + inCogs), found: fv['dep.L22_total'],
        delta: fv['dep.L22_total'] - Math.round(page1 + inCogs),
        note: 'Form 4562 line 22 does not match the depreciation the return deducts. Line 22 goes on page 1, less any part capitalized into cost of goods sold.' })
    }
  }

  // Line 44: line 42 column (f) plus line 43.
  if (present(fv, 'dep.L42_amortization') || present(fv, 'dep.L43_amortization')) {
    fv['dep.L44_total_amort'] = Math.round(n(fv, 'dep.L42_amortization') + n(fv, 'dep.L43_amortization'))
  }
  return issues
}

/**
 * Every derivation above, in order, for one return — the single entry point
 * compute_return uses (and the blind parity test calls, so the test runs
 * exactly what production runs).
 */
export function deriveSupportingSchedules(
  formType: '1120' | '1120S',
  fv: Record<string, any>,
  inputs: Record<string, any>,
  taxYear: number,
  computed: Record<string, any> | undefined,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  issues.push(...deriveCogs(fv))
  if (formType === '1120S') {
    issues.push(...deriveReconciliation1120S(fv, computed?.ordinary_income_loss ?? 0))
    issues.push(...derive4562(fv, inputs, taxYear, 'deductions.L14_depreciation'))
  } else {
    issues.push(...deriveReconciliation1120(fv, inputs))
    issues.push(...derive4562(fv, inputs, taxYear, 'deductions.L20_depreciation'))
  }
  return issues
}
