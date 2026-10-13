/**
 * Form 1120-X must net the corrected return against what the original
 * return already paid out. Catipult stored only the corrected 1120, so its
 * Edgewater Ventures amendments showed the whole corrected overpayment
 * (435,059 for 2023, 168,170 for 2024) as if it were the refund.
 */
import { describe, it, expect } from 'vitest'
import { calc1120, calc1120X, form1120XColumn } from './tax_engine.js'
import { parseCanonicalKey } from '../services/return_export.js'

describe('calc1120X', () => {
  it('2023: a 7004 deposit, less the overpayment the original return credited forward', () => {
    const x = calc1120X({
      original: { total_income: 2_028_093, total_deductions: 1_041_546, taxable_income: 986_547, total_tax: 207_175 },
      corrected: { total_income: 1_343_457, total_deductions: 1_274_201, taxable_income: 69_256, total_tax: 14_544 },
      deposit_7004: 450_000, original_overpayment: 242_825,
    })
    const fv = x.field_values
    expect(fv['amended.L1_total_income_b']).toBe(-684_636)
    expect(fv['amended.L2_total_deductions_b']).toBe(232_655)
    expect(fv['amended.L3_taxable_income_b']).toBe(-917_291)
    expect(fv['amended.L4_total_tax_b']).toBe(-192_631)
    expect(fv['amended.L7_total_payments']).toBe(450_000)
    expect(fv['amended.L9_net_payments']).toBe(207_175)
    expect(fv['amended.L11_overpayment']).toBe(192_631)
    expect(fv['amended.L13_refunded']).toBe(192_631)
    expect(x.refund).toBe(192_631)
    expect(x.amount_owed).toBe(0)
  })

  it('2024: prior-year credit as posted plus a later payment, less what the IRS refunded', () => {
    const x = calc1120X({
      original: { total_income: 1_503_390, total_deductions: 812_379, taxable_income: 691_011, total_tax: 145_112 },
      corrected: { total_income: 1_393_540, total_deductions: 811_379, taxable_income: 582_161, total_tax: 122_254 },
      prior_year_credit: 240_950, tax_paid_after: 50_000, original_overpayment: 145_838,
    })
    expect(x.field_values['amended.L5d_net_estimated']).toBe(240_950)
    expect(x.field_values['amended.L7_total_payments']).toBe(290_950)
    expect(x.field_values['amended.L9_net_payments']).toBe(145_112)
    expect(x.refund).toBe(22_858)
  })

  it('owes when the corrected tax is higher, and splits a credit to next year off the refund', () => {
    const base = { total_income: 100, total_deductions: 0, taxable_income: 100, total_tax: 21_000 }
    const owed = calc1120X({ original: base, corrected: { ...base, total_tax: 25_000 }, estimated_tax: 21_000 })
    expect(owed.amount_owed).toBe(4_000)
    expect(owed.refund).toBe(0)
    const split = calc1120X({ original: base, corrected: { ...base, total_tax: 15_000 }, estimated_tax: 21_000, credit_to_estimated: 2_500 })
    expect(split.field_values['amended.L11_overpayment']).toBe(6_000)
    expect(split.field_values['amended.L12_credited_estimated']).toBe(2_500)
    expect(split.refund).toBe(3_500)
  })

  it('reads column A/C off a Form 1120, NOL included in line 2', () => {
    expect(form1120XColumn({
      'income.L11_total_income': 2_028_093, 'deductions.L27_total_deductions': 1_004_217,
      'tax.L29c_total_29': 37_329, 'tax.L30_taxable_income': 986_547, 'tax.L31_total_tax': 207_175,
    })).toEqual({ total_income: 2_028_093, total_deductions: 1_041_546, taxable_income: 986_547, total_tax: 207_175 })
  })

  it('exports Part I columns A, B and C as columns', () => {
    expect(parseCanonicalKey('amended.L4_total_tax_c')).toMatchObject({ section: 'amended', line: '4', column: 'c', label: 'total tax' })
    expect(parseCanonicalKey('amended.L13_refunded')).toMatchObject({ line: '13', column: null })
  })
})

describe('calc1120 payments', () => {
  it('puts a prior-year credit on Schedule J line 13 and a 7004 deposit on line 17', () => {
    const r = calc1120({ gross_receipts: 1_000_000, tax_year: 2024, estimated_tax_paid: 50_000,
      prior_year_overpayment: 240_950, deposit_7004: 10_000 } as any)
    expect(r.field_values!['schedJ.J13_prior_overpayment']).toBe(240_950)
    expect(r.field_values!['schedJ.J14_estimated_payments']).toBe(50_000)
    expect(r.field_values!['schedJ.J17_7004_deposit']).toBe(10_000)
    expect(r.field_values!['payments.L33_total_payments']).toBe(300_950)
  })
})
