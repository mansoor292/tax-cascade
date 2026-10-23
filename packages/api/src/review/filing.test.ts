/**
 * Filed and accepted (2026-10-22), on synthetic transcripts shaped like the
 * Edgewater story: a 2025 return filed but not yet on any transcript, the
 * 2024 period holding the 2023 return, the 2025 period holding the 2024
 * return, and a 2023 return posted correctly on its second sending.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo } from './types.js'
import { yearFilings } from './filing.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return { id: `i${++n}`, form, title: form, rev: '2024', instance: '', page: 1, section: '', line: '', label: '', desc: '', kind: 'amount', value: 0, raw: '', method: 'geometry', ...p }
}
const cat = (id: string, year: number, entries: CatalogEntry[], kind: CatalogView['kind'], extra: Partial<CatalogView> = {}): CatalogView =>
  ({ id, kind, tax_year: year, status: 'complete', entries, ...extra })
const ret = (year: number, ti: number) => cat(`r${year}`, year, [e('f1120s', { line: '22', value: ti, raw: String(ti) })], 'filed_return', { source_filename: `S_${year}_1120S.pdf` })
const tx = (code: string, label: string, date: string) => e('irs_transcript', { section: 'Transactions', line: code, label, date, value: 0, raw: label })
const tr = (year: number, o: { ti?: number; asOf?: string; txs?: CatalogEntry[] }) => cat(`t${year}`, year, [
  e('irs_transcript', { section: 'Header', line: 'Response Date', kind: 'text', value: o.asOf ?? '10-20-2026', raw: '' }),
  ...(o.ti !== undefined ? [e('irs_transcript', { section: 'Return information', line: 'Taxable Income', value: o.ti, raw: `Taxable Income ${o.ti}` })] : []),
  ...(o.txs ?? []),
], 'irs_transcript', { transcript_type: 'account' })
const scorp: EntityInfo = { id: 's', name: 'Example S Corp', form_type: '1120S', entity_type: 's_corp' }
const today = new Date('2026-10-22T00:00:00Z')
const by = (rows: ReturnType<typeof yearFilings>) => new Map(rows.map(r => [r.tax_year, r]))

describe('filed and accepted', () => {
  it('a filed PDF in the catalog is filed; with no transcript it is not accepted', () => {
    const y = by(yearFilings(scorp, [ret(2025, 100)], [], today)).get(2025)!
    expect(y.filed).toMatchObject({ via: 'catalog', catalog_id: 'r2025', filename: 'S_2025_1120S.pdf' })
    expect(y.accepted).toBe(false)
    expect(y.accepted_why).toMatch(/No 2025 IRS account transcript/)
  })

  it('a transcript that predates the return keeps it unaccepted', () => {
    const y = by(yearFilings(scorp, [ret(2025, 100), tr(2025, { txs: [tx('460', 'Extension of time to file', '03-16-2026')] })], [], today)).get(2025)!
    expect(y.accepted).toBe(false)
    expect(y.accepted_why).toMatch(/shows no return processed yet/)
    expect(y.extended).toBe(true)
  })

  it('a TC150 for this return accepts it — for an imported row too', () => {
    const cats = [ret(2022, 500), tr(2022, { ti: 500, txs: [tx('150', 'Tax return filed', '09-20-2023')] })]
    expect(by(yearFilings(scorp, cats, [], today)).get(2022)).toMatchObject({ accepted: true })
    const imported = yearFilings(scorp, [tr(2021, { txs: [tx('150', 'Tax return filed', '09-20-2022')] })],
      [{ id: 'row21', tax_year: 2021, source: 'filed_import', form_type: '1120S' }], today)
    expect(by(imported).get(2021)).toMatchObject({ filed: { via: 'import', return_id: 'row21' }, accepted: true })
  })

  it('a period holding another year\'s return accepts neither; the posted period is named', () => {
    const cats = [
      ret(2023, 3000), ret(2024, 160), ret(2025, 900),
      tr(2023, { ti: 3000, txs: [tx('150', 'Tax return filed', '01-26-2026')] }),
      tr(2024, { ti: 3000, txs: [tx('150', 'Tax return filed', '12-29-2025')] }),
      tr(2025, { ti: 160, txs: [tx('150', 'Tax return filed', '02-09-2026')] }),
    ]
    const y = by(yearFilings(scorp, cats, [], today))
    expect(y.get(2023)).toMatchObject({ accepted: true, posted_in: 2024 })
    expect(y.get(2024)).toMatchObject({ accepted: false, holds_return_of: 2023, posted_in: 2025 })
    expect(y.get(2025)).toMatchObject({ accepted: false, holds_return_of: 2024 })
    expect(y.get(2025)!.accepted_why).toMatch(/processed the 2024 return in the 2025 period/)
  })

  it('no filed return is never accepted, whatever the transcript says', () => {
    const y = by(yearFilings(scorp, [tr(2020, { ti: 5, txs: [tx('150', 'Tax return filed', '06-15-2021')] })], [], today)).get(2020)!
    expect(y).toMatchObject({ filed: null, accepted: false })
  })

  describe('amendments (2026-10-23): filed once the signed copy is on file, accepted by a TC977', () => {
    const amended = (id: string, year: number, returnId: string) =>
      cat(id, year, [], 'amended_return', { return_id: returnId, document_id: `doc-${id}`, source_filename: `S_${year}_1120S_amended.pdf` })
    const rows = [
      { id: 'a1', tax_year: 2023, source: 'amendment', form_type: '1120S', status: 'filed', filed_at: '2026-03-02T00:00:00Z' },
      { id: 'a2', tax_year: 2023, source: 'amendment', form_type: '1120S', status: 'filed', filed_at: '2026-08-10T00:00:00Z' },
      { id: 'draft', tax_year: 2023, source: 'amendment', form_type: '1120S', status: 'computed' },
    ]
    const base = [ret(2023, 3000), amended('c1', 2023, 'a1'), amended('c2', 2023, 'a2')]

    it('only an amendment recorded as filed is listed, with its copy', () => {
      const y = by(yearFilings(scorp, base, rows, today)).get(2023)!
      expect(y.amendments!.map(a => a.return_id)).toEqual(['a1', 'a2'])
      expect(y.amendments![0].copy).toEqual({ catalog_id: 'c1', document_id: 'doc-c1', filename: 'S_2023_1120S_amended.pdf' })
      expect(y.amendments!.every(a => !a.accepted)).toBe(true)
      expect(y.amendments![0].accepted_why).toMatch(/No 2023 IRS account transcript/)
    })

    it('the amended copy never stands in for the return as filed', () => {
      const y = by(yearFilings(scorp, [amended('c1', 2023, 'a1')], rows, today)).get(2023)!
      expect(y.filed).toBeNull()
    })

    it('a transcript without a TC977 keeps it unaccepted; each TC977 accepts the next amendment filed', () => {
      const original = tx('150', 'Tax return filed', '09-20-2024')
      const none = by(yearFilings(scorp, [...base, tr(2023, { ti: 3000, txs: [original] })], rows, today)).get(2023)!
      expect(none.accepted).toBe(true)
      expect(none.amendments!.map(a => a.accepted)).toEqual([false, false])
      expect(none.amendments![0].accepted_why).toMatch(/shows no amended return processed yet \(no TC977\)/)

      const one = by(yearFilings(scorp, [...base, tr(2023, { ti: 3000, txs: [original, tx('977', 'Amended tax return or claim forwarded for processing', '05-11-2026')] })], rows, today)).get(2023)!
      expect(one.amendments!.map(a => a.accepted)).toEqual([true, false])
      expect(one.amendments![0].accepted_why).toMatch(/TC977 .* \(05-11-2026\)/)
      expect(one.amendments![1].accepted_why).toMatch(/shows 1 amended return processed \(TC977\); this is amendment 2 filed here/)
    })

    it('a 1040-X imported as filed counts, without an uploaded copy', () => {
      const p: EntityInfo = { id: 'p', name: 'Example Person', form_type: '1040', entity_type: 'individual' }
      const y = by(yearFilings(p, [], [{ id: 'x', tax_year: 2022, source: 'amendment', form_type: '1040', status: 'filed' }], today)).get(2022)!
      expect(y.amendments).toEqual([expect.objectContaining({ return_id: 'x', copy: null, accepted: false })])
    })
  })
})
