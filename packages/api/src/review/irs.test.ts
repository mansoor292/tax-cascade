/**
 * The IRS-record checks on synthetic transcripts shaped like what the
 * Edgewater transcripts showed on 2026-10-17 (figures are the Talbrook demo
 * group's, standing in for the owner's): returns posted to the wrong
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
    const t = (received: string) => tr(2022, { received, txs: [tx('150', 'Tax return filed', '11-06-2023'), tx('460', 'Extension', '04-15-2023')] })
    expect((await run(2022, [t('10-16-2023')], [], indiv)).some(f => f.key === 'late')).toBe(false)
    expect((await run(2022, [t('10-17-2023')], [], indiv)).some(f => f.key === 'late')).toBe(true)
  })

  it('names the year whose return the IRS posted to this period', async () => {
    const cats = [ret(2023, 3239353), ret(2024, 128143), tr(2024, { ti: 3239353, txs: [tx('150', 'Tax return filed', '12-29-2025')] })]
    const out = await run(2024, cats)
    const m = out.find(f => f.key === 'mismatch')!
    expect(m.title).toMatch(/posted the 2023 return to 2024/)
    expect(m.detail).toMatch(/set aside as a duplicate/)
  })

  it('a duplicate received after the counted return does not support penalty relief, and an estimated-tax penalty never does', async () => {
    const cats = [ret(2023, 100), tr(2023, { ti: 100, received: '10-17-2025', txs: [
      tx('150', 'Tax return filed', '12-29-2025'), tx('976', 'Duplicate return filed', '01-20-2026'), tx('176', 'Penalty for not pre-paying tax', '03-16-2026', 1945),
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
    const cats = [ret(2024, 128143), ret(2025, 1163353), tr(2025, { ti: 128143, received: '03-15-2026', txs: [tx('150', 'Tax return filed', '03-30-2026')] })]
    const facts = [{ fact_key: 'irs.filing_date', tax_year: 2025, subject: null, value: '2026-10-14', status: 'answered' as const, source: 'owner', recorded_at: '2026-10-17', superseded_by: null }]
    const ctx = buildContext({ self: { entity: scorp, catalogs: cats }, others: [], year: 2025, facts, today: new Date('2026-10-17T00:00:00Z') })
    const fd = filingDate(ctx, 2025)
    expect(iso(fd.date!)).toBe('2026-10-14')
    expect(fd.source).toMatch(/carries the 2024 return/)
  })

  it('reads the extension off the transcript and prices relief from an earlier receipt (EZA 2021)', async () => {
    // No TC460: due 15 Mar 2022. Counted receipt 12 Feb 2024 (12 months, capped);
    // a copy arrived 15 Sep 2022 (6 months) — half the 2,464 is abatable.
    const cats = [ret(2021, 100), tr(2021, { ti: 100, received: '02-12-2024', txs: [
      tx('150', 'Tax return filed', '04-01-2024'), tx('976', 'Duplicate return filed', '09-15-2022'), tx('246', 'Failure to provide information penalty', '04-01-2024', 2464),
    ] })]
    const out = await run(2021, cats)
    expect(out.find(f => f.key === 'late')!.title).toMatch(/after the due date 2022-03-15 \(no extension on file\)/)
    const pen = out.find(f => f.key === 'penalties')! as { title: string; dollar_effect?: number }
    expect(pen.dollar_effect).toBe(-1232)
    expect(pen.title).toMatch(/1,232 of it is abatable/)
  })

  it('with a TC460 the extended date counts (EZA 2024: 2 months, 490)', async () => {
    const cats = [ret(2024, 100), tr(2024, { ti: 100, received: '10-17-2025', txs: [tx('150', 'Tax return filed', '12-29-2025'), tx('460', 'Extension', '04-07-2025')] })]
    const out = await run(2024, cats)
    expect(out.find(f => f.key === 'late')!.title).toMatch(/after the extended due date 2025-09-15$/)
  })

  it('a penalty the IRS reversed is not owed (EV 2024: TC176/276 removed by TC177/277)', async () => {
    const cats = [ret(2024, 100), tr(2024, { ti: 100, txs: [
      tx('150', 'Tax return filed', '12-22-2025'), tx('460', 'Extension', '04-15-2025'),
      tx('176', 'Penalty for not pre-paying tax', '12-22-2025', 2392.88), tx('276', 'Penalty for late payment of tax', '12-22-2025', 3743.07),
      tx('277', 'Reduced or removed penalty for late payment of tax', '03-16-2026', -3743.07), tx('177', 'Reduced or removed penalty for not pre-paying tax', '03-16-2026', -2392.88),
    ] })]
    const out = await run(2024, cats, [], { ...scorp, form_type: '1120', entity_type: 'c_corp' })
    const pen = out.find(f => f.key === 'penalties')!
    expect(pen.status).toBe('pass')
    expect(pen.title).toMatch(/every penalty assessed was reversed/)
  })

  it('a partial reversal leaves the remainder standing', async () => {
    const cats = [ret(2022, 100), tr(2022, { ti: 100, txs: [
      tx('150', 'Tax return filed', '12-11-2023'), tx('246', 'Failure to provide information penalty', '12-11-2023', 1980),
      tx('247', 'Reduced or removed failure to provide information penalty', '05-01-2024', -990),
    ] })]
    const pen = (await run(2022, cats)).find(f => f.key === 'penalties')!
    expect(pen.status).toBe('finding')
    expect(pen.title).toMatch(/penalties assessed 990 \(TC246\) after reversals/)
    expect(pen.detail).toMatch(/990 \(of 1,980\)/)
  })

  it('a credit balance is money the IRS holds, and a returned refund is called out', async () => {
    const cats = [cat('t2023', 2023, [
      e('irs_transcript', { section: 'Header', line: 'Response Date', kind: 'text', value: '04-11-2026', raw: '' }),
      e('irs_transcript', { section: 'Account', line: 'Account balance', value: -134964.56, raw: 'Account balance: -$134,964.56' }),
      tx('150', 'Tax return filed', '01-05-2026'), tx('846', 'Refund issued', '01-19-2026', 132059.17), tx('841', 'Refund cancelled', '01-19-2026', -132059.17),
      tx('846', 'Refund issued', '03-30-2026', 132059.17), tx('740', 'Undelivered refund returned to IRS', '03-30-2026', -132059.17),
    ], 'irs_transcript')]
    const out = await run(2023, cats, [], indiv)
    const c = out.find(f => f.key === 'credit')! as { title: string; detail: string; severity: string; dollar_effect?: number }
    expect(c.severity).toBe('high')
    expect(c.dollar_effect).toBeCloseTo(-134964.56)
    expect(c.title).toMatch(/holding 134,965.*the refund came back/)
    expect(c.detail).toMatch(/undelivered refund returned to the IRS 03-30-2026/)
  })

  it('no return is missing for a year before the entity existed, or one not yet due (EZA 2018, 2026)', async () => {
    const t = (year: number) => tr(year, { asOf: '10-20-2026', txs: [tx('960', 'Appointed representative', '06-08-2026')] })
    const ent = { ...scorp, date_incorporated: '2021-10-25' }
    const before = await run(2018, [t(2018)], [], ent)
    expect(before.find(f => f.key === '150')).toMatchObject({ status: 'pass', severity: 'info' })
    expect(before.find(f => f.key === '150')!.title).toContain('before the entity was incorporated')
    const current = await run(2026, [t(2026)], [], ent)
    expect(current.find(f => f.key === '150')!.title).toContain('no return is due yet')
    expect((await run(2022, [t(2022)], [], ent)).find(f => f.key === '150')).toMatchObject({ status: 'finding', severity: 'high' })
  })

  it('a credit before the return posts is payments waiting for it, not money held back (1040 2025)', async () => {
    const t = tr(2025, { asOf: '10-20-2026', txs: [tx('670', 'Payment', '04-15-2026', -450000)] })
    t.entries.push(e('irs_transcript', { section: 'Account', line: 'Account balance', value: -450000, raw: 'Account balance: -$450,000.00' }))
    const out = await run(2025, [t], [], indiv)
    expect(out.find(f => f.key === 'credit')).toMatchObject({ status: 'pass', severity: 'info' })
    t.entries.push(tx('150', 'Tax return filed', '11-30-2026', 400000))
    expect((await run(2025, [t], [], indiv)).find(f => f.key === 'credit')).toMatchObject({ status: 'finding', severity: 'high' })
  })

  it('a TC977 is the amendment filed here, not a duplicate set aside (2026-10-24)', async () => {
    const cats = [ret(2023, 1000), tr(2023, { asOf: '10-19-2026', txs: [tx('150', 'Tax return filed', '04-01-2024', 1000), tx('977', 'Amended return filed', '07-27-2026')] })]
    const runWith = (amended_years: number[]) => account.run(buildContext({ self: { entity: scorp, catalogs: cats }, others: [], year: 2023, facts: [], filing: { extended_years: [], amended_years }, today: new Date('2026-10-24T00:00:00Z') })) as Array<{ key?: string; title: string; status: string; severity: string }>
    const filedHere = await runWith([2023])
    expect(filedHere.some(f => f.key === '976')).toBe(false)
    expect(filedHere.find(f => f.key === '977')).toMatchObject({ status: 'pass', severity: 'info' })
    expect(filedHere.find(f => f.key === '977')!.title).toBe('2023: 1 amended return(s) posted by the IRS (TC977 07-27-2026), as recorded filed here')
    // Not recorded here: ask for the copy, still not a duplicate.
    const notHere = await runWith([2024])
    expect(notHere.some(f => f.key === '976')).toBe(false)
    expect(notHere.find(f => f.key === '977')).toMatchObject({ status: 'gap', severity: 'low' })
    expect(notHere.find(f => f.key === '977')!.title).toContain('none recorded here as filed')
  })
})
