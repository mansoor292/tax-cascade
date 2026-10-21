import { describe, it, expect } from 'vitest'
import { formTitle, lineRef, shortLabel, sourceLabel, availableSources, cellOf, versusBase, chooseSources, inFormOrder } from './sources'
import type { GoldenRow, GoldenView } from '@/hooks/use-golden'

const row = (p: Partial<GoldenRow>): GoldenRow => ({ form: 'f1120s', key: 'k', label: '', section: '', line: '22', status: 'agrees', ...p })

const sources = (over: Partial<GoldenView['sources']> = {}): Pick<GoldenView, 'sources'> => ({
  sources: {
    filed_return: { catalog_id: 'c1', filename: 'f.pdf' },
    irs_return_transcript: { catalog_id: 'c2', type: 'return', as_of: '2026-10-20' },
    returns: [{ id: '8b813d2d-0000', label: 'filed_import 2026-04-26 (8b813d2d)' }, { id: '815a9144-0000', label: 'proforma 2026-10-15 (815a9144)' }],
    books: { lines: 33, pnl_as_of: '2026-10-20' },
    scenarios: [{ id: 'aaaa1111-0000', label: 'Pay officer more' }],
    documents: { count: 3, types: ['1099_int'], lines: 3, k1s_from_group_returns: [], unplaced: [], notes: [] },
    ...over,
  },
})
const S = (id: string) => availableSources(sources()).find(s => s.id === id)!

describe('all-sources view helpers', () => {
  it('names forms the way they are printed', () => {
    expect(formTitle('f1120s')).toBe('1120-S')
    expect(formTitle('f1125a')).toBe('1125-A')
    expect(formTitle('f1040se')).toBe('Schedule E')
    expect(formTitle('f4562')).toBe('4562')
    expect(lineRef({ form: 'f1120s', section: 'Schedule L', line: '24', col: 'd' })).toBe('1120-S Schedule L line 24 (d)')
    expect(lineRef({ form: 'f1040se', section: 'Part II', line: '32', instance: '#2' })).toBe('Schedule E Part II line 32 · copy 2')
    expect(lineRef({ form: 'f1120ssk', section: 'Part III', line: '1', instance: 'k1:1' })).toBe('Schedule K-1 (1120-S) Part III line 1 · K-1 1')
  })

  it('shortens the IRS description and the source labels', () => {
    expect(shortLabel('Ordinary business income (loss). Subtract line 21 from line 6')).toBe('Ordinary business income (loss)')
    expect(shortLabel('Dividends: a. Ordinary dividends')).toBe('Dividends: a. Ordinary dividends')
    expect(shortLabel('Taxable interest. Attach Sch. B if required')).toBe('Taxable interest')
    expect(sourceLabel('proforma 2026-10-15 (815a9144)')).toBe('Proforma 10/15/2026')
    expect(sourceLabel('filed_import 2026-10-14 (0a1b2c3d)')).toBe('Filed import 10/14/2026')
  })

  it('lists only the sources the year has, in a fixed order', () => {
    expect(availableSources(sources()).map(s => s.id)).toEqual(['filed', 'irs', 'books', 'documents', 'ret:8b813d2d', 'ret:815a9144', 'sc:aaaa1111'])
    expect(availableSources(sources({ books: { available: false, why: 'not connected' }, documents: { count: 0, types: [], lines: 0, k1s_from_group_returns: [], unplaced: [], notes: [] }, irs_return_transcript: null })).map(s => s.id))
      .toEqual(['filed', 'ret:8b813d2d', 'ret:815a9144', 'sc:aaaa1111'])
    expect(S('ret:815a9144').name).toBe('Proforma 10/15/2026')
  })

  it('the IRS column falls back to the IRS calculation, marked, and books totals carry Σ', () => {
    expect(cellOf(row({ irs_computed: { value: 5171913, where: '' } }), S('irs'))).toMatchObject({ value: 5171913, mark: '¹' })
    expect(cellOf(row({ irs: { value: 10, where: '' }, irs_computed: { value: 12, where: '' } }), S('irs'))).toMatchObject({ value: 10, note: 'IRS calc $12' })
    expect(cellOf(row({ books: { value: 922200, where: '', summed: true } }), S('books'))).toMatchObject({ value: 922200, mark: 'Σ' })
    expect(cellOf(row({ returns: { 'proforma 2026-10-15 (815a9144)': { value: 7, where: '' } } }), S('ret:815a9144')).value).toBe(7)
  })

  it('measures a row against the base; a blank is not a difference', () => {
    const base = S('filed'), others = [S('irs'), S('books')]
    expect(versusBase(row({ filed: { value: 100, where: '' }, irs: { value: 100, where: '' }, books: { value: 100.5, where: '' } }), base, others).state).toBe('matches')
    const d = versusBase(row({ filed: { value: 100, where: '' }, irs: { value: 100, where: '' }, books: { value: 150, where: '' } }), base, others)
    expect(d.state).toBe('differs')
    expect(d.differ.map(s => s.id)).toEqual(['books'])
    expect(versusBase(row({ filed: { value: 600000, where: '' } }), base, others).state).toBe('only_base')
    expect(versusBase(row({ filed: { value: 0, where: '' } }), base, others).state).toBe('none')
    expect(versusBase(row({ irs: { value: 3070386, where: '' } }), base, others).state).toBe('not_in_base')
    expect(versusBase(row({ irs: { value: 0, where: '' } }), base, others).state).toBe('none')
    // a source not chosen says nothing
    expect(versusBase(row({ scenarios: { 'Pay officer more': { value: 5, where: '' } } }), base, others).state).toBe('none')
  })

  it('defaults to the filed return against the IRS and the books, or the documents', () => {
    const all = availableSources(sources())
    expect(chooseSources(all, {})).toMatchObject({ base: { id: 'filed' }, others: [{ id: 'irs' }, { id: 'books' }] })
    const noBooks = availableSources(sources({ books: null }))
    expect(chooseSources(noBooks, {}).others.map(s => s.id)).toEqual(['irs', 'documents'])
    // the URL wins when it names sources this year has; the base is never also compared
    const picked = chooseSources(all, { base: 'ret:815a9144', with: 'filed,sc:aaaa1111,ret:815a9144,nope' })
    expect(picked.base?.id).toBe('ret:815a9144')
    expect(picked.others.map(s => s.id)).toEqual(['filed', 'sc:aaaa1111'])
    expect(chooseSources(all, { base: 'gone', with: '' })).toMatchObject({ base: { id: 'filed' }, others: [] })
    expect(chooseSources([], {}).base).toBeUndefined()
  })

  it('orders rows as the form prints them', () => {
    const rows = [
      row({ form: 'f1120s', section: 'Schedule L', line: '15', col: 'd' }),
      row({ form: 'f1125a', line: '8' }),
      row({ form: 'f1120s', line: '22' }),
      row({ form: 'f1120s', section: 'Schedule K', line: '16d' }),
      row({ form: 'f1120s', line: '1b' }),
      row({ form: 'f1120s', line: 'F' }),
      row({ form: 'f1120s', line: '1a' }),
      row({ form: 'f1120s', section: 'Schedule L', line: '15', col: 'b' }),
      row({ form: 'f1120s', line: '2' }),
    ]
    expect(inFormOrder(rows, '1120S').map(r => `${r.form} ${r.section} ${r.line}${r.col ?? ''}`)).toEqual([
      'f1120s  F', 'f1120s  1a', 'f1120s  1b', 'f1120s  2', 'f1120s  22',
      'f1120s Schedule K 16d', 'f1120s Schedule L 15b', 'f1120s Schedule L 15d', 'f1125a  8',
    ])
    const r1040 = [row({ form: 'f7203', section: 'Part I', line: '6' }), row({ form: 'f1040se', section: 'Part II', line: '32' }), row({ form: 'f1040s1', section: 'Part I', line: '5' }), row({ form: 'f1040', line: '11' }), row({ form: 'f1040sd', section: 'Part III', line: '16' }), row({ form: 'f1040sd', section: 'Part II', line: '15' })]
    expect(inFormOrder(r1040, '1040').map(r => `${r.form} ${r.line}`)).toEqual(['f1040 11', 'f1040s1 5', 'f1040sd 15', 'f1040sd 16', 'f1040se 32', 'f7203 6'])
  })
})

