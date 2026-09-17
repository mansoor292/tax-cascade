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
import { deriveReconciliation1120S } from './reconciliation.js'

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
