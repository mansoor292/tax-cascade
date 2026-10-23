/**
 * Audit-risk rater. The cases are shaped on returns prepared this week (figures
 * are the Talbrook demo group's, standing in for the owner's): an
 * 1120 whose Schedule L counted a shareholder loan twice, an 1120-S paying its
 * owner 120,000 beside 905,103 of distributions, and a joint 1040 over $1M.
 */
import { describe, it, expect } from 'vitest'
import { rateReturn } from './audit_risk.js'

const codes = (r: ReturnType<typeof rateReturn>) => r.flags.map(f => f.code)

const ev1120 = {
  'income.L1c_balance': 1_093_086, 'income.L2_cogs': 10_093,
  'deductions.L27_total_deductions': 1_059_759, 'deductions.L26_other_deductions': 153_330,
  'deductions.L22_advertising': 7_801, 'deductions.L12_officer_comp': 0, 'deductions.L13_salaries': 716_405,
  'tax.L28_ti_before_nol': 82_677,
  'schedM1.L10_income_line28': 82_677,
  'schedL.L1_cash_eoy_d': 91_078, 'schedL.L2a_trade_eoy_d': 1_434, 'schedL.L6_othercurr_eoy_d': 30_986,
  'schedL.L7_loans_eoy_d': 500_000, 'schedL.L10b_dep_eoy_d': 484, 'schedL.L13b_amort_eoy_d': 240_038,
  'schedL.L14_other_eoy_d': 494_175, 'schedL.L15_total_eoy_d': 1_358_195, 'schedL.L28_total_eoy_d': 1_358_195,
}

describe('audit risk — 1120', () => {
  it('passes a balance sheet whose lines add to the total', () => {
    const r = rateReturn('1120', ev1120)
    expect(codes(r)).not.toContain('SCHED_L_LINES_VS_TOTAL')
    expect(codes(r)).not.toContain('SCHED_L_UNBALANCED')
    expect(codes(r)).not.toContain('M1_NOT_TIED')
  })

  it('catches a shareholder loan counted twice in Schedule L', () => {
    // The QBO mapper put the 500,000 loan on line 7 AND inside line 14 (494,175 + 500,000).
    const r = rateReturn('1120', { ...ev1120, 'schedL.L14_other_eoy_d': 994_175 })
    const f = r.flags.find(x => x.code === 'SCHED_L_LINES_VS_TOTAL')
    expect(f?.severity).toBe('high')
    expect(f?.value).toBe(500_000)
  })

  it('catches M-1 that does not reach line 28', () => {
    const r = rateReturn('1120', { ...ev1120, 'schedM1.L10_income_line28': 99_628 })
    expect(codes(r)).toContain('M1_NOT_TIED')
  })

  it('flags a large loan to a shareholder', () => {
    expect(codes(rateReturn('1120', ev1120))).toContain('SHAREHOLDER_LOAN')
  })

  it('flags an expense ratio above 80% but not a normal one', () => {
    const tight = rateReturn('1120', { 'income.L1c_balance': 100_000, 'deductions.L27_total_deductions': 82_000 })
    expect(codes(tight)).toContain('EXPENSE_RATIO')
    const normal = rateReturn('1120', { 'income.L1c_balance': 100_000, 'deductions.L27_total_deductions': 55_000 })
    expect(codes(normal)).not.toContain('EXPENSE_RATIO')
  })

  it('reads meals and travel out of the other-deductions statement', () => {
    const r = rateReturn('1120', { 'income.L1c_balance': 150_000, 'deductions.L27_total_deductions': 60_000, 'deductions.L26_other_deductions': 40_000 },
      { inputs: { other_deductions_detail: [
        { label: 'Meals with clients', amount: 12_000 }, { label: 'Airfare', amount: 9_000 }, { label: 'Vehicle fuel', amount: 6_000 },
      ] } })
    expect(r.flags.find(f => f.code === 'MEALS')?.severity).toBe('high')          // 12,000 = 8% (> 5%)
    expect(r.flags.find(f => f.code === 'TRAVEL_AUTO')?.severity).toBe('medium')  // 15,000 = 10% (8-15%)
  })

  it('treats an un-itemized "other" lump as worse than an itemized one', () => {
    const fv = { 'income.L1c_balance': 1_000_000, 'deductions.L27_total_deductions': 500_000, 'deductions.L26_other_deductions': 200_000 }
    const bare = rateReturn('1120', fv).flags.find(f => f.code === 'OTHER_DEDUCTIONS')
    const itemized = rateReturn('1120', fv, { inputs: { other_deductions_detail: [{ label: 'Software', amount: 200_000 }] } })
      .flags.find(f => f.code === 'OTHER_DEDUCTIONS')
    expect(bare?.severity).toBe('medium')
    expect(itemized?.severity).toBe('low')
  })

  it('flags a large year-over-year swing', () => {
    const r = rateReturn('1120', { 'income.L1c_balance': 1_000_000, 'deductions.L22_advertising': 0 },
      { prior: { 'income.L1c_balance': 1_000_000, 'deductions.L22_advertising': 600_000 } })
    expect(r.flags.find(f => f.code === 'YOY_SWING')?.lines).toEqual(['deductions.L22_advertising'])
  })
})

describe('audit risk — 1120-S', () => {
  const eza = {
    'income.L1c_balance': 2_555_456, 'income.L2_cogs': 1_065_137, 'deductions.L21_total': 338_866,
    'deductions.L20_other': 212_475, 'deductions.L7_officer_comp': 120_000,
    'tax.L22_ordinary_income': 1_163_353, 'schedK.L16d_distributions': 905_103,
    'schedM2.L1_beg_balance': 63_276, 'schedM2.L2_ordinary_income': 1_163_353, 'schedM2.L3_other_additions': 30_826,
    'schedM2.L5_other_reductions': 4_616, 'schedM2.L7_distributions': 905_103, 'schedM2.L8_end_balance': 347_736,  // 63,276 + 1,163,353 + 30,826 − 4,616 − 905,103
  }
  it('flags low officer pay beside large distributions (reasonable compensation)', () => {
    const f = rateReturn('1120S', eza).flags.find(x => x.code === 'REASONABLE_COMP')
    expect(f?.severity).toBe('medium')
    expect(rateReturn('1120S', { ...eza, 'deductions.L7_officer_comp': 0 }).flags.find(x => x.code === 'REASONABLE_COMP')?.severity).toBe('high')
  })
  it('accepts an M-2 that rolls forward and catches one that does not', () => {
    expect(codes(rateReturn('1120S', eza))).not.toContain('M2_NOT_TIED')
    expect(codes(rateReturn('1120S', { ...eza, 'schedM2.L8_end_balance': 323_905 }))).toContain('M2_NOT_TIED')
  })
})

describe('audit risk — 1040', () => {
  it('notes the high income class and a K-1-heavy mix, not the standard deduction', () => {
    const r = rateReturn('1040', {
      'income.L11b_agi': 1_867_153, 'income.L1z_total_wages': 120_000, 'sched1.L5_rental_partnership_scorp': 1_163_353,
      'deductions.L12e_standard': 31_500, 'income.L2b_taxable_int': 29_243,   // 406 + 28,837
    }, { inputs: { taxable_interest_detail: [{ label: 'Broker', amount: 406 }], k1_portfolio: { interest: 28_837 } } })
    expect(codes(r)).toEqual(expect.arrayContaining(['HIGH_INCOME', 'PASSTHROUGH_VS_WAGES']))
    expect(codes(r)).not.toContain('DEDUCTIONS_VS_AGI')
    expect(codes(r)).not.toContain('SCHED_B_NOT_TIED')
  })
  it('catches Schedule B payers that do not add to line 2b', () => {
    const r = rateReturn('1040', { 'income.L2b_taxable_int': 29_243 }, { inputs: { taxable_interest_detail: [{ label: 'Broker', amount: 406 }] } })
    expect(codes(r)).toContain('SCHED_B_NOT_TIED')
  })
  it('scores and bands', () => {
    const r = rateReturn('1120', { ...ev1120, 'schedL.L14_other_eoy_d': 994_175, 'schedM1.L10_income_line28': 1 })
    expect(r.score).toBeGreaterThanOrEqual(50)
    expect(r.band).toBe('high')
    expect(r.disclaimer).toMatch(/not IRS norms/)
  })
})
