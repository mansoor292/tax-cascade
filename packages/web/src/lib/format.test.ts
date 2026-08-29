import { describe, it, expect } from 'vitest'
import { fmtMoney, fmtMoneyCompact, fmtDelta, fmtDate, coerceNumericInputs } from './format'

describe('fmtMoney', () => {
  it('formats positives and negatives with separators', () => {
    expect(fmtMoney(1234)).toBe('$1,234')
    expect(fmtMoney(-1234)).toBe('-$1,234')
    expect(fmtMoney(0)).toBe('$0')
  })
  it('renders emptyText for null/undefined/NaN, passes strings through', () => {
    expect(fmtMoney(null)).toBe('')
    expect(fmtMoney(undefined, '—')).toBe('—')
    expect(fmtMoney(NaN, '—')).toBe('—')
    expect(fmtMoney('pending')).toBe('pending')
  })
})

describe('fmtMoneyCompact', () => {
  it('abbreviates thousands with one decimal below $100k', () => {
    expect(fmtMoneyCompact(1234)).toBe('$1.2k')
    expect(fmtMoneyCompact(150_000)).toBe('$150k')
    expect(fmtMoneyCompact(-1234)).toBe('-$1.2k')
    expect(fmtMoneyCompact(999)).toBe('$999')
    expect(fmtMoneyCompact(null)).toBe('—')
  })
})

describe('fmtDelta', () => {
  it('signs deltas and honors zeroText', () => {
    expect(fmtDelta(500)).toBe('+$500')
    expect(fmtDelta(-500)).toBe('-$500')
    expect(fmtDelta(0)).toBe('—')
    expect(fmtDelta(0, '±$0')).toBe('±$0')
    expect(fmtDelta(null)).toBe('—')
  })
})

describe('fmtDate', () => {
  it('pins ISO dates to UTC so western timezones do not shift a day', () => {
    // The documented bug: new Date('2025-03-15') is UTC midnight, which
    // toLocaleDateString renders as Mar 14 west of Greenwich.
    expect(fmtDate('2025-03-15')).toMatch(/Mar 15, 2025/)
    expect(fmtDate('2025-01-01')).toMatch(/Jan 1, 2025/)
  })
})

describe('coerceNumericInputs', () => {
  it('coerces numeric strings and preserves non-numeric values', () => {
    expect(coerceNumericInputs({ a: '100', b: 'Jane Doe', c: '' })).toEqual({
      a: 100,
      b: 'Jane Doe',
      c: 0, // Number('') === 0 — documented quirk of the historical loops
    })
  })
  it('keeps dashed identifiers as strings (dropping them loses required fields)', () => {
    expect(coerceNumericInputs({ ssn: '123-45-6789' })).toEqual({ ssn: '123-45-6789' })
  })
})
