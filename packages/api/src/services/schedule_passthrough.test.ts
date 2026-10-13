/**
 * Form 1125-A (cogs.*) and Form 4562 (dep.*, amort.*) lines must survive a
 * compute. They were not on the pass-through list, so a return could state
 * line 2 and line 20 but the attached 1125-A and 4562 printed blank.
 *
 * Schedule J and payment lines the engine never computes can be filled or
 * zeroed by the caller; the ones it computes cannot be overridden.
 */
import { describe, it, expect } from 'vitest'
import { isPassthroughScheduleKey, overlayUncomputedLines } from './compute_return.js'

describe('isPassthroughScheduleKey', () => {
  it.each([
    'schedL.L7_loans_eoy_d', 'schedM1.L5c_travel_ent', 'schedM2.L5a_cash_distributions',
    'schedK.L4_interest', 'cogs.L5_other', 'cogs.L8_cogs', 'dep.L17_macrs_prior', 'dep.L43_amortization',
  ])('keeps %s', k => expect(isPassthroughScheduleKey(k)).toBe(true))

  it.each(['gross_receipts', 'deductions.L20_depreciation', 'tax.L31_total_tax', 'schedJ.J12_total_tax'])(
    'leaves %s to the engine', k => expect(isPassthroughScheduleKey(k)).toBe(false))
})

describe('overlayUncomputedLines', () => {
  it('lets a caller zero a seeded Schedule J / payment line the engine never computes', () => {
    const fv: Record<string, any> = { 'schedJ.J14_estimated_payments': 290_950, 'payments.L36_overpayment': 168_170 }
    overlayUncomputedLines(fv, {
      'schedJ.J13_prior_overpayment': 0, 'payments.L37_refunded': 0, gross_receipts: 1,
    })
    expect(fv['schedJ.J13_prior_overpayment']).toBe(0)
    expect(fv['payments.L37_refunded']).toBe(0)
    expect(fv).not.toHaveProperty('gross_receipts')
  })

  it('never overrides a line the engine computed', () => {
    const fv: Record<string, any> = { 'schedJ.J14_estimated_payments': 290_950, 'payments.L36_overpayment': 168_170 }
    overlayUncomputedLines(fv, { 'schedJ.J14_estimated_payments': 1, 'payments.L36_overpayment': 2 })
    expect(fv['schedJ.J14_estimated_payments']).toBe(290_950)
    expect(fv['payments.L36_overpayment']).toBe(168_170)
  })
})
