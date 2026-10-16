/**
 * The figures here are the real ones from the incident. A return was
 * recomputed with a different taxes-and-licenses figure and a new other-income
 * line; ordinary business income moved from 1,268,993 to 1,306,476, and both
 * reconciliation schedules kept the old number because the caller had supplied
 * them explicitly on an earlier pass. The preparer caught it at the point of
 * keying — the ending AAA, which is what a shareholder's basis is computed
 * from, was built on income the return no longer reported.
 */
import { describe, it, expect } from 'vitest'
import { deriveReconciliation1120S, deriveReconciliation1120, deriveCogs, derive4562, aaaFromScheduleK } from './reconciliation.js'

describe('deriveReconciliation1120S', () => {
  it('moves Schedule M-2 with ordinary income instead of leaving it stale', () => {
    const fv: Record<string, any> = {
      'schedM2.L1_beg_balance': 82_652,
      'schedM2.L2_ordinary_income': 1_268_993,   // the previous figure
      'schedM2.L3_other_additions': 33_602,
      'schedM2.L5_other_reductions': 4_491,
      'schedM2.L7_distributions': 957_009,
      'schedM2.L8_end_balance': 423_747,         // built on the previous figure
    }
    deriveReconciliation1120S(fv, 1_306_476)

    expect(fv['schedM2.L2_ordinary_income']).toBe(1_306_476)
    // 82,652 + 1,306,476 + 33,602 - 4,491 = 1,418,239
    expect(fv['schedM2.L6_combine']).toBe(1_418_239)
    // 1,418,239 - 957,009 = 461,230
    expect(fv['schedM2.L8_end_balance']).toBe(461_230)
  })

  it('puts a loss on line 4 and leaves line 2 empty', () => {
    const fv: Record<string, any> = { 'schedM2.L1_beg_balance': 50_000, 'schedM2.L7_distributions': 0 }
    deriveReconciliation1120S(fv, -20_000)
    expect(fv['schedM2.L2_ordinary_income']).toBe(0)
    expect(fv['schedM2.L4_loss']).toBe(20_000)
    expect(fv['schedM2.L6_combine']).toBe(30_000)
  })

  it('computes the M-1 subtotals the form tells you to add', () => {
    const fv: Record<string, any> = {
      'schedM1.L1_net_income_books': 1_298_075,
      'schedM1.L2_income_on_K': 29,
      'schedM1.L3_expenses_not_K': 4_491,
      'schedM1.L5_income_not_K': 0,
      'schedM1.L6_ded_on_K': 0,
      'schedK.L18_income_loss': 1_302_595,
    }
    const issues = deriveReconciliation1120S(fv, 1_268_993)
    expect(fv['schedM1.L4_add']).toBe(1_302_595)
    expect(fv['schedM1.L8_income_K18']).toBe(1_302_595)
    expect(issues).toHaveLength(0)
  })

  it('reports, rather than hides, reconciling items that do not reach Schedule K line 18', () => {
    const fv: Record<string, any> = {
      'schedM1.L1_net_income_books': 1_298_075,
      'schedM1.L2_income_on_K': 29,
      'schedM1.L3_expenses_not_K': 4_491,
      'schedK.L18_income_loss': 1_340_078,   // moved; the items did not
    }
    const issues = deriveReconciliation1120S(fv, 1_306_476)
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('schedM1.L8_income_K18')
    expect(issues[0].delta).toBe(-37_483)
    // The figure is NOT quietly forced to match.
    expect(fv['schedM1.L8_income_K18']).toBe(1_302_595)
  })

  it('does not invent a schedule the return does not have', () => {
    const fv: Record<string, any> = { 'income.L6_total_income': 100 }
    deriveReconciliation1120S(fv, 100)
    expect(Object.keys(fv).some(k => k.startsWith('schedM'))).toBe(false)
  })
})

/**
 * 2026-10-16 blind test: the engine was run on the 2025 books with every
 * derived line cleared, and compared box by box with the filed returns. These
 * are the lines it left blank or wrong, with the filed figures.
 */
describe('Schedule M-2 (1120-S) from Schedule K', () => {
  const eza = (): Record<string, any> => ({
    'schedK.L4_interest': 32_943,
    'schedK.L5a_ordinary_dividends': 511,
    'schedK.L7_st_capital_gain': 147,
    'schedK.L16c_nondeductible': 4_491,
    'schedK.L16d_distributions': 965_784,
    'schedK.L18_income_loss': 1_340_077,
    'schedM2.L1_beg_balance': 0,
  })

  it('derives lines 3, 5 and 7, so the ending AAA is not overstated by every dollar distributed', () => {
    const fv = eza()
    const issues = deriveReconciliation1120S(fv, 1_306_476)
    expect(fv['schedM2.L3_other_additions']).toBe(33_601)     // 32,943 + 511 + 147
    expect(fv['schedM2.L5_other_reductions']).toBe(4_491)
    expect(fv['schedM2.L6_combine']).toBe(1_335_586)
    expect(fv['schedM2.L7_distributions']).toBe(965_784)
    expect(fv['schedM2.L8_end_balance']).toBe(369_802)        // as filed; was 1,306,476
    expect(issues).toEqual([])
  })

  it('itemizes line 3 by the Schedule K lines it came from', () => {
    expect(aaaFromScheduleK(eza()).additionItems).toEqual([
      { label: 'Interest income', amount: 32_943 },
      { label: 'Ordinary dividends', amount: 511 },
      { label: 'Net short-term capital gain', amount: 147 },
    ])
  })

  it('keeps a stated line, and reports one Schedule K contradicts', () => {
    const fv = { ...eza(), 'schedM2.L3_other_additions': 34_601 }
    const issues = deriveReconciliation1120S(fv, 1_306_476)
    expect(fv['schedM2.L3_other_additions']).toBe(34_601)
    expect(issues.map(i => [i.field, i.delta])).toEqual([['schedM2.L3_other_additions', 1_000]])
  })

  it('a capital loss reduces, and distributions never take the AAA below zero', () => {
    const fv: Record<string, any> = {
      'schedK.L8a_lt_capital_gain': -2_000, 'schedK.L16d_distributions': 50_000,
      'schedM2.L1_beg_balance': 10_000,
    }
    const issues = deriveReconciliation1120S(fv, 30_000)
    expect(fv['schedM2.L5_other_reductions']).toBe(2_000)
    expect(fv['schedM2.L6_combine']).toBe(38_000)
    expect(fv['schedM2.L7_distributions']).toBe(38_000)
    expect(fv['schedM2.L8_end_balance']).toBe(0)
    expect(issues.map(i => i.field)).toEqual(['schedM2.L7_distributions'])
  })
})

describe('Form 1125-A', () => {
  it('adds lines 1 through 5 and subtracts closing inventory', () => {
    const fv: Record<string, any> = { 'cogs.L3_labor': 11_813, 'cogs.L5_other': 1_194_823, 'income.L2_cogs': 1_206_636 }
    expect(deriveCogs(fv)).toEqual([])
    expect(fv['cogs.L6_total']).toBe(1_206_636)
    expect(fv['cogs.L8_cogs']).toBe(1_206_636)
  })

  it('reports a line 8 that is not page 1 line 2', () => {
    const fv: Record<string, any> = { 'cogs.L2_purchases': 900, 'cogs.L7_inventory_eoy': 100, 'income.L2_cogs': 900 }
    const issues = deriveCogs(fv)
    expect(fv['cogs.L8_cogs']).toBe(800)
    expect(issues.map(i => i.field)).toEqual(['cogs.L8_cogs'])
  })

  it('leaves a return without Form 1125-A alone', () => {
    const fv: Record<string, any> = { 'income.L2_cogs': 0 }
    deriveCogs(fv)
    expect('cogs.L6_total' in fv).toBe(false)
  })
})

describe('Schedules M-1 and M-2 (1120)', () => {
  // Edgewater Ventures 2025 from the books: M-1 line 10 lands on page 1 line 28.
  const ev = (): Record<string, any> => ({
    'tax.L28_ti_before_nol': 137_708.52,
    'schedM1.L1_net_income_books': 147_667,
    'schedM1.L2_fed_tax_books': 0,
    'schedM1.L5c_travel_ent': 3_187,
    'schedM1.L8a_depreciation': 8_040,
    'schedM2.L1_beg_balance': 2_255_800,
    'schedM2.L3_other_increases': 36_013,
    'schedM2.L5a_cash_distributions': 500,
    'schedM2.L6_other_decreases': 2_937,
    'schedL.L25_retained_eoy_d': 2_436_043,
  })
  const items = { schedM1_L8_items: [{ label: 'Florida income tax accrual', amount: 5_105 }] }

  it('adds up every total the form prints instructions for', () => {
    const fv = ev()
    expect(deriveReconciliation1120(fv, items)).toEqual([])
    expect(fv['schedM1.L5_expenses_not_ded']).toBe(3_187)
    expect(fv['schedM1.L6_add_1_thru_5']).toBe(150_854)
    expect(fv['schedM1.L8_ded_not_charged']).toBe(13_145)    // 8,040 + the 5,105 item
    expect(fv['schedM1.L9_add_7_8']).toBe(13_145)
    expect(fv['schedM1.L10_income_line28']).toBe(137_709)
    expect(fv['schedM2.L2_net_income']).toBe(147_667)        // = M-1 line 1
    expect(fv['schedM2.L4_add']).toBe(2_439_480)
    expect(fv['schedM2.L7_add_5_6']).toBe(3_437)
    expect(fv['schedM2.L8_end_balance']).toBe(2_436_043)     // = Schedule L line 25
  })

  it('reports an M-1 that does not reach line 28, rather than forcing it', () => {
    const fv = ev()
    const issues = deriveReconciliation1120(fv, {})            // the 5,105 item left out
    expect(fv['schedM1.L10_income_line28']).toBe(142_814)
    expect(issues.map(i => [i.field, i.delta])).toEqual([['schedM1.L10_income_line28', 5_105]])
  })
})

describe('Form 4562', () => {
  it('fills the 2025 section 179 limits and the line 22 and 44 totals', () => {
    const fv: Record<string, any> = {
      'dep.L14_special_allowance': 474, 'dep.L17_macrs_prior': 8_040, 'dep.L43_amortization': 44_023,
      'deductions.L20_depreciation': 8_514,
    }
    expect(derive4562(fv, {}, 2025, 'deductions.L20_depreciation')).toEqual([])
    expect(fv['dep.L1_179_limit']).toBe(2_500_000)
    expect(fv['dep.L3_threshold']).toBe(4_000_000)
    expect(fv['dep.L5_179_dollar_limit']).toBe(2_500_000)
    expect(fv['dep.L22_total']).toBe(8_514)
    expect(fv['dep.L44_total_amort']).toBe(44_023)
  })

  it('reduces the limit dollar for dollar over the threshold', () => {
    const fv: Record<string, any> = { 'dep.L2_179_cost': 4_300_000, 'dep.L12_179_expense': 0 }
    derive4562(fv, {}, 2025, 'deductions.L20_depreciation')
    expect(fv['dep.L4_179_reduction']).toBe(300_000)
    expect(fv['dep.L5_179_dollar_limit']).toBe(2_200_000)
  })
})
