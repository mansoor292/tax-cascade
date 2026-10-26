/**
 * Opportunities on one client's IRS account transcripts.
 *
 * Port of ~/taxnow-data/tools/opportunities.py (2026-10-24), whose rules were
 * worked out on 45 real business accounts. Money meanings it settled, kept here:
 *  - credit_held (a credit on a period whose return posted: an overpayment
 *    the IRS holds) is NOT deposits_no_return (a credit on a period the IRS
 *    shows "No tax return filed": deposits waiting on a return, current
 *    quarters or a missing return). One prototype org had ~4.5M of the second
 *    kind that a naive "credit balance" sum would have called money owed back.
 *  - A cancelled or undelivered refund (TC 841/740 with no TC 846 after it)
 *    puts the money back on the account: one opportunity, not two. It is
 *    owed back only while the period still holds a credit, and no more than
 *    that credit (2026-10-26, Mansoor: an undelivered refund a later
 *    assessment absorbed left the client owed nothing).
 *  - A penalty counts only if it can still pay: unpaid (the period owes), or
 *    paid and inside the refund window, estimated as three years from the
 *    return's received date or two years from the period's last payment.
 *    Paid penalties outside it are dropped (one org: 185 of them, $283K).
 *  - Money on a period with no return (2026-10-26): the late return is itself
 *    the claim, and the period's payments count as paid on the original due
 *    date — a 941/943/944's on April 15 of the next year (IRC 6513(c)), an
 *    income return's on its due date, or its extended date if a TC 460
 *    posted — so they come back if it is filed within 3 years of that date.
 *    Last payment + 2 years alone closed years that are still open.
 *  - Estimated-tax penalties and collection fees are not abatable, except
 *    under the COVID window below.
 *  - COVID window (Kwong v. United States, Ct. Fed. Cl. 2025, 179 Fed. Cl.
 *    382): IRC 7508A(d) postponed every deadline from 2020-01-20 to 60 days
 *    after the incident ended, 2023-07-10, so late-filing, late-payment,
 *    deposit and estimated-tax penalties on those deadlines may come off.
 *    The IRS does not accept it (its regulation caps the postponement at a
 *    year): a litigating position, not settled law. Mansoor asked for these
 *    on their own (2026-10-26), so they leave the first-time-abatement and
 *    reasonable-cause lists, with first-time abatement's fit noted.
 * Penalty amounts are assessed less reversed, not matched to payments.
 *
 * Missing returns (prototype rule of 2026-10-26). The IRS opens an empty
 * period for every year an 8821 lists, so a "No tax return filed" period
 * holding only the representative entry (TC 960) says nothing about whether a
 * return was due: about 230 such periods across the two prototype orgs. A
 * period counts only when it is past due as of its last pull (the extended
 * date if a TC 460 posted) AND something shows a return was owed: deposits,
 * an extension, an IRS non-filing inquiry (TC 140), returns posted before and
 * after it, the return posted the year before, or payroll filed that year (an
 * 1120/1065 the client has filed before: an LLC with employees may report on
 * a 1065 or its owner's 1040). It is "unclear" when the record points
 * elsewhere (deposits moved out, TC 652; a return secured, 599, that never
 * posted; a duplicate or amended return with no original; the delinquency
 * closed, 593/597/598; an individual, 1040, whose only evidence is the filing
 * pattern), "pending" within 120 days of the due date, and never
 * raised where the IRS says no return is owed (590/591/594). deposits_no_return
 * is what is left: credit on a no-return period that is none of these.
 */
import { FTA_CODES, INTEREST_CODES, NOT_ABATABLE, PENALTY_NAME, actionOf, familyOf, penaltyKeyOf, reversesOf, sectionOfForm } from './codes.js'
import type { ParsedTranscript, PeriodStatus, Txn } from './transcript.js'

export interface Period {
  form: string
  taxYear: number
  periodMonth: number
  status: PeriodStatus
  parsed: ParsedTranscript | null
}

export type OpportunityType =
  | 'credit_held' | 'missing_return' | 'penalty_covid_kwong' | 'penalty_fta_after_payment' | 'missing_return_unclear' | 'missing_return_pending' | 'deposits_no_return' | 'refund_not_reissued' | 'penalty_fta' | 'penalty_reasonable_cause'
  | 'claim_pending' | 'claim_disallowed'

export interface Opportunity {
  section: 'income' | 'payroll'
  type: OpportunityType
  form: string
  taxYear: number
  periodMonth: number
  amountCents: number | null
  note: string
  /** Penalties: what abatement would pay back, and what it would take off the balance due. */
  refundCents?: number
  lowersOwedCents?: number
}

const d = (s: string | null | undefined) => (s ? new Date(s + 'T00:00:00Z') : null)
/** x + n years; 29 February falls back to the 28th (the prototype met one on an export). */
const addYears = (x: Date, n: number) => new Date(Date.UTC(x.getUTCFullYear() + n, x.getUTCMonth(),
  x.getUTCMonth() === 1 && x.getUTCDate() === 29 ? 28 : x.getUTCDate()))
const iso = (x: Date) => x.toISOString().slice(0, 10)
const money = (c: number) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function receivedDate(p: ParsedTranscript): Date | null {
  return d(p.returnLines.find(l => l.key === 'received_date')?.valueDate)
}

/** The latest date a refund of a payment on this period can still be claimed.
 *  `deemedPaid`, for a period with no return: the date its payments count as
 *  paid, whose 3 years the late return can still claim within. */
function refundWindow(p: ParsedTranscript, deemedPaid: Date | null = null): Date | null {
  const rec = receivedDate(p)
  const pays = p.txns.filter(t => (t.family === 'payment' || t.family === 'credit_in') && t.date).map(t => d(t.date)!)
  const lastPay = pays.length ? new Date(Math.max(...pays.map(x => x.getTime()))) : null
  const wins = [rec && addYears(rec, 3), lastPay && addYears(lastPay, 2), deemedPaid && addYears(deemedPaid, 3)].filter((x): x is Date => !!x)
  return wins.length ? new Date(Math.max(...wins.map(x => x.getTime()))) : null
}

function periodEndDay(year: number, month: number) {
  return new Date(Date.UTC(year, month - 1, 28))
}

const INCOME_FORMS = new Set(['1120', '1065', '1040', '1041', '990', '990EZ'])
const RETURN_FORMS = new Set([...INCOME_FORMS, '940', '941', '943', '944'])
const NOT_OWED = new Set(['590', '591', '594'])   // not liable / no longer liable / return filed earlier
const CLOSED: Record<string, string> = { '593': 'taxpayer not located', '597': 'delinquency surveyed', '598': 'delinquency shelved' }
// Evidence an individual's filing pattern gives, and no more (see missingReturn).
const PATTERN = new Set(['return posted the year before', 'returns posted for periods before and after'])
const PENDING_DAYS = 120   // a return filed near its due date can take this long to post
const DAY = 86_400_000

const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0))
/** n months after `day`: on day `dom` of that month, or its last day. */
function monthsAfter(day: Date, n: number, dom?: number) {
  const k = day.getUTCMonth() + n
  const y = day.getUTCFullYear() + Math.floor(k / 12), m = (((k % 12) + 12) % 12) + 1   // n may be negative
  return dom ? new Date(Date.UTC(y, m - 1, dom)) : monthEnd(y, m)
}
/** [due, extended due or null]. Weekend and holiday shifts are ignored; the pending window absorbs them. */
function dueDates(form: string, pe: Date, scorp: boolean): [Date, Date | null] {
  if (form === '941') return [monthsAfter(pe, 1), null]
  if (form === '940' || form === '943' || form === '944') return [new Date(Date.UTC(pe.getUTCFullYear() + 1, 0, 31)), null]
  const due = form === '1065' || (form === '1120' && scorp) ? monthsAfter(pe, 3, 15)
    : form === '990' || form === '990EZ' ? monthsAfter(pe, 5, 15)
      : monthsAfter(pe, 4, 15)   // 1120, 1040, 1041 (a 1041 extension runs to Sept 30, read here as Oct 15)
  return [due, monthsAfter(due, 6, 15)]
}

const KWONG_START = new Date(Date.UTC(2020, 0, 20)), KWONG_END = new Date(Date.UTC(2023, 6, 10))
const LATE_FILING = new Set(['160', '166', '163', '234', '246']), LATE_PAYMENT = new Set(['270', '276'])
const DEPOSIT = new Set(['180', '186']), ESTIMATED = new Set(['170', '176', '173'])
const inKwong = (x: Date) => x >= KWONG_START && x <= KWONG_END

/** What the COVID window takes off a penalty whose deadline fell in it, or
 *  null. `filed`: when the return was received (a late-filing penalty). */
function kwong(p: Period, code: string, filed: Date | null, scorp: boolean): string | null {
  const pe = monthEnd(p.taxYear, p.periodMonth)
  if (ESTIMATED.has(code)) {
    // Installments: the 15th of months 4, 6, 9 and 12 of the year (an individual's last one in January).
    const due = (p.form === '1040' ? [4, 6, 9, 13] : [4, 6, 9, 12]).map(n => monthsAfter(pe, n - 12, 15))
    const n = due.filter(inKwong).length
    if (!n) return null
    return n === due.length ? 'estimated-tax installments all due in the COVID window (postponed to 2023-07-10): the whole penalty'
      : `${n} of ${due.length} estimated-tax installments due in the COVID window: only their part`
  }
  if (DEPOSIT.has(code)) return inKwong(pe) ? 'deposits due in the COVID window (postponed to 2023-07-10)' : null
  if (!LATE_FILING.has(code) && !LATE_PAYMENT.has(code)) return null
  if (!RETURN_FORMS.has(p.form)) return null
  const [due] = dueDates(p.form, pe, scorp)
  if (!inKwong(due)) return null
  if (LATE_PAYMENT.has(code)) return `payment due ${iso(due)}, in the COVID window: the part that ran before 2023-07-10`
  // Filed by 2023-07-10, none of it was late; a little after, only the months
  // before it fall away. Past the penalty's cap counted from 2023-07-10 (5
  // months; 12 for the per-shareholder/partner penalty), nothing changes.
  if (filed && filed <= KWONG_END) return `return due ${iso(due)}, filed ${iso(filed)}: on time under the postponement, the whole penalty`
  const capMonths = code === '246' || code === '234' ? 12 : 5
  if (filed && filed <= monthsAfter(KWONG_END, capMonths, 10)) return `return due ${iso(due)}, filed ${iso(filed)}: only the months before 2023-07-10`
  return null
}

const isScorp = (all: Period[]) => all.some(o => o.form === '1120' && /1120S/.test(o.parsed?.formTitle ?? ''))

/** When a no-return period's payments count as paid: April 15 of the next
 *  year for a 941/943/944 (IRC 6513(c)); otherwise the due date, extended if
 *  a TC 460 posted. Null for a form with no return rule. */
function deemedPaid(p: Period, scorp: boolean): Date | null {
  if (!RETURN_FORMS.has(p.form)) return null
  if (['941', '943', '944'].includes(p.form)) return new Date(Date.UTC(p.taxYear + 1, 3, 15))
  const [due, ext] = dueDates(p.form, monthEnd(p.taxYear, p.periodMonth), scorp)
  return ext && p.parsed?.txns.some(x => x.code === '460') ? ext : due
}

/** [type, note] for a "No tax return filed" period that looks owed, else null. */
function missingReturn(p: Period, all: Period[]): [OpportunityType, string] | null {
  const t = p.parsed!
  const asof = d(t.requestDate)
  if (!RETURN_FORMS.has(p.form) || !asof) return null
  const txs = t.txns
  const codes = new Set(txs.map(x => x.code))
  if ([...NOT_OWED].some(c => codes.has(c))) return null
  const pe = monthEnd(p.taxYear, p.periodMonth)
  const [due, ext] = dueDates(p.form, pe, isScorp(all))
  const extended = !!ext && codes.has('460')
  const last = extended ? ext! : due
  if (asof <= last) return null
  const filed = all.filter(o => o.form === p.form && o.status === 'filed').map(o => monthEnd(o.taxYear, o.periodMonth).getTime())
  const ev: string[] = [], doubt: string[] = []
  const paid = txs.some(x => (x.family === 'payment' || x.family === 'credit_in') && (x.amountCents ?? 0) < 0)
  if (t.balanceCents != null && t.balanceCents < 0) ev.push('deposits still on the period')
  else if (paid) {
    if (codes.has('388') && !codes.has('389')) ev.push('deposits made then written off (refund time expired)')
    else if (codes.has('652')) { ev.push('deposits made'); doubt.push('the deposits were moved to another period') }
    else ev.push('deposits made')
  }
  if (extended) ev.push('extension filed')
  if (codes.has('140')) ev.push('IRS non-filing inquiry')
  if (filed.some(x => x < pe.getTime()) && filed.some(x => x > pe.getTime())) ev.push('returns posted for periods before and after')
  if (INCOME_FORMS.has(p.form)) {
    if (filed.includes(monthEnd(p.taxYear - 1, p.periodMonth).getTime())) ev.push('return posted the year before')
    if ((p.form === '1120' || p.form === '1065') && filed.length
      && all.some(o => o.status === 'filed' && o.taxYear === p.taxYear && ['941', '943', '944'].includes(o.form))) ev.push('payroll returns filed that year')
  }
  if (!ev.length) return null
  // An individual's filing pattern alone proves little (prototype, first
  // export: 1,783 such 1040 periods held only the 8821's TC 960): there may
  // have been no filing requirement, or the return is a joint one under the
  // spouse's number. Money, an extension or an IRS inquiry is needed.
  if (p.form === '1040' && ev.every(e => PATTERN.has(e))) {
    doubt.push('an individual with a filing pattern only (no return may have been required, or it is joint under the spouse)')
  }
  for (const [c, w] of Object.entries(CLOSED)) if (codes.has(c)) doubt.push(`IRS closed the delinquency without a return (${w})`)
  if (codes.has('599')) doubt.push('IRS marked a return secured but none posted here')
  if (codes.has('976') || txs.some(x => x.action === 'misposted_return' || x.action === 'duplicate_return')) doubt.push('a duplicate or amended return posted here with no original')
  const head = `The IRS shows no return; due ${iso(last)}${extended ? ' (extended)' : ''}`
  const late = Math.round((asof.getTime() - last.getTime()) / DAY)
  if (late <= PENDING_DAYS) return ['missing_return_pending', `${head}; not posted ${late} days later; evidence: ${ev.join(', ')}`]
  return [doubt.length ? 'missing_return_unclear' : 'missing_return', `${head}; evidence: ${ev.join(', ')}${doubt.length ? `; doubt: ${doubt.join(', ')}` : ''}`]
}

export function findOpportunities(periods: Period[], today: Date, maxYear = today.getUTCFullYear() - 1): Opportunity[] {
  const out: Opportunity[] = []
  const add = (p: Period, type: OpportunityType, amountCents: number | null, note: string, extra: Partial<Opportunity> = {}) =>
    out.push({ section: sectionOfForm(p.form), type, form: p.form, taxYear: p.taxYear, periodMonth: p.periodMonth, amountCents, note, ...extra })

  // Read each transaction's family, reversal and action from today's tables,
  // not from when its transcript was stored: a stored transcript is not
  // parsed again until the IRS record changes.
  periods = periods.map(p => (p.parsed ? { ...p, parsed: { ...p.parsed, txns: p.parsed.txns.map(reclassify) } } : p))
  const withData = periods.filter(p => p.parsed && p.taxYear <= maxYear)
  const scorp = isScorp(periods)

  for (const p of withData) {
    const t = p.parsed!
    const txs = [...t.txns].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    const openHold = txs.filter(x => x.code === '570' || x.code === '810').length > txs.filter(x => x.code === '571' || x.code === '811').length
    const bal = t.balanceCents
    const mr = p.status === 'no_return_filed' ? missingReturn(p, periods) : null

    if (bal != null && bal < 0) {
      if (p.status === 'filed') {
        // An allowed credit is the IRS's to refund; the claim window matters only for new claims.
        const credits = txs.filter(x => x.date && (x.amountCents ?? 0) < 0).map(x => x.date!)
        const lastCredit = credits.length ? credits.sort().at(-1)! : null
        const refundedAfter = txs.some(x => x.code === '846' && x.date && lastCredit && x.date >= lastCredit)
        add(p, 'credit_held', -bal, `Credit on the account since ${lastCredit ?? 'an unknown date'}; ${refundedAfter ? 'a refund was issued since but a balance remains' : 'no refund issued'}${openHold ? '; a freeze or hold is open' : ''}.`)
      } else if (p.status === 'no_return_filed') {
        const w = refundWindow(t, deemedPaid(p, scorp))
        const when = w ? `refund window ${w < today ? 'closed' : 'open to'} ${iso(w)}` : 'refund window unknown'
        if (mr) add(p, mr[0], -bal, `${mr[1]}; ${when}${openHold ? '; a hold is open' : ''}.`)
        else add(p, 'deposits_no_return', -bal, `The IRS shows no return filed; ${when}${openHold ? '; a hold is open' : ''}.`)
      }
    }
    if (mr && !(bal != null && bal < 0)) add(p, mr[0], null, `${mr[1]}.`)
    for (const x of txs) {
      // Owed back only while the money is still on the account: a later
      // assessment or offset can absorb it. Capped at the credit still there.
      const credit = -(bal ?? 0)
      if ((x.code === '740' || x.code === '841') && credit > 0 && !txs.some(y => y.code === '846' && y.date && x.date && y.date > x.date)) {
        add(p, 'refund_not_reissued', Math.min(Math.abs(x.amountCents ?? 0), credit), `TC ${x.code} ${x.description} ${x.date ?? ''}`.trim() + '; not reissued.')
      }
      if (x.action === 'claim_forwarded') {
        const after = txs.some(y => y.date && x.date && y.date > x.date && ['assessment', 'refundable_credit', 'refund', 'credit_out'].includes(y.family))
        if (!after) add(p, 'claim_pending', null, `Claim forwarded ${x.date ?? ''}; nothing posted since.`.replace('  ', ' '))
      }
      if (x.action === 'claim_disallowed') add(p, 'claim_disallowed', null, `Disallowed ${x.secondaryDate ?? x.date ?? ''}.`)
    }
  }

  // Penalties: what stands per family key per period, then what abatement is
  // worth. A family's codes share one key (codes.ts penaltyKeyOf); interest
  // is never a penalty.
  const standingOf = (t: ParsedTranscript) => {
    const m = new Map<string, number>()
    for (const x of t.txns) if (x.family === 'penalty' || x.family === 'interest') m.set(penaltyKeyOf(x.code), (m.get(penaltyKeyOf(x.code)) ?? 0) + (x.amountCents ?? 0))
    return m
  }
  const standingBy = new Map<string, Map<string, number>>()   // form|year|month -> key -> cents
  const assessed: Array<{ form: string; year: number; month: number; code: string }> = []
  const ftaUsed: Array<{ form: string; date: string }> = []
  const ia: Array<{ date: string; inForce: boolean }> = []
  for (const p of periods) {
    if (!p.parsed) continue
    standingBy.set(`${p.form}|${p.taxYear}|${p.periodMonth}`, standingOf(p.parsed))
    for (const x of p.parsed.txns) {
      if (x.family === 'penalty' && !x.reverses) assessed.push({ form: p.form, year: p.taxYear, month: p.periodMonth, code: x.code })
      if (x.action === 'first_time_abatement' && x.date) ftaUsed.push({ form: p.form, date: x.date })
      if ((x.action === 'installment_agreement' || x.action === 'installment_removed') && x.date) ia.push({ date: x.date, inForce: x.action === 'installment_agreement' })
    }
  }
  // An installment agreement in force (the latest of established/removed)
  // meets first-time abatement's "paid or arranged to pay".
  const agreement = ia.sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.inForce ?? false
  const REMOVED_PRIOR = '; but a penalty in the 3 years before was removed — if that was by first-time abatement, it is used up'

  for (const p of withData) {
    const t = p.parsed!
    const standing = standingBy.get(`${p.form}|${p.taxYear}|${p.periodMonth}`)!
    const interest = standing.get('196') ?? 0
    const filed = receivedDate(t) ?? d(t.txns.find(x => x.code === '150')?.date)
    const window = refundWindow(t)
    // What abatement is worth: the part of a penalty still owed only comes
    // off the balance; the part paid comes back only inside the refund
    // window. Which payment went to which charge is not on the transcript,
    // so money back is counted conservatively (only what cannot be hiding in
    // the balance due), and the balance due is handed to the period's
    // penalties largest first, so the reductions never add up to more than is
    // owed. (Prototype, 2026-10-26: a proportional split called 13,743 of a
    // 99,660 late-payment penalty refundable on a period whose whole balance
    // due WAS that penalty.)
    const dueNow = Math.max(t.balanceCents ?? 0, 0)
    let owedLeft = dueNow
    let penTotal = 0, intTotal = 0
    for (const [k, v] of standing) if (v > 50) { if (INTEREST_CODES.has(k)) intTotal += v; else penTotal += v }
    const taxOwed = Math.max(0, dueNow - penTotal - intTotal)
    const listed = [...standing].filter(([code, amt]) => !INTEREST_CODES.has(code) && amt > 50).sort((a, b) => b[1] - a[1])
    for (const [code, amt] of listed) {
      const kw = kwong(p, code, filed, scorp)
      if (NOT_ABATABLE.has(code) && !kw) continue
      const pend = periodEndDay(p.taxYear, p.periodMonth)
      const lookback = addYears(pend, -3)
      // A prior penalty counts against first-time abatement only while it
      // stands; one the IRS removed may have been removed BY first-time
      // abatement, which the transcript does not always say: noted.
      const earlier = assessed.filter(a => a.form === p.form && FTA_CODES.has(a.code) && lookback < periodEndDay(a.year, a.month) && periodEndDay(a.year, a.month) < pend)
      const stands = (a: typeof earlier[number]) => (standingBy.get(`${a.form}|${a.year}|${a.month}`)?.get(penaltyKeyOf(a.code)) ?? 0) > 50
      const prior = earlier.some(stands)
      const removedPrior = earlier.some(a => !stands(a))
      const used = ftaUsed.some(u => u.form === p.form && d(u.date)! >= lookback && d(u.date)! <= today)
      const lowers = Math.min(amt, owedLeft)
      owedLeft -= lowers
      const paidPart = Math.max(0, amt - dueNow)
      const refund = paidPart > 50 && window && window >= today ? paidPart : 0
      if (lowers < 50 && refund < 50) continue
      let viable = paidPart < 50 ? 'unpaid, so abatement lowers the balance due; no refund'
        : lowers < 50 ? `paid; refundable until ${iso(window!)}`
          : `partly paid: abatement lowers the balance due by up to ${money(lowers)} and ${refund ? `refunds at least ${money(refund)} (until ${iso(window!)})` : 'the paid part is outside the refund window'}`
      if (taxOwed > 50) viable += `; about ${money(taxOwed)} of tax is still owed on the period, which abatement does not touch`
      const label = PENALTY_NAME[code] ?? `TC ${code}`
      const intNote = interest > 0 ? `; interest on the period ${money(interest)}` : ''
      const ftaFits = FTA_CODES.has(code) && !prior && !used
      // First-time abatement also needs the tax paid or an installment agreement.
      const ftaWaits = ftaFits && taxOwed > 50 && !agreement
      const removed = removedPrior ? REMOVED_PRIOR : ''
      const money_ = { refundCents: refund, lowersOwedCents: lowers }
      if (kw) {
        add(p, 'penalty_covid_kwong', amt, `${cap(label)} penalty (TC ${code}); ${kw}; ${viable}; first-time abatement ${ftaFits ? `also fits${ftaWaits ? ' once the tax is paid' : ''}` : 'does not fit'}${interest > 0 ? `; interest on the period ${money(interest)} (the window may take some off too)` : ''}.`, money_)
      } else if (ftaWaits) {
        add(p, 'penalty_fta_after_payment', amt, `${cap(label)} penalty (TC ${code}); first-time abatement fits once the tax is paid or an installment agreement is in place${removed}; ${viable}${intNote}.`, money_)
      } else if (ftaFits) {
        add(p, 'penalty_fta', amt, `${cap(label)} penalty (TC ${code}); first-time abatement fits${removed}; ${viable}${intNote}.`, money_)
      } else {
        const why = !FTA_CODES.has(code) ? 'not a first-time-abatement penalty' : prior ? 'a penalty in the 3 years before' : 'first-time abatement used in the last 3 years'
        add(p, 'penalty_reasonable_cause', amt, `${cap(label)} penalty (TC ${code}); ${why}; ${viable}${intNote}.`, money_)
      }
    }
  }

  // A cancelled or undelivered refund puts the money back on the account: one opportunity, not two.
  const keyOf = (o: Opportunity) => `${o.form}|${o.taxYear}|${o.periodMonth}`
  const refunds = new Map<string, Opportunity[]>()
  for (const o of out) if (o.type === 'refund_not_reissued') refunds.set(keyOf(o), [...(refunds.get(keyOf(o)) ?? []), o])
  const merged: Opportunity[] = []
  const heldKeys = new Set(out.filter(o => o.type === 'credit_held').map(keyOf))
  for (const o of out) {
    if (o.type === 'credit_held' && refunds.has(keyOf(o))) {
      merged.push({ ...o, type: 'refund_not_reissued', note: refunds.get(keyOf(o))!.map(r => r.note).join(' ') + ' The money is back on the account.' })
    } else if (o.type === 'refund_not_reissued' && heldKeys.has(keyOf(o))) {
      continue
    } else merged.push(o)
  }
  return merged.sort((a, b) => a.taxYear - b.taxYear || a.form.localeCompare(b.form) || a.periodMonth - b.periodMonth || a.type.localeCompare(b.type))
}

const reclassify = (x: Txn): Txn => ({ ...x, family: familyOf(x.code), reverses: reversesOf(x.code), action: actionOf(x.code, x.explanation) })

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Retention-credit refunds received per calendar year: TC 846 refunds on the
 *  2020–2021 941 quarters that carry a TC 766 credit, by the refund's year. */
export function retentionRefundsByYear(periods: Period[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const p of periods) {
    if (p.form !== '941' || (p.taxYear !== 2020 && p.taxYear !== 2021) || !p.parsed) continue
    const txs: Txn[] = p.parsed.txns
    if (!txs.some(t => t.code === '766')) continue
    for (const t of txs) if (t.code === '846' && t.date) out.set(+t.date.slice(0, 4), (out.get(+t.date.slice(0, 4)) ?? 0) + (t.amountCents ?? 0))
  }
  return out
}
