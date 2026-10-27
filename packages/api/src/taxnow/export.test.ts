/**
 * The export reader (taxnow/export.ts), on fictional rows only: the fixture
 * book written as an export (fixture.ts fixtureExportCsv). The real export
 * this was built for is third parties' IRS data and never enters the repo;
 * its parity with the prototype was checked locally, counts only.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { csvRows, exportCents, exportDate, packParsed, parseExport, unpackParsed, ExportFormatError } from './export.js'
import { fixtureExportCsv } from './fixture.js'
import { findOpportunities } from './opportunities.js'
import { findingKeys } from '../services/practice_read.js'
import { asOfFor, mergeChanges, emptyChanges } from '../services/practice_import.js'

const TODAY = new Date('2026-10-26T00:00:00Z')

describe('reading an export', () => {
  it('reads quoted fields, a byte-order mark and CRLF line ends', () => {
    const rows = [...csvRows('﻿a,b\r\n1,"x, ""y"""\r\n2,\r\n')]
    expect(rows).toEqual([['a', 'b'], ['1', 'x, "y"'], ['2', '']])
  })

  it('reads M/D/YY, M/D/YYYY and ISO dates, and dollar amounts', () => {
    expect(exportDate('4/5/23')).toBe('2023-04-05')
    expect(exportDate('12/31/1999')).toBe('1999-12-31')
    expect(exportDate('2024-06-30')).toBe('2024-06-30')
    expect(exportDate('soon')).toBeNull()
    expect(exportCents('-1,234.56')).toBe(-123456)
    expect(exportCents('$0.10')).toBe(10)
    expect(exportCents('')).toBeNull()
  })

  it('the files the import journeys upload are this fictional book, unchanged', () => {
    // web/e2e/practice-imports.spec.ts uploads these; regenerate them from fixtureExportCsv when the book changes.
    for (const v of [1, 2] as const) {
      const committed = readFileSync(new URL(`../../../web/e2e/fixtures/fictional_export_v${v}_2026-10-26.csv`, import.meta.url), 'utf8')
      expect(committed).toBe(fixtureExportCsv(v))
    }
  })

  it('refuses a file that is not an export', () => {
    expect(() => parseExport('a,b,c\n1,2,3\n', '2026-10-26')).toThrow(ExportFormatError)
  })

  it('gives each period one status: filed, no return filed, or listed with nothing in it', () => {
    const { clients, stats } = parseExport(fixtureExportCsv(1), '2026-10-26')
    expect(stats.clients).toBe(8)
    expect(stats.unparsed).toEqual({ date: 0, amount: 0 })
    const meridian = clients.find(c => c.number === '1005')!
    expect(meridian.periods.find(p => p.form === '1120' && p.taxYear === 2025)!.status).toBe('no_return_filed')   // the "No tax return filed" line alone
    expect(meridian.periods.find(p => p.form === '941' && p.taxYear === 2019)!.status).toBe('no_transactions')
    const person = clients.find(c => c.number === '-1010')!
    expect(person.kind).toBe('individual')
    const p22 = person.periods.find(p => p.taxYear === 2022)!
    expect(p22.status).toBe('filed')
    expect(p22.parsed.balanceCents).toBe(-125000)   // the balance is the sum of the period's transactions
    expect(p22.parsed.txns.map(t => t.explanation)).toContain('Credit for withheld taxes, W-2')
    expect(p22.parsed.returnLines.find(l => l.key === 'received_date')?.valueDate).toBe('2023-04-10')   // the TC150 date stands in
  })

  it('builds only the clients a batch asks for, and still counts the whole file', () => {
    const all = parseExport(fixtureExportCsv(1), '2026-10-26')
    const some = parseExport(fixtureExportCsv(1), '2026-10-26', new Set(['1003']))
    expect(some.clients.map(c => c.number)).toEqual(['1003'])
    expect(some.stats).toEqual(all.stats)
    expect([...some.numbers.keys()]).toEqual(['-1010', '1001', '1002', '1003', '1004', '1005', '1006', '1008'])
  })

  it('stores a period packed and reads it back to the same findings', () => {
    const { clients } = parseExport(fixtureExportCsv(1), '2026-10-26')
    for (const c of clients) {
      const direct = findOpportunities(c.periods, TODAY)
      const round = findOpportunities(c.periods.map(p => ({ ...p, parsed: unpackParsed(JSON.parse(JSON.stringify(packParsed(p.form, p.parsed))))! })), TODAY)
      expect(round).toEqual(direct)
    }
  })

  it('finds on the export what the fictional book holds', () => {
    const { clients } = parseExport(fixtureExportCsv(1), '2026-10-26')
    const of = (n: string) => findOpportunities(clients.find(c => c.number === n)!.periods, TODAY).map(o => `${o.type} ${o.form} ${o.taxYear}-${o.periodMonth} ${(o.amountCents ?? 0) / 100}`)
    expect(of('1003')).toContain('credit_held 1120 2023-12 8140')
    expect(of('1004')).toContain('penalty_covid_kwong 1120 2022-12 3940')
    expect(of('1006')).toContain('penalty_fta_after_payment 941 2024-6 2500')
    // The later export: the tax was paid, so first-time abatement no longer waits.
    const later = parseExport(fixtureExportCsv(2), '2026-10-26').clients
    expect(findOpportunities(later.find(c => c.number === '1006')!.periods, TODAY).map(o => o.type)).toContain('penalty_fta')
    expect(later.map(c => c.number)).not.toContain('1005')
  })
})

describe('reviewing findings across recomputes', () => {
  it('keys a finding by type, form, period and penalty code — never by amount', () => {
    const f = (type: string, note: string, amount: number) => ({ type, form: '941', tax_year: 2024, period_month: 6, note, amount_cents: amount })
    const keys = findingKeys([f('penalty_fta', 'Late filing penalty (TC 166); …', 2500), f('penalty_fta', 'Late payment penalty (TC 276); …', 900), f('credit_held', 'Credit…', 100), f('credit_held', 'Credit…', 300)])
    expect(keys[0]).toBe('penalty_fta|941|2024|6|166')
    expect(keys[1]).toBe('penalty_fta|941|2024|6|276')
    // Two that would collide are told apart by size, largest first.
    expect(keys[3]).toBe('credit_held|941|2024|6|')
    expect(keys[2]).toBe('credit_held|941|2024|6|#2')
    expect(keys.join()).not.toMatch(/2500|900/)
  })

  it('adds up what each batch changed', () => {
    const a = { ...emptyChanges(), clients_seen: 2, findings_new: { penalty_fta: 1 }, changed_clients: ['x'] }
    const b = { ...emptyChanges(), clients_seen: 3, findings_new: { penalty_fta: 2 }, findings_gone: { penalty_fta_after_payment: 1 }, changed_clients: ['y'] }
    const m = mergeChanges({ ...emptyChanges(), clients_added: 4 }, [a, b])
    expect(m).toMatchObject({ clients_added: 4, clients_seen: 5, findings_new: { penalty_fta: 3 }, findings_gone: { penalty_fta_after_payment: 1 }, changed_clients: ['x', 'y'] })
  })

  it('takes the as-of date given, else from the file name, never in the future', () => {
    const today = new Date('2026-10-26T12:00:00Z')
    expect(asOfFor('client_data_export_2026-10-26.csv', undefined, today)).toBe('2026-10-26')
    expect(asOfFor('book.csv', '2026-09-30', today)).toBe('2026-09-30')
    expect(asOfFor('book.csv', undefined, today)).toBe('2026-10-26')
    expect(() => asOfFor('book.csv', '2026-11-01', today)).toThrow(/future/)
  })
})
