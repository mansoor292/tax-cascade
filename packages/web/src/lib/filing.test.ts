import { describe, it, expect } from 'vitest'
import { filingCounts, type YearFiling } from './filing'

const y = (tax_year: number, filed: boolean, accepted: boolean): YearFiling => ({
  tax_year, filed: filed ? { via: 'catalog', catalog_id: 'c' } : null, accepted, accepted_why: '', extended: false, due: '', extended_due: '',
})

describe('filingCounts', () => {
  it('counts filed entity-years and the accepted ones among them', () => {
    expect(filingCounts([
      { years: [y(2025, true, false), y(2024, true, true), y(2019, false, false)] },
      { years: [y(2025, true, true)] },
    ])).toEqual({ filed: 3, accepted: 2 })
  })
})
