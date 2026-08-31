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

import { diffLine } from './helpers'

/**
 * Pins the false-amendment bug: a 1040-X restates only totals and changed
 * lines, so a line absent from the amendment means "not restated" — it must
 * never render as a change to zero. Reported with $259,008 of W-2 wages the
 * amendment never mentioned showing as a -$259,008 "change".
 */
describe('diffLine — absent from the amendment is not a change to zero', () => {
  it('filed value with no amendment value → not restated, no delta', () => {
    expect(diffLine(259_008, undefined)).toEqual({ delta: null, notRestated: true })
  })

  it('a line the amendment states that the original lacked IS a change', () => {
    expect(diffLine(undefined, 5_000)).toEqual({ delta: 5_000, notRestated: false })
  })

  it('an explicit zero on the amendment IS a change to zero', () => {
    expect(diffLine(10_000, 0)).toEqual({ delta: -10_000, notRestated: false })
  })

  it('both stated → plain delta', () => {
    expect(diffLine(250_110, 252_110)).toEqual({ delta: 2_000, notRestated: false })
  })
})
