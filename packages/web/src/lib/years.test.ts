import { describe, it, expect } from 'vitest'
import { filingYear, TAX_YEARS } from './years'

describe('filingYear', () => {
  it('opens on last calendar year — the year being prepared', () => {
    expect(filingYear(TAX_YEARS, new Date('2026-10-22'))).toBe(2025)
    expect(filingYear(TAX_YEARS, new Date('2025-03-01'))).toBe(2024)
  })
  it('never offers a year the picker does not list', () => {
    expect(filingYear([2025, 2024], new Date('2028-01-05'))).toBe(2025)
    expect(filingYear([2025, 2024], new Date('2020-01-05'))).toBe(2024)
  })
})
