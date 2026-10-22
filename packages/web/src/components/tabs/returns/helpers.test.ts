import { describe, it, expect } from 'vitest'
import { groupByYear, booksAgreement, bestBase } from './helpers'
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

  it('a year filed only as a catalogued PDF gets a row; transcript-only years do not', () => {
    const f = (tax_year: number, filed: boolean) => ({ tax_year, filed: filed ? { via: 'catalog' as const, catalog_id: 'c' } : null, accepted: false, accepted_why: '', extended: false, due: '', extended_due: '' })
    const grouped = groupByYear([r({ tax_year: 2025, source: 'proforma' })], [f(2025, true), f(2024, true), f(2019, false)])
    expect(grouped.map(g => g.year)).toEqual([2025, 2024])
    expect(grouped[0].proforma && grouped[0].filing?.filed).toBeTruthy()
    expect(grouped[1].filed).toBeUndefined()
    expect(grouped[1].filing?.filed?.via).toBe('catalog')
  })
})

describe('booksAgreement', () => {
  const row = (key: string, ret?: number, books?: number) => ({
    form: 'f1120s', key, label: key, section: '', line: '', status: 'agrees' as const,
    ...(ret !== undefined ? { returns: { 'amendment 10/22 (abcd1234)': { value: ret, where: '' } } } : {}),
    ...(books !== undefined ? { books: { value: books, where: '' } } : {}),
  })
  const view = (rows: ReturnType<typeof row>[], books: any = { lines: 4 }) => ({
    sources: { filed_return: null, irs_return_transcript: null, returns: [{ id: 'abcd1234-0000', label: 'amendment 10/22 (abcd1234)' }], books, scenarios: [] },
    rows,
  })
  it('lists the lines where the amendment and the books differ by more than $1', () => {
    const a = booksAgreement(view([row('a', 100, 100.5), row('b', 50, 70), row('c', 5), row('d', undefined, 9)]), 'abcd1234-0000')
    expect(a).toMatchObject({ available: true, compared: 2 })
    expect(a.differ.map(r => r.key)).toEqual(['b'])
  })
  it('says so when there are no books', () => {
    expect(booksAgreement(view([], { available: false, why: 'not connected' }), 'abcd1234-0000')).toMatchObject({ available: false, why: 'not connected' })
  })
})

describe('bestBase', () => {
  it('prefers the filed return, then the latest amendment, then the draft', () => {
    const filed = r({ tax_year: 2024, source: 'filed_import' })
    const amend = r({ tax_year: 2024, source: 'amendment', computed_at: '2026-01-01' })
    const draft = r({ tax_year: 2024, source: 'proforma' })
    expect(bestBase([draft, amend, filed], 2024, '1120S')).toBe(filed)
    expect(bestBase([draft, amend], 2024, '1120S')).toBe(amend)
    expect(bestBase([draft, r({ tax_year: 2024, source: 'extension' })], 2024, '1120S')).toBe(draft)
    expect(bestBase([filed], 2023, '1120S')).toBeUndefined()
  })
})

