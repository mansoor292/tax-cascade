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
 * These are Edgewater Ventures' real figures. $710,075 went into 2022 and
 * $83,423 should have reached 2024; instead 2024 computed with no NOL and
 * overstated tax by about $17,500.
 */
import { describe, it, expect } from 'vitest'
import { calc1120 } from '../engine/tax_engine.js'

describe('NOL carryforward across profitable years', () => {
  it('leaves the unused balance after the 80% cap', () => {
    // 2022: $710,075 available against $459,266 of income.
    const y2022 = calc1120({
      gross_receipts: 459_266, nol_deduction: 710_075,
    } as any)
    const c22 = (y2022 as any).computed
    expect(c22.taxable_income_before_nol).toBe(459_266)
    // 80% of 459,266 = 367,412.80
    expect(Math.round(c22.nol_applied)).toBe(367_413)
    expect(Math.round(c22.nol_carryforward_remaining)).toBe(342_662)
  })

  it('carries the remainder through a second profitable year', () => {
    // 2023: the $342,662 left over, against $324,049 of income.
    const y2023 = calc1120({
      gross_receipts: 324_049, nol_deduction: 342_662,
    } as any)
    const c23 = (y2023 as any).computed
    expect(Math.round(c23.nol_applied)).toBe(259_239)
    // This is the figure that vanished.
    expect(Math.round(c23.nol_carryforward_remaining)).toBe(83_423)
  })

  it('uses the whole remainder when the cap no longer binds', () => {
    // 2024: $83,423 left, income $519,447. 80% of that is $415,558, so the
    // cap does not bind and the entire balance is deductible.
    const y2024 = calc1120({
      gross_receipts: 519_447, nol_deduction: 83_423,
    } as any)
    const c24 = (y2024 as any).computed
    expect(Math.round(c24.nol_applied)).toBe(83_423)
    expect(Math.round(c24.nol_carryforward_remaining)).toBe(0)
    expect(Math.round(c24.taxable_income)).toBe(436_024)
    // 436,024 x 21% — against 109,084 on the return computed with no NOL.
    expect(Math.round(c24.income_tax)).toBe(91_565)
  })

  it('does not invent a carryforward when none is requested', () => {
    const y = calc1120({ gross_receipts: 500_000 } as any)
    expect(Math.round((y as any).computed.nol_applied)).toBe(0)
    expect(Math.round((y as any).computed.nol_carryforward_remaining)).toBe(0)
  })
})
