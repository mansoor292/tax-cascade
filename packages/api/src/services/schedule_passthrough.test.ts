/**
 * Form 1125-A (cogs.*) and Form 4562 (dep.*, amort.*) lines must survive a
 * compute. They were not on the pass-through list, so a return could state
 * line 2 and line 20 but the attached 1125-A and 4562 printed blank.
 */
import { describe, it, expect } from 'vitest'
import { isPassthroughScheduleKey } from './compute_return.js'

describe('isPassthroughScheduleKey', () => {
  it.each([
    'schedL.L7_loans_eoy_d', 'schedM1.L5c_travel_ent', 'schedM2.L5a_cash_distributions',
    'schedK.L4_interest', 'cogs.L5_other', 'cogs.L8_cogs', 'dep.L17_macrs_prior', 'dep.L43_amortization',
  ])('keeps %s', k => expect(isPassthroughScheduleKey(k)).toBe(true))

  it.each(['gross_receipts', 'deductions.L20_depreciation', 'tax.L31_total_tax', 'schedJ.J12_total_tax'])(
    'leaves %s to the engine', k => expect(isPassthroughScheduleKey(k)).toBe(false))
})
