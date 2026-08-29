import { describe, it, expect } from 'vitest'
import { groupByYear } from './helpers'
import type { TaxReturn } from '@taxengine/shared'

const r = (over: Partial<TaxReturn>): TaxReturn => ({
  id: Math.random().toString(36).slice(2),
  entity_id: 'e1',
  tax_year: 2024,
  form_type: '1120S',
  status: 'computed',
  ...over,
})

describe('groupByYear', () => {
  it('slots each source and sorts years descending', () => {
    const grouped = groupByYear([
      r({ tax_year: 2023, source: 'filed_import' }),
      r({ tax_year: 2024, source: 'proforma' }),
      r({ tax_year: 2024, source: 'amendment', computed_at: '2025-01-01' }),
      r({ tax_year: 2024, source: 'extension' }),
    ])
    expect(grouped.map(g => g.year)).toEqual([2024, 2023])
    expect(grouped[0].proforma).toBeTruthy()
    expect(grouped[0].amendments).toHaveLength(1)
    expect(grouped[0].extensions).toHaveLength(1)
    expect(grouped[1].filed).toBeTruthy()
  })

  it('keeps the latest filed/proforma by computed_at', () => {
    const older = r({ source: 'filed_import', computed_at: '2025-01-01' })
    const newer = r({ source: 'filed_import', computed_at: '2025-06-01' })
    expect(groupByYear([older, newer])[0].filed).toBe(newer)
    expect(groupByYear([newer, older])[0].filed).toBe(newer)
  })

  it('with missing computed_at on both, keeps the first seen (order-dependent — documented)', () => {
    const a = r({ source: 'proforma' })
    const b = r({ source: 'proforma' })
    expect(groupByYear([a, b])[0].proforma).toBe(a)
  })

  it('sorts amendments newest first and preserves duplicates', () => {
    const g = groupByYear([
      r({ source: 'amendment', computed_at: '2025-01-01' }),
      r({ source: 'amendment', computed_at: '2025-03-01' }),
      r({ source: 'amendment', computed_at: '2025-02-01' }),
    ])[0]
    expect(g.amendments.map(a => a.computed_at)).toEqual(['2025-03-01', '2025-02-01', '2025-01-01'])
  })
})
