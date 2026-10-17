import { describe, it, expect } from 'vitest'
import { filterEntries, cite, formMatches, type CatalogSource } from './query.js'
import type { CatalogEntry } from './types.js'

function e(p: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: p.id ?? Math.random().toString(36).slice(2), form: 'f1120s', title: 'Form 1120-S', rev: '2023', instance: '',
    page: 1, section: '', line: '', label: '', desc: '', kind: 'amount', value: 0, raw: '0', method: 'geometry', ...p,
  }
}

const SOURCES: CatalogSource[] = [
  {
    catalog_id: 'c2023', tax_year: 2023, entries: [
      e({ line: '22', label: 'Ordinary business income (loss)', value: 3044422, raw: '3,044,422.', canonical: 'tax.L22_ordinary_income' }),
      e({ page: 4, section: 'Schedule L', line: '19', col: 'd', label: 'Loans from shareholders — End of tax year. (d)', value: 1040000, raw: '1,040,000.' }),
      e({ page: 4, section: 'Schedule L', line: '19', col: 'b', label: 'Loans from shareholders — Beginning of tax year. (b)', value: 3000, raw: '3,000.' }),
      e({ form: 'f1120ssk', title: 'Form 1120-S Schedule K-1', page: 9, section: 'Part III', line: '1', label: 'Ordinary business income (loss)', value: 3044422, raw: '3,044,422.' }),
      e({ page: 2, section: 'Schedule B', line: '1', kind: 'check', value: true, raw: 'X', label: 'Check accounting method: a. Cash' }),
      e({ page: 30, instance: 'copy2', line: '22', value: 3044422, raw: '3,044,422.' }),
      e({ form: 'statement', title: 'Statement or worksheet', page: 12, section: 'Form 1120S Other Deductions', line: '4', kind: 'row', label: 'Professional fees', value: 12000, raw: 'Professional fees 12,000.' }),
    ],
  },
  { catalog_id: 'c2024', tax_year: 2024, entries: [e({ rev: '2024', line: '22', label: 'Ordinary business income (loss)', value: 162007, raw: '162,007.' })] },
]

describe('catalog query', () => {
  it('finds a line across years, skipping printed copies', () => {
    const hits = filterEntries(SOURCES, { forms: ['1120-S'], line: '22' })
    expect(hits.map(h => [h.tax_year, h.value])).toEqual([[2023, 3044422], [2024, 162007]])
  })

  it('section + line + column pins one Schedule L box', () => {
    const [h, ...rest] = filterEntries(SOURCES, { years: [2023], section: 'schedule l', line: '19', col: 'd' })
    expect(rest).toHaveLength(0)
    expect(h.value).toBe(1040000)
    expect(cite(h)).toBe('2023 Form 1120-S, Schedule L, line 19, column (d) (page 4)')
  })

  it('"1120-S" does not drag in the K-1; "K-1" finds it', () => {
    expect(filterEntries(SOURCES, { forms: ['1120-S'], line: '1', kinds: ['amount'] })).toHaveLength(0)
    expect(filterEntries(SOURCES, { forms: ['K-1'], line: '1' })[0].value).toBe(3044422)
  })

  it('text search spans label, description and printed text', () => {
    expect(filterEntries(SOURCES, { text: 'professional fees' })[0].value).toBe(12000)
    expect(filterEntries(SOURCES, { text: 'accounting method cash' })[0].value).toBe(true)
  })

  it('copies on request; canonical keys exact or by prefix', () => {
    expect(filterEntries(SOURCES, { line: '22', include_copies: true, years: [2023], forms: ['f1120s'] })).toHaveLength(2)
    expect(filterEntries(SOURCES, { canonical: 'tax.' })).toHaveLength(1)
  })

  it('form matching', () => {
    expect(formMatches({ form: 'f8960', title: 'Form 8960' }, '8960')).toBe(true)
    expect(formMatches({ form: 'f1040se', title: 'Form 1040 Schedule E' }, 'Schedule E')).toBe(true)
  })
})
