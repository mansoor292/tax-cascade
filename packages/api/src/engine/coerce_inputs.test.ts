import { describe, it, expect } from 'vitest'
import { calc1040, calc1120, calc1120S, coerceInputs, TaxInputError, MAX_TAX_AMOUNT } from './tax_engine.js'

/**
 * Numeric inputs arriving as strings.
 *
 * Found by sweeping the deployed API with malformed input rather than by a
 * report. POST /api/returns/compute with wages:"150000" — a plain digit
 * string, which is what an HTML number field and an LLM tool call both
 * produce — answered HTTP 200 with no warning and an AGI of
 * $150,000,000,000,000.
 *
 * TypeScript's `number` is erased at runtime, so the string reached the
 * income summation intact and `+` concatenated instead of adding:
 *
 *     "150000" + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 0  ->  "150000000000000"
 *
 * The subsequent `-` coerced that back to a number, so the result looked
 * like an ordinary figure — six orders of magnitude wrong, silently, on a
 * saved return. These tests pin the boundary for all three forms.
 */
describe('numeric coercion at the engine boundary', () => {
  it('a digit string produces the same return as the number', () => {
    const asNumber = calc1040({ wages: 150000, filing_status: 'single', tax_year: 2024 } as any)
    const asString = calc1040({ wages: '150000', filing_status: 'single', tax_year: 2024 } as any)
    expect(asString.computed.agi).toBe(asNumber.computed.agi)
    expect(asString.computed.total_tax).toBe(asNumber.computed.total_tax)
  })

  it('the regression itself: string wages must not inflate AGI', () => {
    const { computed } = calc1040({ wages: '150000', filing_status: 'single', tax_year: 2024 } as any)
    expect(computed.agi).toBe(150000)
    // The old behaviour, stated explicitly so it can never come back quietly.
    expect(computed.agi).not.toBe(150000000000000)
  })

  it('accepts the currency formatting people actually paste', () => {
    const { computed } = calc1040({ wages: '$150,000', filing_status: 'single', tax_year: 2024 } as any)
    expect(computed.agi).toBe(150000)
  })

  it('concatenation cannot survive across several string income lines', () => {
    const mixed = calc1040({
      wages: '100000', taxable_interest: '5000', ordinary_dividends: 2000,
      filing_status: 'single', tax_year: 2024,
    } as any)
    expect(mixed.computed.agi).toBe(107000)
  })

  it('rejects a value that is not a number instead of computing nonsense', () => {
    expect(() => calc1040({ wages: 'lots', filing_status: 'single', tax_year: 2024 } as any))
      .toThrow(TaxInputError)
  })

  it('rejects NaN and Infinity', () => {
    expect(() => calc1040({ wages: NaN, tax_year: 2024 } as any)).toThrow(TaxInputError)
    expect(() => calc1040({ wages: Infinity, tax_year: 2024 } as any)).toThrow(TaxInputError)
  })

  it('rejects an unknown filing status rather than crashing later', () => {
    expect(() => calc1040({ wages: 1000, filing_status: 'banana', tax_year: 2024 } as any))
      .toThrow(TaxInputError)
  })

  it('treats a missing value as the default, not as an error', () => {
    const { computed } = calc1040({ wages: 50000, taxable_interest: null, filing_status: 'single', tax_year: 2024 } as any)
    expect(computed.agi).toBe(50000)
  })

  it('the string "false" stays false', () => {
    // Left uncoerced this is a truthy string, which would silently switch a
    // return to itemized deductions.
    const out = coerceInputs({ use_itemized: false, wages: 0 }, { use_itemized: 'false' })
    expect(out.use_itemized).toBe(false)
    expect(coerceInputs({ use_itemized: false }, { use_itemized: 'true' }).use_itemized).toBe(true)
  })

  it('guards the corporate forms too', () => {
    const s = calc1120S({ gross_receipts: '500000', tax_year: 2024 } as any)
    const c = calc1120({ gross_receipts: '500000', tax_year: 2024 } as any)
    expect(s.computed.total_income).toBe(500000)
    expect(c.computed.total_income).toBe(500000)
    expect(() => calc1120({ gross_receipts: 'plenty', tax_year: 2024 } as any)).toThrow(TaxInputError)
  })

  it('refuses an amount too large to be a real figure', () => {
    // Finite is not the same as plausible: wages of 1e308 used to compute a
    // tax of 3.79e307 — arithmetically consistent and completely meaningless.
    expect(() => calc1040({ wages: 1e308, filing_status: 'single', tax_year: 2024 } as any))
      .toThrow(TaxInputError)
    expect(() => calc1040({ wages: MAX_TAX_AMOUNT * 10, filing_status: 'single', tax_year: 2024 } as any))
      .toThrow(TaxInputError)
  })

  it('still accepts a large but genuinely possible amount', () => {
    const { computed } = calc1040({ wages: 50_000_000, filing_status: 'single', tax_year: 2024 } as any)
    expect(computed.agi).toBe(50_000_000)
  })

  it('applies the ceiling to string input too', () => {
    expect(() => calc1040({ wages: '99999999999999', filing_status: 'single', tax_year: 2024 } as any))
      .toThrow(TaxInputError)
  })

  it('names the offending field so the caller can fix it', () => {
    try {
      calc1040({ wages: 'lots', tax_year: 2024 } as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.name).toBe('TaxInputError')
      expect(e.field).toBe('wages')
      expect(e.message).toContain('wages')
    }
  })
})
