/**
 * Form 1040 supporting schedules as data — see form1040_detail.ts for the
 * defects each case pins. Synthetic figures, chosen so each rule is visible.
 */
import { describe, it, expect } from 'vitest'
import { calc1040 } from './tax_engine.js'
import { buildReturnExport } from '../services/return_export.js'
import { validateFieldValues } from '../maps/canonical_schema.js'

const base = {
  filing_status: 'mfj', tax_year: 2025,
  k1_ordinary_income: 1_000_000, k1_w2_wages: 100_000, is_sstb: false,
} as any

describe('1040 supporting schedules', () => {
  it('puts K-1 income on line 8 through Schedule 1, not only in the total', () => {
    const fv = calc1040({ ...base, wages: 50_000 }).field_values!
    expect(fv['income.L8_schedule1']).toBe(1_000_000)
    expect(fv['sched1.L5_rental_partnership_scorp']).toBe(1_000_000)
    expect(fv['income.L9_total_income']).toBe(1_050_000)
  })

  it('uses the 2025 standard deduction as amended (31,500 joint)', () => {
    expect(calc1040({ ...base, wages: 50_000 }).field_values!['deductions.L12e_standard']).toBe(31_500)
  })

  it('caps a capital loss at 3,000 and keeps it out of net investment income', () => {
    const r = calc1040({ ...base, wages: 50_000, taxable_interest: 40_000,
      capital_transactions_detail: [{ label: 'XYZ', proceeds: 10_000, basis: 20_000, term: 'short' }] })
    const fv = r.field_values!
    expect(fv['income.L7a_capital_gains']).toBe(-3_000)
    expect(fv['schedD.L1a_gain_h']).toBe(-10_000)
    expect(fv['schedD.L21_loss_allowed']).toBe(-3_000)
    expect(fv['schedD.loss_carryover']).toBe(-7_000)
    // 8960 line 5a is a gain or zero — the loss does not reduce interest.
    expect(fv['f8960.L12_net_investment_income']).toBe(40_000)
    expect(fv['sched2.L12_niit']).toBe(Math.round(40_000 * 0.038))
  })

  it('adds K-1 portfolio items to the 1099 lines and lists payers on Schedule B', () => {
    const r = calc1040({ ...base, wages: 50_000,
      taxable_interest_detail: [{ label: 'Broker', amount: 400 }],
      ordinary_dividends_detail: [{ label: 'Broker', amount: 500, qualified: 500 }],
      k1_portfolio: { interest: 30_000, ordinary_dividends: 600, st_gain: 200 } })
    const fv = r.field_values!
    expect(fv['income.L2b_taxable_int']).toBe(30_400)
    expect(fv['income.L3b_ord_dividends']).toBe(1_100)
    expect(fv['income.L3a_qual_dividends']).toBe(500)
    expect(fv['schedB.L4_taxable_interest']).toBe(30_400)
    expect(fv['schedD.L5_k1_st_gain']).toBe(200)
    expect(fv['income.L7a_capital_gains']).toBe(200)
  })

  it('runs Form 8959 on box 5 and credits the 0.9% already withheld', () => {
    const r = calc1040({ ...base, w2s: [
      { owner: 'spouse', box1: 280_000, box2: 50_000, box3: 176_100, box4: 10_918, box5: 300_000, box6: 4_350 + 450 },
    ] })
    const fv = r.field_values!
    expect(fv['income.L1a_w2_wages']).toBe(280_000)
    // (300,000 − 250,000) × 0.9% = 450, and the employer withheld exactly that.
    expect(fv['sched2.L11_additional_medicare']).toBe(450)
    expect(fv['payments.L25c_other']).toBe(450)
    expect(fv['payments.L25d_total']).toBe(50_450)
  })

  it('credits excess social security only across two employers of one person', () => {
    const two = calc1040({ ...base, w2s: [
      { owner: 'taxpayer', box1: 150_000, box2: 0, box4: 9_300, box5: 150_000, box6: 2_175 },
      { owner: 'taxpayer', box1: 120_000, box2: 0, box4: 7_440, box5: 120_000, box6: 1_740 },
    ] }).field_values!
    // 9,300 + 7,440 − 6.2% × 176,100 (10,918) = 5,822
    expect(two['sched3.L11_excess_social_security']).toBe(5_822)
    const split = calc1040({ ...base, w2s: [
      { owner: 'taxpayer', box1: 150_000, box2: 0, box4: 9_300 },
      { owner: 'spouse', box1: 120_000, box2: 0, box4: 7_440 },
    ] }).field_values!
    expect(split['sched3.L11_excess_social_security']).toBeUndefined()
  })

  it('counts an extension payment on Schedule 3, not as an estimated payment', () => {
    const r = calc1040({ ...base, wages: 50_000, extension_payment: 300_000, prior_year_tax: 150_000, prior_year_agi: 600_000 })
    const fv = r.field_values!
    expect(fv['sched3.L10_extension_payment']).toBe(300_000)
    expect(fv['payments.L31_sched3']).toBe(300_000)
    expect(fv['payments.L26_estimated']).toBe(0)
    // Nothing paid during the year: the 110% safe harbor (165,000) is short in full.
    expect(r.computed.form2210_required_annual_payment).toBe(165_000)
    expect(r.computed.form2210_shortfall).toBe(165_000)
  })

  it('limits the QBI deduction by W-2 wages above the phaseout, on Form 8995-A', () => {
    const fv = calc1040({ ...base, wages: 50_000 }).field_values!
    expect(fv['f8995a.L5_fifty_pct_wages']).toBe(50_000)
    expect(fv['f8995a.L39_qbi_deduction']).toBe(50_000)
    expect(fv['deductions.L13a_qbi']).toBe(50_000)
  })

  it('stores only canonical keys and exports every schedule with its payers', () => {
    const inputs = { ...base, wages: 50_000,
      taxable_interest_detail: [{ label: 'Broker', amount: 2_000 }],
      capital_transactions_detail: [{ label: 'XYZ', proceeds: 1_000, basis: 1_500, term: 'short' }] }
    const r = calc1040(inputs)
    expect(validateFieldValues(r.field_values, '1040').errors).toEqual([])
    const exp = buildReturnExport({ form_type: '1040', field_values: r.field_values, input_data: inputs }, { name: 'Test' })
    const sections = new Set(exp.lines.map(l => l.section))
    for (const s of ['sched1', 'schedB', 'schedD', 'f8995a']) expect(sections.has(s), s).toBe(true)
    const sale = exp.details.find(d => d.bucket === 'capital_transactions')
    expect(sale?.value).toBe(-500)
  })

  it('lists K-1 portfolio income as a Schedule B payer and drops stray twin zeros', () => {
    const inputs = { ...base, wages: 50_000,
      taxable_interest_detail: [{ label: 'Broker', amount: 406 }],
      k1_portfolio: { name: 'S Corp (K-1)', interest: 32_943 },
      capital_transactions_detail: [{ label: 'XYZ', proceeds: 387_278.28, basis: 387_883.08, term: 'short' }] }
    const r = calc1040(inputs)
    const fv: Record<string, any> = { ...r.field_values, 'income.L7_capital_gains': 0, 'income.L11_agi': 0 }
    const exp = buildReturnExport({ form_type: '1040', field_values: fv, input_data: inputs }, { name: 'Test' })
    const payers = exp.details.filter(d => d.bucket === 'taxable_interest')
    expect(payers.reduce((t, d) => t + d.value, 0)).toBe(fv['schedB.L2_total_interest'])
    expect(exp.lines.find(l => l.key === 'income.L7_capital_gains')).toBeUndefined()
    expect(exp.lines.find(l => l.key === 'income.L11_agi')).toBeUndefined()
    expect(exp.details.find(d => d.bucket === 'capital_transactions')?.value).toBe(-604.8)
    // A 2024 import where the unsuffixed key is the real line keeps it.
    const old = buildReturnExport({ form_type: '1040', field_values: { 'income.L11_agi': 634_665, 'income.L11b_agi': 0 } }, { name: 'T' })
    expect(old.lines.find(l => l.key === 'income.L11_agi')?.value).toBe(634_665)
    expect(exp.details.find(d => d.bucket === 'taxable_interest')?.line).toBe('Sch B 1')
  })
})
