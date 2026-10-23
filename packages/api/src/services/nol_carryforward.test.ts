/**
 * An unused NOL balance must survive a profitable year.
 *
 * §172(a)(2) caps the deduction at 80% of taxable income, so a company with a
 * carryforward and positive income uses part of it and carries the rest. The
 * engine computed that remainder and threw it away — computed_data is not
 * persisted — and the cross-year pull in compute_return only looked for an NOL
 * *generated* by a loss year. A run of profitable years therefore leaked the
 * balance one cap at a time.
 *
 * These are the Talbrook demo group's figures, standing in for Edgewater
 * Ventures' real ones. $587,582 went into 2022 and $108,332 should have
 * reached 2024; instead 2024 computed with no NOL and overstated tax by about
 * $22,700.
 */
import { describe, it, expect } from 'vitest'
import { calc1120 } from '../engine/tax_engine.js'

describe('NOL carryforward across profitable years', () => {
  it('leaves the unused balance after the 80% cap', () => {
    // 2022: $587,582 available against $357,482 of income.
    const y2022 = calc1120({
      gross_receipts: 357_482, nol_deduction: 587_582,
    } as any)
    const c22 = (y2022 as any).computed
    expect(c22.taxable_income_before_nol).toBe(357_482)
    // 80% of 357,482 = 285,985.60
    expect(Math.round(c22.nol_applied)).toBe(285_986)
    expect(Math.round(c22.nol_carryforward_remaining)).toBe(301_596)
  })

  it('carries the remainder through a second profitable year', () => {
    // 2023: the $301,596 left over, against $241,580 of income.
    const y2023 = calc1120({
      gross_receipts: 241_580, nol_deduction: 301_596,
    } as any)
    const c23 = (y2023 as any).computed
    // 80% of 241,580 = 193,264
    expect(Math.round(c23.nol_applied)).toBe(193_264)
    // This is the figure that vanished.
    expect(Math.round(c23.nol_carryforward_remaining)).toBe(108_332)
  })

  it('uses the whole remainder when the cap no longer binds', () => {
    // 2024: $108,332 left, income $415,726. 80% of that is $332,581, so the
    // cap does not bind and the entire balance is deductible.
    const y2024 = calc1120({
      gross_receipts: 415_726, nol_deduction: 108_332,
    } as any)
    const c24 = (y2024 as any).computed
    expect(Math.round(c24.nol_applied)).toBe(108_332)
    expect(Math.round(c24.nol_carryforward_remaining)).toBe(0)
    expect(Math.round(c24.taxable_income)).toBe(307_394)
    // 307,394 x 21% — against 87,302 on the return computed with no NOL.
    expect(Math.round(c24.income_tax)).toBe(64_553)
  })

  it('does not invent a carryforward when none is requested', () => {
    const y = calc1120({ gross_receipts: 500_000 } as any)
    expect(Math.round((y as any).computed.nol_applied)).toBe(0)
    expect(Math.round((y as any).computed.nol_carryforward_remaining)).toBe(0)
  })
})
