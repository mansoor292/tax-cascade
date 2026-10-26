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
import { accountForTin, orgCredentials, taxnowFor } from './client.js'

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
  it('173, 163 and 283 are assessments, not reversals; 577 lifts 576', () => {
    expect(familyOf('173')).toBe('penalty')
    expect(reversesOf('173')).toBeNull()
    expect(reversesOf('163')).toBeNull()
    expect(reversesOf('283')).toBeNull()
    expect(reversesOf('281')).toBe('280')
    expect(reversesOf('577')).toBe('576')
    expect(familyOf('713')).toBe('credit_in')
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

describe('missing returns', () => {
  const tx = (code: string, explanation: string, date: string, amountCents: number) =>
    ({ seq: 0, code, family: familyOf(code), action: actionOf(code, explanation), reverses: reversesOf(code), explanation, description: explanation, cycle: null, date, amountCents, dln: null, secondaryDate: null, otherForm: null, otherPeriod: null })
  /** Meridian with its 2024 1120 changed: the deposits gone, these codes added. */
  async function meridian2024(...extra: ReturnType<typeof tx>[]) {
    const ps = await periodsOf('fx-meridian')
    const p = ps.find(x => x.form === '1120' && x.taxYear === 2024)!
    p.parsed = { ...p.parsed!, balanceCents: 0, txns: [...p.parsed!.txns, ...extra] }
    return findOpportunities(ps, today).filter(o => o.form === '1120' && o.taxYear === 2024)
  }

  it('an empty period the 8821 opened is not a missing return; payroll filed that year makes it one', async () => {
    // Meridian 2025: "No tax return filed" with nothing on it, and no 1120 posted for 2024.
    const ps = await periodsOf('fx-meridian')
    const y2025 = (list: Period[]) => findOpportunities(list, today).filter(o => o.form === '1120' && o.taxYear === 2025)
    expect(y2025(ps)).toMatchObject([{ type: 'missing_return', amountCents: null }])
    expect(y2025(ps)[0].note).toMatch(/evidence: payroll returns filed that year\.$/)
    expect(y2025(ps.filter(p => !(p.taxYear === 2025 && p.form !== '1120')))).toEqual([])
  })
  it('within 120 days of the extended due date it is pending', async () => {
    const j = findOpportunities(await periodsOf('fx-juniper'), today).find(o => o.form === '1120' && o.taxYear === 2025)
    expect(j).toMatchObject({ type: 'missing_return_pending', amountCents: 1200000 })
    expect(j!.note).toMatch(/due 2026-10-15 \(extended\); not posted 4 days later; evidence: deposits still on the period, extension filed, return posted the year before/)
  })
  it('a payroll return counts too, in the payroll section', async () => {
    const o = findOpportunities(await periodsOf('fx-ostrander'), today).find(x => x.form === '940' && x.taxYear === 2023)
    expect(o).toMatchObject({ type: 'missing_return', section: 'payroll', amountCents: 42000 })
  })
  it('deposits moved to another period make it unclear', async () => {
    const [o] = await meridian2024(tx('652', 'Reversed payment moved to another period', '06-01-2025', 733000))
    expect(o).toMatchObject({ type: 'missing_return_unclear', amountCents: null })
    expect(o.note).toMatch(/doubt: the deposits were moved to another period/)
  })
  it('a delinquency the IRS closed, or a return secured that never posted, makes it unclear', async () => {
    expect((await meridian2024(tx('598', 'Delinquency shelved', '2025-09-01', 0)))[0].type).toBe('missing_return_unclear')
    expect((await meridian2024(tx('599', 'Return secured', '2025-09-01', 0)))[0].note).toMatch(/return secured but none posted here/)
  })
  it('where the IRS says no return is owed, nothing is raised', async () => {
    expect(await meridian2024(tx('590', 'Not liable for this tax period', '2025-09-01', 0))).toEqual([])
  })

  /** Meridian's 1120s read as another form; with `bare`, the 2024 deposits taken off. */
  async function meridianAs(form: string, bare: boolean) {
    const ps = (await periodsOf('fx-meridian')).map(p => (p.form === '1120' ? { ...p, form } : p))
    const p = ps.find(x => x.form === form && x.taxYear === 2024)!
    if (bare) p.parsed = { ...p.parsed!, balanceCents: 0, txns: p.parsed!.txns.filter(x => x.family !== 'payment') }
    return findOpportunities(ps, today).filter(o => o.form === form && o.taxYear === 2024)
  }
  it('an individual whose only evidence is the filing pattern is unclear; money makes it a missing return', async () => {
    const [bare] = await meridianAs('1040', true)
    expect(bare).toMatchObject({ type: 'missing_return_unclear', amountCents: null })
    expect(bare.note).toMatch(/evidence: return posted the year before; doubt: an individual with a filing pattern only/)
    expect(await meridianAs('1040', false)).toMatchObject([{ type: 'missing_return', amountCents: 733000 }])
    // A business with the same pattern is a missing return.
    expect(await meridianAs('1120', true)).toMatchObject([{ type: 'missing_return' }])
  })
  it('a trust or estate return (1041) is read too', async () => {
    const [o] = await meridianAs('1041', false)
    expect(o).toMatchObject({ type: 'missing_return', amountCents: 733000 })
    expect(o.note).toMatch(/due 2025-04-15;/)
  })
  it('money on a period with no return can be claimed 3 years from when it counts as paid', async () => {
    // Income: the due date (last payment + 2 years would have said 2026-12-16).
    expect((await meridianAs('1120', false))[0].note).toMatch(/refund window open to 2028-04-15/)
    // Extended: the extended date.
    const j = findOpportunities(await periodsOf('fx-juniper'), today).find(o => o.form === '1120' && o.taxYear === 2025)
    expect(j!.note).toMatch(/refund window open to 2029-10-15/)
    // A 940: its due date, January 31 (the deposit + 2 years closed in January 2026).
    const o = findOpportunities(await periodsOf('fx-ostrander'), today).find(x => x.form === '940' && x.taxYear === 2023)
    expect(o!.note).toMatch(/refund window open to 2027-01-31/)
  })
  it('a payment on 29 February counts 2 years to the 28th', async () => {
    const ps = await periodsOf('fx-meridian')
    const p = ps.find(x => x.form === '1120' && x.taxYear === 2024)!
    p.parsed = { ...p.parsed!, txns: [...p.parsed!.txns, tx('670', 'Payment', '2032-02-29', -100)] }
    expect(findOpportunities(ps, today).find(o => o.taxYear === 2024)!.note).toMatch(/refund window open to 2034-02-28/)
  })
})

describe('opportunities', () => {
  it('a credit on a filed period is held; on a past-due period with no return it is a missing return', async () => {
    const j = findOpportunities(await periodsOf('fx-juniper'), today)
    expect(j.find(o => o.type === 'credit_held')).toMatchObject({ form: '1120', taxYear: 2023, amountCents: 814000, section: 'income' })
    const m = findOpportunities(await periodsOf('fx-meridian'), today)
    expect(m.find(o => o.type === 'missing_return')).toMatchObject({ taxYear: 2024, amountCents: 733000 })
    expect(m.find(o => o.type === 'missing_return')!.note).toMatch(/due 2025-04-15; evidence: deposits still on the period, return posted the year before/)
    expect(m.some(o => o.type === 'credit_held' || o.type === 'deposits_no_return')).toBe(false)
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
    expect(r.find(x => x.type === 'penalty_reasonable_cause')).toMatchObject({ taxYear: 2024, amountCents: 270000 })
    expect(r.find(x => x.type === 'penalty_reasonable_cause')!.note).toMatch(/a penalty in the 3 years before; unpaid/)
    expect(r.find(x => x.type === 'penalty_fta' && x.form === '941')).toMatchObject({ section: 'payroll', amountCents: 184000 })
  })
  it('estimated-tax penalties are never abatement opportunities', async () => {
    const n = findOpportunities(await periodsOf('fx-northgate'), today)
    expect(n.some(o => o.type.startsWith('penalty') && o.note.includes('TC 176'))).toBe(false)
  })
  it('an undelivered refund counts only while the credit is still there, and no more than it', async () => {
    const at = async (balanceCents: number) => {
      const ps = await periodsOf('fx-northgate')
      const p = ps.find(x => x.form === '1120' && x.taxYear === 2021)!
      p.parsed = { ...p.parsed!, balanceCents }
      return findOpportunities(ps, today).filter(o => o.taxYear === 2021)
    }
    // A later assessment absorbed it: nothing is owed back.
    expect(await at(0)).toEqual([])
    expect(await at(25000)).toEqual([])
    // Part absorbed: the credit left, not the refund.
    expect(await at(-100000)).toMatchObject([{ type: 'refund_not_reissued', amountCents: 100000 }])
  })
  it('a claim with nothing posted after it is pending', async () => {
    const h = findOpportunities(await periodsOf('fx-harbor-point'), today)
    expect(h.find(o => o.type === 'claim_pending' && o.taxYear === 2023)).toBeTruthy()
  })
})

describe('the COVID window (Kwong)', () => {
  const pen = (code: string, explanation: string, date: string, amountCents: number) =>
    ({ seq: 0, code, family: familyOf(code), action: null, reverses: reversesOf(code), explanation, description: explanation, cycle: null, date, amountCents, dln: null, secondaryDate: null, otherForm: null, otherPeriod: null })
  /** Meridian's 1120 for `year` (month `month`), unpaid, with this penalty on it. */
  async function withPenalty(year: number, x: ReturnType<typeof pen>, month = 12) {
    const ps = await periodsOf('fx-meridian')
    const p = ps.find(o => o.form === '1120' && o.taxYear === year)!
    p.periodMonth = month
    p.parsed = { ...p.parsed!, balanceCents: x.amountCents, txns: [...p.parsed!.txns, x] }
    return findOpportunities(ps, today).filter(o => o.taxYear === year && o.type.startsWith('penalty'))
  }
  it('a late return due in the window and filed soon after its end: part of the penalty', async () => {
    const r = findOpportunities(await periodsOf('fx-redwick'), today).find(o => o.taxYear === 2022 && o.form === '1120')!
    expect(r).toMatchObject({ type: 'penalty_covid_kwong', amountCents: 394000, section: 'income' })
    expect(r.note).toMatch(/return due 2023-04-15, filed 2023-11-20: only the months before 2023-07-10; unpaid.*; first-time abatement does not fit; interest on the period 1,211.00 \(the window may take some off too\)\.$/)
  })
  it('filed past the penalty’s cap after the window, it is not a COVID-window penalty', async () => {
    // Due 2022-04-15, filed 2024-01-10: more than 5 months after 2023-07-10.
    const ps = await periodsOf('fx-meridian')
    const p = ps.find(o => o.form === '1120' && o.taxYear === 2021)!
    p.parsed = { ...p.parsed!, balanceCents: 50000, returnLines: [{ ...p.parsed!.returnLines[0], valueDate: '2024-01-10' }], txns: [...p.parsed!.txns, pen('166', 'Penalty for filing a tax return late', '2024-01-10', 50000)] }
    expect(findOpportunities(ps, today).filter(o => o.taxYear === 2021).map(o => o.type)).toEqual(['penalty_fta'])
  })
  it('estimated-tax penalties come in, whole or in part by installment', async () => {
    const whole = await withPenalty(2021, pen('176', 'Penalty for underpaying estimated tax', '2022-04-15', 30000))
    expect(whole).toMatchObject([{ type: 'penalty_covid_kwong', amountCents: 30000 }])
    expect(whole[0].note).toMatch(/installments all due in the COVID window .*: the whole penalty/)
    expect((await withPenalty(2023, pen('176', 'Penalty for underpaying estimated tax', '2024-04-15', 30000)))[0].note).toMatch(/2 of 4 estimated-tax installments/)
    // Outside the window an estimated-tax penalty is still not abatable.
    expect(await withPenalty(2024, pen('176', 'Penalty for underpaying estimated tax', '2025-04-15', 30000))).toEqual([])
  })
  it('a fiscal year’s installments are counted back from its own year end', async () => {
    // June 2024 year end: installments 2023-10-15 … 2024-06-15, all after the window.
    expect(await withPenalty(2024, pen('176', 'Penalty for underpaying estimated tax', '2024-08-15', 30000), 6)).toEqual([])
  })
  it('a deposit penalty counts by the period it was due for', async () => {
    const ps = await periodsOf('fx-redwick')
    const p = ps.find(o => o.form === '941' && o.taxYear === 2024 && o.periodMonth === 3)!
    p.taxYear = 2023
    expect(findOpportunities(ps, today).find(o => o.form === '941' && o.taxYear === 2023 && o.periodMonth === 3)).toMatchObject({ type: 'penalty_covid_kwong', section: 'payroll' })
  })
})

describe('penalties, how they are read', () => {
  const t = (code: string, explanation: string, date: string, amountCents: number) =>
    ({ seq: 0, code, family: familyOf(code), action: actionOf(code, explanation), reverses: reversesOf(code), explanation, description: explanation, cycle: null, date, amountCents, dln: null, secondaryDate: null, otherForm: null, otherPeriod: null })
  const late = (cents: number) => t('166', 'Penalty for filing a tax return late', '2024-06-03', cents)
  /** Meridian's 2023 1120 (filed, received 2024-03-15) with this balance and these transactions; `y2022` goes on 2022. */
  async function meridian2023(balanceCents: number, txns: ReturnType<typeof t>[], y2022: ReturnType<typeof t>[] = []) {
    const ps = await periodsOf('fx-meridian')
    for (const [year, extra, bal] of [[2023, txns, balanceCents], [2022, y2022, null]] as const) {
      const p = ps.find(x => x.form === '1120' && x.taxYear === year)!
      p.parsed = { ...p.parsed!, ...(bal != null ? { balanceCents: bal } : {}), txns: [...p.parsed!.txns, ...extra] }
    }
    return findOpportunities(ps, today).filter(o => o.taxYear === 2023 && o.type.startsWith('penalty'))
  }
  it('either removal code takes off either code of its family', async () => {
    // A TC 166 removed by a TC 161 the same day: nothing stands.
    expect(await meridian2023(0, [late(500000), t('161', 'Removed penalty for filing a tax return late', '2024-06-03', -500000)])).toEqual([])
  })
  it('interest is never a penalty', async () => {
    expect(await meridian2023(90000, [t('336', 'Interest charged for late payment', '2024-06-03', 90000)])).toEqual([])
  })
  it('a partly paid penalty: what abatement takes off the balance and what it refunds, apart', async () => {
    const [o] = await meridian2023(200000, [late(500000)])
    expect(o).toMatchObject({ type: 'penalty_fta', amountCents: 500000, lowersOwedCents: 200000, refundCents: 300000 })
    expect(o.note).toMatch(/partly paid: abatement lowers the balance due by up to 2,000.00 and refunds at least 3,000.00 \(until 2027-03-15\)/)
    // Unpaid in full: no refund. Paid in full: no lowering.
    expect(await meridian2023(500000, [late(500000)])).toMatchObject([{ refundCents: 0, lowersOwedCents: 500000 }])
    expect(await meridian2023(0, [late(500000)])).toMatchObject([{ refundCents: 500000, lowersOwedCents: 0 }])
  })
  it('first-time abatement waits while tax is still owed, unless an installment agreement is in force', async () => {
    const [o] = await meridian2023(1200000, [late(500000)])
    expect(o).toMatchObject({ type: 'penalty_fta_after_payment', lowersOwedCents: 500000, refundCents: 0 })
    expect(o.note).toMatch(/fits once the tax is paid or an installment agreement is in place; .*about 7,000.00 of tax is still owed on the period/)
    const ia = t('971', 'Installment agreement established', '2025-01-10', 0)
    expect((await meridian2023(1200000, [late(500000), ia]))[0].type).toBe('penalty_fta')
    expect((await meridian2023(1200000, [late(500000), ia, t('971', 'Removed installment agreement', '2025-09-10', 0)]))[0].type).toBe('penalty_fta_after_payment')
  })
  it('a prior penalty the IRS removed does not count against first-time abatement, but is noted', async () => {
    const removed = [t('166', 'Penalty for filing a tax return late', '2023-06-01', 100000), t('167', 'Removed penalty for filing a tax return late', '2023-09-01', -100000)]
    const [o] = await meridian2023(500000, [late(500000)], removed)
    expect(o.type).toBe('penalty_fta')
    expect(o.note).toMatch(/but a penalty in the 3 years before was removed — if that was by first-time abatement, it is used up/)
    // Still standing, it does count.
    expect((await meridian2023(500000, [late(500000)], removed.slice(0, 1)))[0].type).toBe('penalty_reasonable_cause')
  })
  it('a stored transcript is read with today’s code tables, not those it was parsed with', async () => {
    const stale = { ...late(500000), family: 'other' as const }
    expect(await meridian2023(500000, [stale])).toMatchObject([{ type: 'penalty_fta', amountCents: 500000 }])
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

// 2026-10-27: a practice names the TaxNow org it reads through. The platform
// org keeps the unsuffixed names; any other org reads its own suffixed pair,
// and nothing else is ever borrowed for it.
describe('TaxNow orgs', () => {
  const env = { TAXNOW_API_KEY: 'k-platform', TAXNOW_ORG_ID: 'o-platform', TAXNOW_API_KEY_BCL: 'k-bcl', TAXNOW_ORG_ID_BCL: 'o-bcl', TAXNOW_API_KEY_HALF: 'k-half' }

  it('reads the platform org from the unsuffixed names', () => {
    expect(orgCredentials('platform', env)).toEqual({ key: 'k-platform', orgId: 'o-platform' })
  })

  it('reads another org from its own suffixed names', () => {
    expect(orgCredentials('bcl', env)).toEqual({ key: 'k-bcl', orgId: 'o-bcl' })
  })

  it('never falls back to the platform key for an org that is not configured', () => {
    expect(orgCredentials('half', env)).toBeNull()      // key without an org id
    expect(orgCredentials('hrlogics', env)).toBeNull()  // nothing at all
  })

  it('refuses names that could reach other variables', () => {
    for (const bad of ['BCL', 'bcl;x', '', '1bcl', 'a'.repeat(40)]) expect(orgCredentials(bad, env)).toBeNull()
  })

  it('reads through the org it was asked for', async () => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      expect((await taxnowFor('taxnow', 'bcl')).orgId).toBe('o-bcl')
      expect((await taxnowFor('taxnow')).orgId).toBe('o-platform')
      await expect(taxnowFor('taxnow', 'hrlogics')).rejects.toThrow(/not configured/)
      expect((await taxnowFor('fixture', 'bcl')).provider).toBe('fixture')
    } finally { process.env = saved }
  })
})
