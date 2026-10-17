/**
 * The IRS-record checks on synthetic transcripts shaped like what the
 * Edgewater transcripts showed on 2026-10-17: returns posted to the wrong
 * year, a duplicate received AFTER the counted return, a return due on a
 * Sunday, and a transcript pulled the day the return was filed.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo } from './types.js'
import { buildContext } from './context.js'
import { irsChecks, dueDates, filingDate } from './checks/irs.js'
import { iso } from './lookup.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: `i${++n}`, form, title: form, rev: '2024', instance: '', page: 1, section: '', line: '', label: '', desc: '',
    kind: 'amount', value: 0, raw: '', method: 'geometry', ...p,
  }
}
function cat(id: string, year: number, entries: CatalogEntry[], kind: CatalogView['kind']): CatalogView {
  return { id, kind, tax_year: year, status: 'complete', coverage: { pages: 1, form_pages: 1, statement_pages: 0, duplicate_pages: 0, transcript_pages: 0, blank_pages: 0, entries: entries.length, residue_tokens: 0, copy_conflicts: 0, complete: true, problems: [], warnings: [] }, entries }
}
const ret = (year: number, ti: number) => cat(`r${year}`, year, [e('f1120s', { line: '22', value: ti, raw: String(ti) })], 'filed_return')
const tx = (code: string, label: string, date: string, value = 0) => e('irs_transcript', { section: 'Transactions', line: code, label, date, value, raw: label })
function tr(year: number, opts: { ti?: number; received?: string; asOf?: string; txs?: CatalogEntry[] }): CatalogView {
  return cat(`t${year}`, year, [
    e('irs_transcript', { section: 'Header', line: 'Response Date', kind: 'text', value: opts.asOf ?? '10-14-2026', raw: '' }),
    ...(opts.ti !== undefined ? [e('irs_transcript', { section: 'Return information', line: 'Taxable Income', value: opts.ti, raw: `Taxable Income ${opts.ti}` })] : []),
    ...(opts.received ? [e('irs_transcript', { section: 'Return information', line: 'Return due date or return received date (whichever is later)', kind: 'text', date: opts.received, raw: opts.received })] : []),
    ...(opts.txs ?? []),
  ], 'irs_transcript')
}
const scorp: EntityInfo = { id: 's', name: 'Example S Corp', form_type: '1120S', entity_type: 's_corp' }
const indiv: EntityInfo = { id: 'i', name: 'Example Taxpayer', form_type: '1040', entity_type: 'individual' }
const account = irsChecks.find(c => c.id === 'irs.account_status')!

function run(year: number, catalogs: CatalogView[], facts: Parameters<typeof buildContext>[0]['facts'] = [], entity = scorp) {
  const ctx = buildContext({ self: { entity, catalogs }, others: [], year, facts, today: new Date('2026-10-17T00:00:00Z') })
  return account.run(ctx) as ReturnType<typeof account.run> & Array<{ key?: string; title: string; detail: string; status: string; severity: string }>
}

describe('IRS account checks', () => {
  it('due dates roll past weekends and holidays', () => {
    expect(iso(dueDates('1040', 2022).extended)).toBe('2023-10-16') // 15 Oct 2023 was a Sunday
    expect(iso(dueDates('1120S', 2023).extended)).toBe('2024-09-16') // 15 Sep 2024 was a Sunday
    expect(iso(dueDates('1040', 2022).due)).toBe('2023-04-18')       // Saturday + DC Emancipation Day
    expect(iso(dueDates('1120S', 2024).extended)).toBe('2025-09-15')
  })

  it('a return received on the rolled due date is not late', async () => {
    const t = (received: string) => tr(2022, { received, txs: [tx('150', 'Tax return filed', '11-06-2023')] })
    expect((await run(2022, [t('10-16-2023')], [], indiv)).some(f => f.key === 'late')).toBe(false)
    expect((await run(2022, [t('10-17-2023')], [], indiv)).some(f => f.key === 'late')).toBe(true)
  })

  it('names the year whose return the IRS posted to this period', async () => {
    const cats = [ret(2023, 3044422), ret(2024, 162007), tr(2024, { ti: 3044422, txs: [tx('150', 'Tax return filed', '12-29-2025')] })]
    const out = await run(2024, cats)
    const m = out.find(f => f.key === 'mismatch')!
    expect(m.title).toMatch(/posted the 2023 return to 2024/)
    expect(m.detail).toMatch(/set aside as a duplicate/)
  })

  it('a duplicate received after the counted return does not support penalty relief, and an estimated-tax penalty never does', async () => {
    const cats = [ret(2023, 100), tr(2023, { ti: 100, received: '10-17-2025', txs: [
      tx('150', 'Tax return filed', '12-29-2025'), tx('976', 'Duplicate return filed', '01-20-2026'), tx('176', 'Penalty for not pre-paying tax', '03-16-2026', 1875),
    ] })]
    const out = await run(2023, cats)
    expect(out.find(f => f.key === '976')!.detail).not.toMatch(/before the receipt/)
    expect(out.find(f => f.key === 'penalties')!.detail).not.toMatch(/received earlier/)
  })

  it('an earlier duplicate does support cutting a failure-to-file penalty', async () => {
    const cats = [ret(2024, 100), tr(2024, { ti: 100, received: '01-20-2026', txs: [
      tx('150', 'Tax return filed', '03-30-2026'), tx('976', 'Duplicate return filed', '10-17-2025'), tx('246', 'Failure to provide information penalty', '03-30-2026', 490),
    ] })]
    const out = await run(2024, cats)
    expect(out.find(f => f.key === 'penalties')!.detail).toMatch(/received earlier \(10-17-2025\)/)
    expect(out.find(f => f.key === '976')!.detail).toMatch(/before the receipt the IRS counted \(2026-01-20\)/)
  })

  it('a transcript pulled the day the return was filed is a reason to re-pull, not an unfiled year', async () => {
    const cats = [ret(2025, 100), tr(2025, { asOf: '10-14-2026', txs: [tx('460', 'Extension of time to file', '03-16-2026')] })]
    const withDate = await run(2025, cats, [{ fact_key: 'irs.filing_date', tax_year: 2025, subject: null, value: '2026-10-14', status: 'answered', source: 'owner', recorded_at: '2026-10-17', superseded_by: null }])
    expect(withDate.find(f => f.key === '150')).toMatchObject({ status: 'gap', severity: 'low' })
    const noDate = await run(2025, cats)
    expect(noDate.find(f => f.key === '150')).toMatchObject({ status: 'gap', severity: 'medium' })
    const nothingOnFile = await run(2025, [tr(2025, { asOf: '10-14-2026' })])
    expect(nothingOnFile.find(f => f.key === '150')).toMatchObject({ status: 'finding', severity: 'high' })
  })

  it('a misposted return\'s receipt date never becomes this year\'s filing date', () => {
    const cats = [ret(2024, 162007), ret(2025, 1306476), tr(2025, { ti: 162007, received: '03-15-2026', txs: [tx('150', 'Tax return filed', '03-30-2026')] })]
    const facts = [{ fact_key: 'irs.filing_date', tax_year: 2025, subject: null, value: '2026-10-14', status: 'answered' as const, source: 'owner', recorded_at: '2026-10-17', superseded_by: null }]
    const ctx = buildContext({ self: { entity: scorp, catalogs: cats }, others: [], year: 2025, facts, today: new Date('2026-10-17T00:00:00Z') })
    const fd = filingDate(ctx, 2025)
    expect(iso(fd.date!)).toBe('2026-10-14')
    expect(fd.source).toMatch(/carries the 2024 return/)
  })
})
