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
  | 'credit_held' | 'deposits_no_return' | 'refund_not_reissued' | 'penalty_fta' | 'penalty_reasonable_cause'
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
        add(p, 'deposits_no_return', -bal, `The IRS shows no return filed; ${when}${openHold ? '; a hold is open' : ''}.`)
      }
    }
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
