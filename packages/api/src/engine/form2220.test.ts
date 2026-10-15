import { describe, it, expect } from 'vitest'
import { calc2220 } from './form2220.js'
import { calc1120, TaxInputError } from './tax_engine.js'

// Synthetic figures only. Expected values were computed independently
// (days × underpayment / 365 × 7%, each cell rounded) — not read back from the code.
describe('calc2220 (2025 regular installment method)', () => {
  const base = { tax_year: 2025, total_tax: 40_000, prior_year_tax: 100_000 }

  it('uses the smaller of this year and last year, 25% per installment', () => {
    const r = calc2220(base)
    expect(r.L5).toBe(40_000)
    expect(r.L10).toEqual([10_000, 10_000, 10_000, 10_000])
    expect(r.L9).toEqual(['04/15/2025', '06/15/2025', '09/15/2025', '12/15/2025'])
  })

  it('no payments: every installment underpaid to the 15th day of the 4th month', () => {
    const r = calc2220(base)
    expect(r.L17).toEqual([10_000, 10_000, 10_000, 10_000])
    expect(r.L14).toEqual([null, 10_000, 20_000, 30_000])
    expect(r.L16).toEqual([null, 10_000, 20_000])
    expect(r.L19).toEqual(['04/15/2026', '04/15/2026', '04/15/2026', '04/15/2026'])
    expect(r.L20).toEqual([365, 304, 212, 121])
    expect(r.periods[0].days).toEqual([76, 15, 0, 0])
    expect(r.periods[2].days).toEqual([92, 92, 92, 16])
    expect(r.periods[4].days).toEqual([15, 15, 15, 15])
    // cells are rounded one by one, then added
    expect(r.L37).toEqual([671, 554, 378, 204])
    expect(r.L38).toBe(1807)
  })

  it('the "*%" periods default to 0 and take caller rates', () => {
    expect(calc2220(base).periods[4].penalty).toEqual([0, 0, 0, 0])
    const r = calc2220({ ...base, later_rates: [0.07] })
    // 10,000 × 15/365 × 7% = 28.77 → 29 per column
    expect(r.periods[4].penalty).toEqual([29, 29, 29, 29])
  })

  it('a late payment stops the penalty on the installment it cures', () => {
    const r = calc2220({ ...base, payments: [{ date: '2025-05-15', amount: 10_000 }] })
    expect(r.L19[0]).toBe('05/15/2025')
    expect(r.L20[0]).toBe(30)
    expect(r.L37[0]).toBe(58)
  })

  it('under $500 of tax: not required, no penalty', () => {
    const r = calc2220({ tax_year: 2025, total_tax: 499, prior_year_tax: 0 })
    expect(r.required).toBe(false)
    expect(r.L38).toBe(0)
  })

  it('refuses a year whose rate periods it does not know', () => {
    expect(() => calc2220({ ...base, tax_year: 2024 })).toThrow(TaxInputError)
  })
})

describe('calc1120 line 34', () => {
  const inputs: any = {
    gross_receipts: 1_000_000, salaries_wages: 809_524, estimated_tax_paid: 0, tax_year: 2025,
  }
  it('adds the Form 2220 penalty to line 34 and the balance due', () => {
    const r = calc1120({ ...inputs, form2220: { prior_year_tax: 100_000 } })
    // TI 190,476 → tax 40,000 (rounded) → same synthetic penalty as above
    expect(r.computed.total_tax).toBe(40_000)
    expect(r.field_values!['payments.L34_est_penalty']).toBe(1807)
    expect(r.field_values!['payments.L35_amount_owed']).toBe(41_807)
  })
  it('takes a stated penalty when no Form 2220 inputs are given', () => {
    const r = calc1120({ ...inputs, estimated_tax_penalty: 250 })
    expect(r.field_values!['payments.L34_est_penalty']).toBe(250)
    expect(r.field_values!['payments.L35_amount_owed']).toBe(40_250)
  })
  it('line 34 stays 0 without either', () => {
    const r = calc1120(inputs)
    expect(r.field_values!['payments.L34_est_penalty']).toBe(0)
    expect(r.field_values!['payments.L35_amount_owed']).toBe(40_000)
  })
})
