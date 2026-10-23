/**
 * When a missing filed return is an open item (2026-10-22): not before the
 * return is due, and not for a year before anything is on file — the demo
 * group's open items opened with "High · No filed 2026 return is catalogued"
 * and the same for 2016–2018.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogView, EntityInfo } from './types.js'
import { buildContext } from './context.js'
import { catalogChecks } from './checks/catalog.js'
import { entityChecks } from './checks/entity.js'
import { filedReturnExpected } from './checks/irs.js'

const indiv: EntityInfo = { id: 'i', name: 'Example Taxpayer', form_type: '1040', entity_type: 'individual' }
const scorp: EntityInfo = { id: 's', name: 'Example S Corp', form_type: '1120S', entity_type: 's_corp' }
const present = catalogChecks.find(c => c.id === 'catalog.return_present')!
const facts = entityChecks.find(c => c.id === 'facts.required_answered')!
const ctx = (entity: EntityInfo, year: number, today: string, filing?: { extended_years: number[]; first_record_year?: number }) =>
  buildContext({ self: { entity, catalogs: [] }, others: [], year, facts: [], today: new Date(`${today}T00:00:00Z`), filing,
    factGaps: [{ key: 'owners.list', question: 'Who owns it?', status: 'missing' }] })

describe('a missing filed return is asked for only when one is expected', () => {
  it('not before it is due', () => {
    const r = present.run(ctx(indiv, 2026, '2026-10-22', { extended_years: [], first_record_year: 2022 })) as any[]
    expect(r[0]).toMatchObject({ status: 'n/a' })
    expect(r[0].title).toMatch(/not due until 2027-04-15/)
  })

  it('the extended due date counts when an extension is on file', () => {
    expect(filedReturnExpected(ctx(scorp, 2025, '2026-08-01', { extended_years: [2025], first_record_year: 2022 })).expected).toBe(false)
    expect(filedReturnExpected(ctx(scorp, 2025, '2026-08-01', { extended_years: [], first_record_year: 2022 })).expected).toBe(true)
    const late = present.run(ctx(scorp, 2025, '2026-10-22', { extended_years: [2025], first_record_year: 2022 })) as any[]
    expect(late[0]).toMatchObject({ status: 'gap', severity: 'high' })
  })

  it('not for a year before anything is on file — and its facts are not asked either', () => {
    const c = ctx(indiv, 2018, '2026-10-22', { extended_years: [], first_record_year: 2022 })
    expect((present.run(c) as any[])[0]).toMatchObject({ status: 'n/a' })
    expect((facts.run(c) as any[])[0]).toMatchObject({ status: 'n/a' })
    const inRange = ctx(indiv, 2023, '2026-10-22', { extended_years: [], first_record_year: 2022 })
    expect((present.run(inRange) as any[])[0]).toMatchObject({ status: 'gap' })
    expect((facts.run(inRange) as any[])[0]).toMatchObject({ status: 'gap' })
  })

  it('before the records, a return the IRS shows processed is a low item: upload the copy', () => {
    const tc150: CatalogView = { id: 't2019', kind: 'irs_transcript', tax_year: 2019, status: 'complete', transcript_type: 'account', entries: [
      { id: 'x1', form: 'irs_transcript', title: '', rev: '2019', instance: '', page: 1, section: 'Transactions', line: '150', label: 'Tax return filed', desc: '', kind: 'amount', value: 0, raw: '', method: 'geometry', date: '04-15-2020' },
    ] }
    const c = buildContext({ self: { entity: indiv, catalogs: [tc150] }, others: [], year: 2019, facts: [], today: new Date('2026-10-23T00:00:00Z'),
      filing: { extended_years: [], first_record_year: 2022 }, factGaps: [{ key: 'owners.list', question: 'Who owns it?', status: 'missing' }] })
    const r = (present.run(c) as any[])[0]
    expect(r).toMatchObject({ status: 'gap', severity: 'low', title: 'The IRS has a 2019 return; no copy is on file here' })
    expect(r.detail).toMatch(/TC150 on 04-15-2020/)
    expect((facts.run(c) as any[])[0]).toMatchObject({ status: 'n/a' })
  })

  it('with nothing on file at all, only the due date decides', () => {
    expect(filedReturnExpected(ctx(indiv, 2018, '2026-10-22')).expected).toBe(true)
  })
})
