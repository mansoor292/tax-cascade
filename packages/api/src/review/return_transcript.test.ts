/**
 * Return transcripts and the one-golden-copy rule (2026-10-20), on synthetic
 * figures shaped like the Edgewater pull: EZA's 2024 period holds its 2023
 * return, a record of account and a dedicated transcript of the same date,
 * an older pull uploaded after a newer one, and a "No record of return
 * filed" response.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo } from './types.js'
import { buildContext } from './context.js'
import { irsChecks } from './checks/irs.js'
import { transcript, returnTranscript } from './lookup.js'
import { goldenTranscripts } from '../catalog/store.js'
import { resolveBox } from '../schema/transcript_map.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: `i${++n}`, form, title: form, rev: '2024', instance: '', page: 1, section: '', line: '', label: '', desc: '',
    kind: 'amount', value: 0, raw: '', method: 'geometry', ...p,
  }
}
function cat(id: string, year: number, entries: CatalogEntry[], kind: CatalogView['kind'], extra: Partial<CatalogView> = {}): CatalogView {
  return { id, kind, tax_year: year, status: 'complete', entries, ...extra }
}
/** A filed 1120-S with the lines the comparison reads, keyed as the golden
 *  schema keys them. */
const K = (ref: string) => { const r = resolveBox(ref); if ('error' in r) throw new Error(r.error); return r.key }
function filed1120s(year: number, f: { gr: number; ti: number; off: number; ded: number; obi: number; assets: number }): CatalogView {
  return cat(`f${year}`, year, [
    e('f1120s', { line: '1a', value: f.gr, canonical: K('f1120s||1a|') }), e('f1120s', { line: '6', value: f.ti, canonical: K('f1120s||6|') }),
    e('f1120s', { line: '7', value: f.off, canonical: K('f1120s||7|') }), e('f1120s', { line: '21', value: f.ded, canonical: K('f1120s||21|') }),
    e('f1120s', { line: '22', value: f.obi, canonical: K('f1120s||22|') }),
    e('f1120s', { section: 'Schedule L', line: '15', col: 'd', value: f.assets, canonical: K('f1120s|Schedule L|15|d') }),
  ], 'filed_return')
}
const rl = (section: string, line: string, value: number | string | null, kind: CatalogEntry['kind'] = 'amount') =>
  e('irs_return_transcript', { section, line, label: line, value, kind, raw: `${line}: ${value}` })
function retr(year: number, f: { gr: number; ti: number; off: number; ded: number; obi: number; assets: number }, extra: Partial<CatalogView> = {}): CatalogView {
  return cat(`rt${year}`, year, [
    rl('Return', 'Document Locator Number', '00000-000-00000-0', 'text'), rl('Return', 'Received Date', '10-17-2025', 'text'),
    rl('Indicators, Codes, and Miscellaneous Information', 'Total Assets at End of Year', f.assets),
    rl('Income', 'Gross Receipts', f.gr), rl('Income', 'Total Income', f.ti),
    rl('Deductions', 'Compensation of Officers', f.off), rl('Deductions', 'Total Deductions', f.ded), rl('Deductions', 'Ordinary Income/Loss', f.obi),
  ], 'irs_transcript', { transcript_type: 'return', as_of: '2026-10-20', ...extra })
}
const y23 = { gr: 8_000_000, ti: 5_000_000, off: 60_000, ded: 2_000_000, obi: 3_000_000, assets: 2_800_000 }
const y24 = { gr: 2_100_000, ti: 1_500_000, off: 60_000, ded: 1_400_000, obi: 100_000, assets: 1_500_000 }
const scorp: EntityInfo = { id: 's', name: 'Example S Corp', form_type: '1120S', entity_type: 's_corp' }
const check = irsChecks.find(c => c.id === 'irs.return_transcript')!
const account = irsChecks.find(c => c.id === 'irs.account_status')!
const ctxOf = (year: number, catalogs: CatalogView[]) => buildContext({ self: { entity: scorp, catalogs }, others: [], year, facts: [], today: new Date('2026-10-20T00:00:00Z') })
type R = Array<{ key?: string; title: string; status: string; severity: string }>

describe('IRS return transcript against the filed return', () => {
  it('agrees when the IRS processed the return as filed', async () => {
    const out = await check.run(ctxOf(2023, [filed1120s(2023, y23), retr(2023, y23)])) as R
    expect(out[0].key).toBe('agrees')
    expect(out[0].title).toMatch(/\d+ figures agree/)
  })

  it('names the year whose return sits in this period (EZA 2024 holds 2023)', async () => {
    const cats = [filed1120s(2023, y23), filed1120s(2024, y24), retr(2024, y23)]
    const out = await check.run(ctxOf(2024, cats)) as R
    expect(out[0].key).toBe('misposted')
    expect(out[0].title).toContain('holds the 2023 return in the 2024 period')
    expect(out[0].severity).toBe('high')
  })

  it('reports a plain difference when no other year matches', async () => {
    const out = await check.run(ctxOf(2024, [filed1120s(2024, y24), retr(2024, { ...y24, obi: 90_000, ded: 1_410_000 })])) as R
    expect(out[0].key).toBe('differs')
    expect(out[0].title).toContain('2 headline line(s)')
  })

  it('a secondary figure the IRS keyed differently is a low finding, not a headline one', async () => {
    const out = await check.run(ctxOf(2024, [filed1120s(2024, y24), retr(2024, { ...y24, off: 70_000 })])) as R
    expect(out.find(f => f.key === 'agrees')).toBeTruthy()
    expect(out.find(f => f.key === 'differs_other')).toMatchObject({ severity: 'low' })
  })

  it('a "No record of return filed" response is absence, not a mismatch', async () => {
    const nr = cat('nr', 2025, [e('irs_return_transcript', { section: 'Header', line: 'No record', kind: 'text', value: 'No record of return filed.' })], 'irs_transcript', { transcript_type: 'return', as_of: '2026-10-20' })
    const out = await check.run(ctxOf(2025, [filed1120s(2025, y24), nr])) as R
    expect(out[0].key).toBe('no_record')
    expect(out[0].status).toBe('gap')
  })

  it('the account check leaves the misposting to the line-by-line check when a return transcript exists', async () => {
    const acct = cat('at', 2024, [
      e('irs_transcript', { section: 'Return information', line: 'Taxable Income', value: y23.obi }),
      e('irs_transcript', { section: 'Transactions', line: '150', label: 'Tax return filed', date: '12-29-2025' }),
    ], 'irs_transcript', { transcript_type: 'account', as_of: '2026-10-20' })
    const filedOnly = [filed1120s(2023, y23), filed1120s(2024, y24), acct]
    expect((await account.run(ctxOf(2024, filedOnly)) as R).some(f => f.key === 'mismatch')).toBe(true)
    expect((await account.run(ctxOf(2024, [...filedOnly, retr(2024, y23)])) as R).some(f => f.key === 'mismatch')).toBe(false)
  })
})

describe('page-1 lines are read from page 1', () => {
  it('a blank officer-pay line is not answered by Schedule K line 12 (EV 2023)', async () => {
    const ccorp: EntityInfo = { id: 'c', name: 'Example C Corp', form_type: '1120', entity_type: 'c_corp' }
    const f = cat('f2023', 2023, [
      e('f1120', { section: '', line: '1a', value: 2_000_000, canonical: K('f1120||1a|') }), e('f1120', { section: 'Schedule K', line: '12', value: 37_329, canonical: K('f1120|Schedule K|12|') }),
      e('f1120', { section: '', line: '11', value: 1_900_000, canonical: K('f1120||11|') }),
    ], 'filed_return')
    const rt = cat('rt', 2023, [rl('Income', 'Gross Receipts or Sales', 2_000_000), rl('Deductions', 'Compensation of Officers', 0), rl('Income', 'Total Income', 1_900_000)], 'irs_transcript', { transcript_type: 'return', as_of: '2026-10-20' })
    const ctx = buildContext({ self: { entity: ccorp, catalogs: [f, rt] }, others: [], year: 2023, facts: [], today: new Date('2026-10-20T00:00:00Z') })
    const out = await check.run(ctx) as R
    expect(out[0].key).toBe('agrees')
    expect(out.some(x => x.key === 'differs_other')).toBe(false)
  })
})

describe('one golden transcript of each kind per entity and year', () => {
  const row = (id: string, transcript_type: 'account' | 'return' | 'record_of_account' | 'wage_income' | null, as_of: string | null, created_at = '2026-10-20T00:00:00Z') => ({ id, transcript_type, as_of, created_at })

  it('the newest pull wins; the older is superseded by it', () => {
    const g = goldenTranscripts([row('old', 'account', '2026-10-14'), row('new', 'account', '2026-10-20')])
    expect(g.account).toBe('new')
    expect(g.supersede).toEqual([{ id: 'old', by: 'new' }])
  })

  it('newer means the IRS response date, not the upload time', () => {
    const g = goldenTranscripts([row('fresh', 'account', '2026-10-20', '2026-10-20T10:00:00Z'), row('stale-uploaded-later', 'account', '2026-04-11', '2026-10-21T10:00:00Z')])
    expect(g.account).toBe('fresh')
    expect(g.supersede.map(s => s.id)).toEqual(['stale-uploaded-later'])
  })

  it('a record of account covers both kinds, and loses a same-day tie to each dedicated transcript', () => {
    const alone = goldenTranscripts([row('reca', 'record_of_account', '2026-10-20'), row('old-acct', 'account', '2026-10-14')])
    expect([alone.account, alone.return]).toEqual(['reca', 'reca'])
    expect(alone.supersede).toEqual([{ id: 'old-acct', by: 'reca' }])
    const tie = goldenTranscripts([row('reca', 'record_of_account', '2026-10-20'), row('acct', 'account', '2026-10-20'), row('retr', 'return', '2026-10-20')])
    expect([tie.account, tie.return]).toEqual(['acct', 'retr'])
    expect(tie.supersede).toEqual([{ id: 'reca', by: 'acct' }])
  })

  it('identical copies of one pull keep exactly one', () => {
    const g = goldenTranscripts([row('a', 'account', '2026-10-20', '2026-10-20T01:00:00Z'), row('b', 'account', '2026-10-20', '2026-10-20T02:00:00Z'), row('c', 'account', '2026-10-20', '2026-10-20T03:00:00Z')])
    expect(g.keep).toEqual(new Set(['c']))
    expect(g.supersede.map(s => s.id).sort()).toEqual(['a', 'b'])
  })

  it('a legacy row with no type counts as an account transcript; other kinds keep their own copy', () => {
    const g = goldenTranscripts([row('legacy', null, null), row('acct', 'account', '2026-10-20'), row('wi', 'wage_income', '2026-10-20')])
    expect(g.account).toBe('acct')
    expect(g.keep.has('wi')).toBe(true)
    expect(g.supersede).toEqual([{ id: 'legacy', by: 'acct' }])
  })

  it('the review reads the golden copy of each kind, whatever order the rows arrive in', () => {
    const acctOld = cat('a1', 2024, [], 'irs_transcript', { transcript_type: 'account', as_of: '2026-10-14' })
    const retrNew = cat('r1', 2024, [], 'irs_transcript', { transcript_type: 'return', as_of: '2026-10-20' })
    const recaNew = cat('ra', 2024, [], 'irs_transcript', { transcript_type: 'record_of_account', as_of: '2026-10-20' })
    expect(transcript([retrNew, acctOld], 2024)?.id).toBe('a1')
    expect(returnTranscript([acctOld, retrNew], 2024)?.id).toBe('r1')
    expect(transcript([retrNew, acctOld, recaNew], 2024)?.id).toBe('ra')
    expect(returnTranscript([recaNew, retrNew], 2024)?.id).toBe('r1')
  })
})
