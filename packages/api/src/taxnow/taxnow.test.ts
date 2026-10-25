/**
 * The TaxNow port, on the fictional fixture org (taxnow/fixture.ts) — never
 * on real transcripts. The rules were proved against the Python prototype on
 * the real corpus locally (2,778 periods, every status, transaction count and
 * sum, and every opportunity and insight count identical); these tests pin
 * each rule's behaviour so a refactor cannot drift from it.
 */
import { describe, it, expect } from 'vitest'
import { actionOf, familyOf, reversesOf } from './codes.js'
import { parseTranscriptHtml, statusWithoutHtml, returnFormOf } from './transcript.js'
import { findOpportunities, retentionRefundsByYear, type Period } from './opportunities.js'
import { findInsights, profileFromRetr } from './insights.js'
import { FixtureTaxNow, FIXTURE_ACCOUNTS } from './fixture.js'
import { accountForTin } from './client.js'

const tn = new FixtureTaxNow()
const today = new Date('2026-10-24T00:00:00Z')

async function periodsOf(accountId: string): Promise<Period[]> {
  const out: Period[] = []
  for (const t of await tn.listTranscripts(accountId)) {
    if (t.type !== 'ACTR') continue
    if (!t.syncedAt) { out.push({ form: t.form, taxYear: t.year, periodMonth: t.month, status: statusWithoutHtml(null), parsed: null }); continue }
    const parsed = parseTranscriptHtml(await tn.getTranscriptHtml(accountId, t))
    out.push({ form: t.form, taxYear: t.year, periodMonth: t.month, status: parsed.status, parsed })
  }
  return out
}

describe('transaction codes', () => {
  it('reads amended returns from the wording, not the code', () => {
    expect(actionOf('976', 'Amended return filed')).toBe('amended_return')
    expect(actionOf('976', 'Duplicate return filed')).toBe('duplicate_return')
    expect(actionOf('971', 'Amended tax return or claim forwarded for processing')).toBe('claim_forwarded')
    expect(actionOf('290', 'Disallowed claim')).toBe('claim_disallowed')
    expect(actionOf('150', 'Amended return filed')).toBeNull()
  })
  it('a reversal of first-time abatement is not read as one', () => {
    expect(actionOf('971', 'Reversal of No penalty due to previous compliance')).toBe('first_time_abatement_reversed')
    expect(actionOf('971', 'No penalty due to previous compliance')).toBe('first_time_abatement')
  })
  it('families and reversals', () => {
    expect(familyOf('166')).toBe('penalty')
    expect(reversesOf('167')).toBe('166')
    expect(reversesOf('841')).toBe('846')
    expect(familyOf('999')).toBe('other')
  })
})

describe('transcript HTML', () => {
  it('parses a filed period: balance, return lines, transactions, last four only', async () => {
    const p = parseTranscriptHtml(await tn.getTranscriptHtml('fx-juniper', { type: 'ACTR', form: '1120', year: 2023, month: 12 }))
    expect(p.status).toBe('filed')
    expect(p.balanceCents).toBe(-814000)
    expect(p.tinLast4).toBe('7781')
    expect(p.txns.map(t => t.code)).toEqual(['150', '276', '660'])
    expect(p.returnLines.find(l => l.key === 'received_date')?.valueDate).toBe('2024-10-11')
    // The masked TIN line is reduced to its last four; nothing EIN-shaped is kept.
    expect(JSON.stringify(p)).not.toMatch(/XX-XXX|\b\d{2}-\d{7}\b/)
  })
  it('keeps the six answers apart', async () => {
    const get = (id: string, form: string, year: number, month: number) => tn.getTranscriptHtml(id, { type: 'ACTR', form, year, month }).then(parseTranscriptHtml)
    expect((await get('fx-meridian', '1120', 2024, 12)).status).toBe('no_return_filed')
    expect((await get('fx-meridian', '941', 2019, 3)).status).toBe('no_irs_account')
    expect((await get('fx-juniper', '941', 2025, 12)).status).toBe('activity_no_return')
    expect(statusWithoutHtml('451')).toBe('not_authorized')
    expect(statusWithoutHtml(undefined)).toBe('never_synced')
  })
  it('an S corporation sits in the 1120 module; the title says so', async () => {
    const p = parseTranscriptHtml(await tn.getTranscriptHtml('fx-ostrander', { type: 'ACTR', form: '1120', year: 2023, month: 12 }))
    expect(returnFormOf('1120', p.formTitle)).toBe('1120S')
  })
})

describe('opportunities', () => {
  it('a credit on a filed period is held; on a period with no return it is deposits waiting', async () => {
    const j = findOpportunities(await periodsOf('fx-juniper'), today)
    expect(j.find(o => o.type === 'credit_held')).toMatchObject({ form: '1120', taxYear: 2023, amountCents: 814000, section: 'income' })
    const m = findOpportunities(await periodsOf('fx-meridian'), today)
    expect(m.find(o => o.type === 'deposits_no_return')).toMatchObject({ taxYear: 2024, amountCents: 733000 })
    expect(m.some(o => o.type === 'credit_held')).toBe(false)
  })
  it('an undelivered refund is one opportunity, not also a credit held', async () => {
    const n = findOpportunities(await periodsOf('fx-northgate'), today)
    const p2021 = n.filter(o => o.taxYear === 2021)
    expect(p2021.map(o => o.type)).toEqual(['refund_not_reissued'])
    expect(p2021[0].note).toMatch(/back on the account/)
  })
  it('first-time abatement fits a clean history; a prior penalty means reasonable cause', async () => {
    const o = findOpportunities(await periodsOf('fx-ostrander'), today)
    expect(o.find(x => x.type === 'penalty_fta')).toMatchObject({ form: '1120', taxYear: 2023, amountCents: 255000 })
    expect(o.find(x => x.type === 'penalty_fta')!.note).toMatch(/paid; refundable until 2027-08-19/)
    const r = findOpportunities(await periodsOf('fx-redwick'), today)
    expect(r.find(x => x.type === 'penalty_reasonable_cause' && x.taxYear === 2022)).toMatchObject({ amountCents: 394000 })
    expect(r.find(x => x.type === 'penalty_fta' && x.form === '941')).toMatchObject({ section: 'payroll', amountCents: 184000 })
  })
  it('estimated-tax penalties are never abatement opportunities', async () => {
    const n = findOpportunities(await periodsOf('fx-northgate'), today)
    expect(n.some(o => o.type.startsWith('penalty') && o.note.includes('TC 176'))).toBe(false)
  })
  it('a claim with nothing posted after it is pending', async () => {
    const h = findOpportunities(await periodsOf('fx-harbor-point'), today)
    expect(h.find(o => o.type === 'claim_pending' && o.taxYear === 2023)).toBeTruthy()
  })
})

describe('insights from the returns', () => {
  async function insightsOf(id: string) {
    const periods = await periodsOf(id)
    const profiles = []
    for (const t of await tn.listTranscripts(id)) if (t.type === 'RETR') profiles.push(profileFromRetr(await tn.getTranscriptJson(id, t)))
    return findInsights(profiles, { retentionRefunds: retentionRefundsByYear(periods), estimatesByDec15: estimates(periods), assessedTax: new Map(), secondReturnPosted: false })
  }
  function estimates(periods: Period[]) {
    const m = new Map<number, number>()
    for (const p of periods) if (p.form === '1120' && p.parsed) for (const t of p.parsed.txns) if (t.code === '660' && t.date && t.date <= `${p.taxYear}-12-15`) m.set(p.taxYear, (m.get(p.taxYear) ?? 0) - (t.amountCents ?? 0))
    return m
  }
  it('retention-credit refunds booked as income in the year received', async () => {
    expect((await insightsOf('fx-redwick')).find(i => i.type === 'erc_refund_as_income')).toMatchObject({ taxYear: 2023, severity: 'review', amountCents: 11200000 })
  })
  it('S-corp risks: low officer pay, distributions above income', async () => {
    expect((await insightsOf('fx-ostrander')).find(i => i.type === 'low_officer_pay')).toMatchObject({ taxYear: 2024, section: 'risk' })
    expect((await insightsOf('fx-harbor-point')).find(i => i.type === 'distributions_over_income')).toMatchObject({ taxYear: 2023, amountCents: 6420000 })
  })
  it('carryovers, loans and the estimated-tax safe harbor', async () => {
    expect((await insightsOf('fx-juniper')).find(i => i.type === 'nol_carryover')).toMatchObject({ amountCents: 5430000 })
    expect((await insightsOf('fx-juniper')).find(i => i.type === 'revenue_swing')).toBeTruthy()
    expect((await insightsOf('fx-meridian')).find(i => i.type === 'shareholder_loan')).toMatchObject({ amountCents: 4800000 })
    const n = await insightsOf('fx-northgate')
    expect(n.find(i => i.type === 'credit_carryforward')).toMatchObject({ amountCents: 690000 })
    expect(n.find(i => i.type === 'es_penalty_safe_harbor')).toMatchObject({ taxYear: 2024, amountCents: 321200 })
  })
})

describe('the fixture org', () => {
  it('finds an account by TIN only when the org would hold an 8821 (even last digit)', async () => {
    expect(await accountForTin(tn, '000000002')).toMatch(/^fx-new-0002-[0-9a-f]{6}$/)
    expect(await accountForTin(tn, '000000001')).toBeNull()
  })
  it('gives each TIN its own account, and a fixture account\'s TIN finds that account', async () => {
    const a = await accountForTin(tn, '100000002')
    const b = await accountForTin(tn, '200000002')
    expect(a).not.toBe(b)
    expect(await accountForTin(tn, '000008824')).toBe('fx-lakeside')
  })
  it('an IRS request for a period the 8821 does not cover comes back 451', async () => {
    const task = await tn.startSync('fx-calloway', { type: 'ACTR', form: '1065', year: 2024, month: 6 })
    expect(await tn.getTask('fx-calloway', task)).toMatchObject({ status: 'failed', code: 451 })
  })
  it('holds only fictional accounts', () => {
    expect(FIXTURE_ACCOUNTS.every(a => a.accountId.startsWith('fx-'))).toBe(true)
  })
})
