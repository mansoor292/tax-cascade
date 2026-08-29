import { describe, it, expect } from 'vitest'
import { collectValues, humanize, sectionOf, sortKey } from './helpers'
import type { TaxReturn } from '@taxengine/shared'

describe('collectValues', () => {
  it('keeps only numeric field_values entries', () => {
    const ret = {
      id: 'x', entity_id: 'e', tax_year: 2024, form_type: '1120', status: 'ok',
      field_values: { 'tax.L31_total_tax': 100, 'meta.entity_name': 'Acme', 'income.nan': NaN },
    } as unknown as TaxReturn
    expect(collectValues(ret)).toEqual({ 'tax.L31_total_tax': 100 })
    expect(collectValues(undefined)).toEqual({})
  })
})

describe('humanize', () => {
  it('drops the section prefix and underscores', () => {
    expect(humanize('income.L1a_gross_receipts')).toBe('L1a gross receipts')
    expect(humanize('nosection')).toBe('nosection')
  })
})

describe('sectionOf / sortKey', () => {
  it('maps known prefixes and falls back to other', () => {
    expect(sectionOf('income.L1')).toBe('income')
    expect(sectionOf('mystery.L1')).toBe('other')
  })
  it('orders by canonical section then key, unknown sections last', () => {
    const keys = ['schedL.L1', 'income.L1', 'mystery.L9', 'income.L2']
    expect([...keys].sort(sortKey)).toEqual(['income.L1', 'income.L2', 'schedL.L1', 'mystery.L9'])
  })
})
