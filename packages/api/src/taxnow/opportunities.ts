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
 *    puts the money back on the account: one opportunity, not two.
 *  - A penalty counts only if it can still pay: unpaid (the period owes), or
 *    paid and inside the refund window, estimated as three years from the
 *    return's received date or two years from the period's last payment.
 *    Paid penalties outside it are dropped (one org: 185 of them, $283K).
 *  - Estimated-tax penalties and collection fees are not abatable.
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
 * closed, 593/597/598), "pending" within 120 days of the due date, and never
 * raised where the IRS says no return is owed (590/591/594). deposits_no_return
 * is what is left: credit on a no-return period that is none of these.
 */
import { FTA_CODES, NOT_ABATABLE, PENALTY_NAME, sectionOfForm } from './codes.js'
import type { ParsedTranscript, PeriodStatus, Txn } from './transcript.js'

export interface Period {
  form: string
  taxYear: number
  periodMonth: number
  status: PeriodStatus
  parsed: ParsedTranscript | null
}

export type OpportunityType =
  | 'credit_held' | 'missing_return' | 'missing_return_unclear' | 'missing_return_pending' | 'deposits_no_return' | 'refund_not_reissued' | 'penalty_fta' | 'penalty_reasonable_cause'
  | 'claim_pending' | 'claim_disallowed'

export interface Opportunity {
  section: 'income' | 'payroll'
  type: OpportunityType
  form: string
  taxYear: number
  periodMonth: number
  amountCents: number | null
  note: string
}

const d = (s: string | null | undefined) => (s ? new Date(s + 'T00:00:00Z') : null)
const addYears = (x: Date, n: number) => new Date(Date.UTC(x.getUTCFullYear() + n, x.getUTCMonth(), x.getUTCDate()))
const iso = (x: Date) => x.toISOString().slice(0, 10)
const money = (c: number) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function receivedDate(p: ParsedTranscript): Date | null {
  return d(p.returnLines.find(l => l.key === 'received_date')?.valueDate)
}

/** The latest date a refund of a payment on this period can still be claimed. */
function refundWindow(p: ParsedTranscript): Date | null {
  const rec = receivedDate(p)
  const pays = p.txns.filter(t => (t.family === 'payment' || t.family === 'credit_in') && t.date).map(t => d(t.date)!)
  const lastPay = pays.length ? new Date(Math.max(...pays.map(x => x.getTime()))) : null
  const wins = [rec && addYears(rec, 3), lastPay && addYears(lastPay, 2)].filter((x): x is Date => !!x)
  return wins.length ? new Date(Math.max(...wins.map(x => x.getTime()))) : null
}

function periodEndDay(year: number, month: number) {
  return new Date(Date.UTC(year, month - 1, 28))
}

const INCOME_FORMS = new Set(['1120', '1065', '1040', '990', '990EZ'])
const RETURN_FORMS = new Set([...INCOME_FORMS, '940', '941', '943', '944'])
const NOT_OWED = new Set(['590', '591', '594'])   // not liable / no longer liable / return filed earlier
const CLOSED: Record<string, string> = { '593': 'taxpayer not located', '597': 'delinquency surveyed', '598': 'delinquency shelved' }
const PENDING_DAYS = 120   // a return filed near its due date can take this long to post
const DAY = 86_400_000

const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0))
/** n months after `day`: on day `dom` of that month, or its last day. */
function monthsAfter(day: Date, n: number, dom?: number) {
  const k = day.getUTCMonth() + n
  const y = day.getUTCFullYear() + Math.floor(k / 12), m = (k % 12) + 1
  return dom ? new Date(Date.UTC(y, m - 1, dom)) : monthEnd(y, m)
}
/** [due, extended due or null]. Weekend and holiday shifts are ignored; the pending window absorbs them. */
function dueDates(form: string, pe: Date, scorp: boolean): [Date, Date | null] {
  if (form === '941') return [monthsAfter(pe, 1), null]
  if (form === '940' || form === '943' || form === '944') return [new Date(Date.UTC(pe.getUTCFullYear() + 1, 0, 31)), null]
  const due = form === '1065' || (form === '1120' && scorp) ? monthsAfter(pe, 3, 15)
    : form === '990' || form === '990EZ' ? monthsAfter(pe, 5, 15)
      : monthsAfter(pe, 4, 15)   // 1120, 1040
  return [due, monthsAfter(due, 6, 15)]
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
  const scorp = all.some(o => o.form === '1120' && /1120S/.test(o.parsed?.formTitle ?? ''))
  const [due, ext] = dueDates(p.form, pe, scorp)
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
  const add = (p: Period, type: OpportunityType, amountCents: number | null, note: string) =>
    out.push({ section: sectionOfForm(p.form), type, form: p.form, taxYear: p.taxYear, periodMonth: p.periodMonth, amountCents, note })

  const withData = periods.filter(p => p.parsed && p.taxYear <= maxYear)

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
        const w = refundWindow(t)
        const when = w ? `refund window ${w < today ? 'closed' : 'open to'} ${iso(w)}` : 'refund window unknown'
        if (mr) add(p, mr[0], -bal, `${mr[1]}; ${when}${openHold ? '; a hold is open' : ''}.`)
        else add(p, 'deposits_no_return', -bal, `The IRS shows no return filed; ${when}${openHold ? '; a hold is open' : ''}.`)
      }
    }
    if (mr && !(bal != null && bal < 0)) add(p, mr[0], null, `${mr[1]}.`)
    for (const x of txs) {
      if ((x.code === '740' || x.code === '841') && !txs.some(y => y.code === '846' && y.date && x.date && y.date > x.date)) {
        add(p, 'refund_not_reissued', Math.abs(x.amountCents ?? 0), `TC ${x.code} ${x.description} ${x.date ?? ''}`.trim() + '; not reissued.')
      }
      if (x.action === 'claim_forwarded') {
        const after = txs.some(y => y.date && x.date && y.date > x.date && ['assessment', 'refundable_credit', 'refund', 'credit_out'].includes(y.family))
        if (!after) add(p, 'claim_pending', null, `Claim forwarded ${x.date ?? ''}; nothing posted since.`.replace('  ', ' '))
      }
      if (x.action === 'claim_disallowed') add(p, 'claim_disallowed', null, `Disallowed ${x.secondaryDate ?? x.date ?? ''}.`)
    }
  }

  // Penalties: standing amount per code per period, then whether it can still pay.
  const assessed: Array<{ form: string; year: number; month: number; code: string }> = []
  const ftaUsed: Array<{ form: string; date: string }> = []
  for (const p of periods) for (const x of p.parsed?.txns ?? []) {
    if (x.family === 'penalty' && !x.reverses) assessed.push({ form: p.form, year: p.taxYear, month: p.periodMonth, code: x.code })
    if (x.action === 'first_time_abatement' && x.date) ftaUsed.push({ form: p.form, date: x.date })
  }
  for (const p of withData) {
    const t = p.parsed!
    const standing = new Map<string, number>()
    for (const x of t.txns) {
      if (x.family !== 'penalty' && x.family !== 'interest') continue
      const code = x.reverses ?? x.code
      standing.set(code, (standing.get(code) ?? 0) + (x.amountCents ?? 0))
    }
    const interest = standing.get('196') ?? 0
    for (const [code, amt] of standing) {
      if (code === '196' || amt <= 50 || NOT_ABATABLE.has(code)) continue
      const pend = periodEndDay(p.taxYear, p.periodMonth)
      const lookback = addYears(pend, -3)
      const prior = assessed.some(a => a.form === p.form && FTA_CODES.has(a.code) && lookback < periodEndDay(a.year, a.month) && periodEndDay(a.year, a.month) < pend)
      const used = ftaUsed.some(u => u.form === p.form && d(u.date)! >= lookback && d(u.date)! <= today)
      let viable: string
      if ((t.balanceCents ?? 0) > 0) viable = 'unpaid, so abatement lowers the balance due'
      else {
        const w = refundWindow(t)
        if (w && w >= today) viable = `paid; refundable until ${iso(w)}`
        else continue
      }
      const label = PENALTY_NAME[code] ?? `TC ${code}`
      const intNote = interest > 0 ? `; interest on the period ${money(interest)}` : ''
      if (FTA_CODES.has(code) && !prior && !used) {
        add(p, 'penalty_fta', amt, `${cap(label)} penalty (TC ${code}); first-time abatement fits; ${viable}${intNote}.`)
      } else {
        const why = !FTA_CODES.has(code) ? 'not a first-time-abatement penalty' : prior ? 'a penalty in the 3 years before' : 'first-time abatement used in the last 3 years'
        add(p, 'penalty_reasonable_cause', amt, `${cap(label)} penalty (TC ${code}); ${why}; ${viable}${intNote}.`)
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
