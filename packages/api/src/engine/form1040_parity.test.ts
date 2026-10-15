/**
 * The 2025 parity fixes to the 1040 engine — each pinned with synthetic
 * figures. The defects they guard (see form1040_detail.ts / tax_engine.ts):
 * no capital loss carryover input, a capital loss floored at zero on Form
 * 8960, no line 38 penalty, line 11a and line 32 left empty, a 2,000 child
 * credit for 2025, and no Form 7203 or Schedule 8812 data.
 */
import { describe, it, expect } from 'vitest'
import { calc1040 } from './tax_engine.js'
import { capitalLossCarryoverWorksheet, form2210Penalty, form7203StockBasis } from './form1040_detail.js'
import { validateFieldValues } from '../maps/canonical_schema.js'

const base = {
  filing_status: 'mfj', tax_year: 2025,
  k1_ordinary_income: 1_000_000, k1_w2_wages: 100_000, is_sstb: false,
} as any

describe('Schedule D capital loss carryover', () => {
  it('takes a long-term carryover on line 14 and carries the unused loss forward', () => {
    const fv = calc1040({ ...base, wages: 50_000,
      capital_transactions_detail: [{ label: 'X', proceeds: 1_000, basis: 1_500, term: 'short' }],
      k1_portfolio: { st_gain: 100 },
      capital_loss_carryover: { long_term: 6_000 } }).field_values!
    expect(fv['schedD.L14_lt_carryover']).toBe(6_000)
    expect(fv['schedD.L7_net_short_term']).toBe(-400)
    expect(fv['schedD.L15_net_long_term']).toBe(-6_000)
    expect(fv['schedD.L16_total']).toBe(-6_400)
    expect(fv['income.L7a_capital_gains']).toBe(-3_000)
    // Worksheet: the 3,000 deduction uses the 400 short-term loss first, so
    // 2,600 of it absorbs long-term loss and 3,400 carries.
    expect(fv['schedD.carryover_next_st']).toBeUndefined()
    expect(fv['schedD.carryover_next_lt']).toBe(3_400)
  })

  it('worksheet splits short- and long-term carryovers', () => {
    expect(capitalLossCarryoverWorksheet({ taxableIncome: 100_000, lossAllowed: 3_000, netST: -5_000, netLT: -1_000 }))
      .toEqual({ short_term: 2_000, long_term: 1_000 })
    expect(capitalLossCarryoverWorksheet({ taxableIncome: 100_000, lossAllowed: 3_000, netST: 2_000, netLT: -9_000 }))
      .toEqual({ short_term: 0, long_term: 4_000 })
  })
})

describe('Form 8960 with a capital loss', () => {
  it('backs out nonpassive S-corp income on 4b and nets only the deductible 3,000 on 5a', () => {
    const fv = calc1040({ ...base, wages: 50_000, taxable_interest: 20_000,
      capital_loss_carryover: { long_term: 10_000 } }).field_values!
    expect(fv['f8960.L4a_rental_partnership']).toBe(1_000_000)
    expect(fv['f8960.L4b_nonsection1411_adj']).toBe(-1_000_000)
    expect(fv['f8960.L5a_net_gain']).toBe(-3_000)
    expect(fv['f8960.L5d_combined']).toBe(-3_000)
    expect(fv['f8960.L12_net_investment_income']).toBe(17_000)
  })
})

describe('Form 1040 face lines', () => {
  it('prints AGI on 11a and Schedule 3 payments in line 32', () => {
    const fv = calc1040({ ...base, wages: 50_000, extension_payment: 100_000 }).field_values!
    expect(fv['income.L11a_subtract']).toBe(fv['income.L11b_agi'])
    expect(fv['payments.L31_sched3']).toBe(100_000)
    expect(fv['payments.L32_other_total']).toBe(100_000)
    expect(fv['credits.L20_sched3']).toBe(0)
    expect(fv['refund.L36_applied_est']).toBe(0)
  })
})

describe('Form 2210 regular method (line 38)', () => {
  it('charges 7% a year on each underpaid installment until April 15', () => {
    // 4 × 10,000 required, nothing withheld: 10,000 late from each due date.
    const p = form2210Penalty({ taxYear: 2025, requiredAnnualPayment: 40_000, withholding: 0 })!
    const days = 365 + 303 + 212 + 90
    expect(p.penalty).toBe(Math.round(10_000 * 0.07 * days / 365))
    expect(p.underpayments).toEqual([10_000, 10_000, 10_000, 10_000])
  })

  it('stops the clock on a dated payment', () => {
    const p = form2210Penalty({ taxYear: 2025, requiredAnnualPayment: 40_000, withholding: 0,
      payments: [{ date: '2025-05-15', amount: 10_000 }] })!
    // Q1 is paid 30 days late; Q2-Q4 run to April 15.
    expect(p.penalty).toBe(Math.round(10_000 * 0.07 * (30 + 303 + 212 + 90) / 365))
  })

  it('adds the penalty to line 37 and uses the 110% prior-year safe harbor', () => {
    const r = calc1040({ ...base, wages: 50_000, withholding: 40_000, prior_year_tax: 100_000, prior_year_agi: 500_000 })
    const fv = r.field_values!
    expect(r.computed.form2210_required_annual_payment).toBe(110_000)
    expect(fv['penalty.L38_est_penalty']).toBeGreaterThan(0)
    expect(fv['owed.L37_amount_owed']).toBe(fv['tax.L24_total_tax'] - fv['payments.L33_total'] + fv['penalty.L38_est_penalty'])
  })

  it('takes a stated penalty over the computed one', () => {
    const fv = calc1040({ ...base, wages: 50_000, prior_year_tax: 100_000, estimated_tax_penalty: 1_234 }).field_values!
    expect(fv['penalty.L38_est_penalty']).toBe(1_234)
  })
})

describe('Schedule 8812', () => {
  it('uses the 2025 $2,200 credit and rounds the excess up to the next $1,000', () => {
    const fv = calc1040({ ...base, wages: 50_000, num_dependents: 2 }).field_values!
    expect(fv['f8812.L5_children_credit']).toBe(4_400)
    // AGI 1,050,000 − 400,000 = 650,000 exactly; ×5% = 32,500 > 4,400.
    expect(fv['f8812.L10_excess_rounded']).toBe(650_000)
    expect(fv['f8812.L11_phaseout']).toBe(32_500)
    expect(fv['f8812.L12_after_phaseout']).toBeUndefined()
    const odd = calc1040({ ...base, k1_ordinary_income: 0, wages: 400_500, num_dependents: 1 }).field_values!
    expect(odd['f8812.L10_excess_rounded']).toBe(1_000)
    expect(odd['f8812.L12_after_phaseout']).toBe(2_150)
  })
})

describe('Form 7203', () => {
  it('builds stock basis from the K-1 items and the shareholder facts', () => {
    const { lines, excessDistribution } = form7203StockBasis(
      { stock_basis_boy: 1_000, distributions: 50_000, nondeductible_expenses: 500 },
      { ordinary: 60_000, interest: 200, dividends: 100, capitalGain: 50 })
    expect(lines.L4_increases).toBe(60_350)
    expect(lines.L5_basis_before_distributions).toBe(61_350)
    expect(lines.L7_basis_after_distributions).toBe(11_350)
    expect(lines.L15_stock_basis_eoy).toBe(10_850)
    expect(excessDistribution).toBe(0)
  })

  it('flows through calc1040 under the f7203 section', () => {
    const fv = calc1040({ ...base, wages: 50_000, k1_portfolio: { interest: 100 },
      form7203: { distributions: 900_000, nondeductible_expenses: 1_000 } }).field_values!
    expect(fv['f7203.L3a_ordinary_income']).toBe(1_000_000)
    expect(fv['f7203.L15_stock_basis_eoy']).toBe(1_000_000 + 100 - 900_000 - 1_000)
    expect(validateFieldValues(fv, '1040').errors).toEqual([])
  })
})

describe('Form 8995-A Part II/IV lines', () => {
  it('carries the wage-limited component through to line 39', () => {
    const fv = calc1040({ ...base, wages: 50_000 }).field_values!
    for (const k of ['L11_smaller_3_10', 'L13_greater_11_12', 'L15_qbi_component', 'L16_total_qbi_component',
      'L27_total_qbi_component', 'L32_qbi_before_income_limit', 'L37_qbi_before_dpad', 'L39_qbi_deduction'])
      expect(fv[`f8995a.${k}`], k).toBe(50_000)
    expect(fv['f8995a.L21_threshold']).toBe(394_600)
    expect(fv['f8995a.L23_phase_in_range']).toBe(100_000)
  })
})
