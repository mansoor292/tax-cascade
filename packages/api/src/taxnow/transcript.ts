/**
 * A TaxNow account transcript (HTML) → one structured period.
 *
 * The HTML is the complete source; TaxNow's JSON for the same transcript
 * drops the code-less "No tax return filed" line, the cycles and the
 * document numbers (learned 2026-10-24 on 2,771 transcripts). Without that
 * line a period with deposits and no return looks the same as one with a
 * return in progress, so the missing-return finding cannot be made.
 *
 * Every form-period gets ONE status, because the "nothing" answers mean
 * different things and were never to be merged:
 *   filed               a return posted (TC 150)
 *   no_return_filed     the IRS has the period (payments, a representative…)
 *                       and prints "No tax return filed"
 *   activity_no_return  activity, neither a return nor that line
 *   no_irs_account      "Requested data not found": authorized, no account
 *   not_authorized      the IRS refused (451): the 8821 on file does not cover
 *                       this TIN/form/period (fiscal periods are refused when
 *                       it lists December year-ends)
 *   never_synced        TaxNow has never pulled it
 * The last two have no HTML; statusWithoutHtml() decides between them.
 * An imported export adds a seventh, no_transactions: the export lists the
 * period with nothing in it (taxnow/export.ts) — it cannot say which of the
 * "nothing" answers the IRS gave.
 *
 * Port of ~/taxnow-data/tools/parse_tx_html.py + build_db.py.
 */
import { parse as parseHtml, type HTMLElement } from 'node-html-parser'
import { familyOf, reversesOf, actionOf, type Family, type Action } from './codes.js'

export type PeriodStatus = 'filed' | 'no_return_filed' | 'activity_no_return' | 'no_irs_account' | 'not_authorized' | 'never_synced' | 'no_transactions'

export interface Txn {
  seq: number
  code: string
  family: Family
  action: Action | null
  reverses: string | null
  explanation: string
  description: string
  cycle: string | null
  date: string | null
  amountCents: number | null
  dln: string | null
  secondaryDate: string | null
  otherForm: string | null
  otherPeriod: string | null
}

export interface ReturnLine { key: string; label: string; valueText: string; valueCents: number | null; valueDate: string | null }

export interface ParsedTranscript {
  formTitle: string
  requestDate: string | null
  responseDate: string | null
  trackingNumber: string | null
  tinLast4: string | null
  dataFound: boolean
  noReturnFiled: boolean
  balanceCents: number | null
  balancePlusAccrualsCents: number | null
  accruedInterestCents: number | null
  accruedInterestAsOf: string | null
  accruedPenaltyCents: number | null
  accruedPenaltyAsOf: string | null
  returnLines: ReturnLine[]
  txns: Txn[]
  status: Exclude<PeriodStatus, 'not_authorized' | 'never_synced' | 'no_transactions'>
}

const MONEY = /^(-?)\$([\d,]+\.\d{2})$/
const DLN = /\b(\d{5}-\d{3}-\d{5}-\d)\b/
const DATE = /\b(\d{2})-(\d{2})-(\d{4})\b/
const DATE_G = /\b(\d{2})-(\d{2})-(\d{4})\b/g
// "Credit transferred out to 1120 202312", "… to 1120 Series 202312",
// "… to Civil Penalty (Business) 202312", "Federal tax deposit 941 20240630"
const TRANSFER = /\s(\d{3,4}(?: Series)?|Civil Penalty \(Business\))\s+(\d{6,8})\s*$/

export function cents(v: string | null | undefined): number | null {
  const m = MONEY.exec((v ?? '').trim())
  if (!m) return null
  return (m[1] ? -1 : 1) * Math.round(parseFloat(m[2].replace(/,/g, '')) * 100)
}

export function isoDate(v: string | null | undefined): string | null {
  const m = DATE.exec(v ?? '')
  if (!m || m[3] === '0000') return null
  return `${m[3]}-${m[1]}-${m[2]}`
}

function keyOf(label: string): string {
  const l = label.toLowerCase().replace(/:$/, '')
  const named: Array<[RegExp, string]> = [
    [/^total tax per/, 'total_tax'], [/^return due date or return received/, 'received_date'], [/^processed date/, 'processed_date'],
    [/principal business activity/, 'naics'], [/estimated tax payments/, 'estimated_payments'], [/deposited with form 7004/, 'deposit_7004'],
  ]
  for (const [re, k] of named) if (re.test(l)) return k
  return l.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

const txt = (e: HTMLElement | null | undefined) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '')

interface Item { label: string; value: string }

function items(scope: HTMLElement | null): Item[] {
  if (!scope) return []
  return scope.querySelectorAll('.item-container').map(c => ({ label: txt(c.querySelector('.item-label')), value: txt(c.querySelector('.item-value')) }))
}

/** Parse one account transcript's HTML. TINs are reduced to their last four. */
export function parseTranscriptHtml(html: string): ParsedTranscript {
  const doc = parseHtml(html, { comment: false })
  const header: Record<string, string> = {}
  for (const lab of doc.querySelectorAll('.header-label')) {
    const dd = lab.nextElementSibling
    header[txt(lab).replace(/:$/, '')] = txt(dd)
  }
  const sections = new Map<string, HTMLElement>()
  for (const s of doc.querySelectorAll('section')) sections.set((s.getAttribute('class') || s.getAttribute('id') || '').trim(), s)

  const dataFound = !/Requested data not found/.test(html)
  let fixed = Object.fromEntries(items(sections.get('FIXED') ?? null).map(i => [i.label.replace(/:$/, ''), i.value]))
  // "Requested data not found" pages carry the fixed items outside a section.
  if (!Object.keys(fixed).length) fixed = Object.fromEntries(items(doc).map(i => [i.label.replace(/:$/, ''), i.value]))
  const tin = fixed['Taxpayer Identification Number'] ?? ''
  const last4 = /(\d{4})\s*$/.exec(tin)?.[1] ?? null

  const amountsSec = sections.get('AMOUNTS') ?? null
  const amounts = Object.fromEntries(items(amountsSec).map(i => [i.label.replace(/:$/, ''), i.value]))
  const accruals: Record<string, { value: string; asOf: string }> = {}
  for (const c of amountsSec?.querySelectorAll('.interest-and-penalty') ?? []) {
    const m = /(.+?):\s*(-?\$[\d,]+\.\d{2})\s*As of:\s*(\S+)/.exec(txt(c))
    if (m) accruals[m[1].trim()] = { value: m[2], asOf: m[3] }
  }
  const balanceLabel = Object.keys(amounts).find(l => l.startsWith('Account balance plus accruals'))

  const returnLines: ReturnLine[] = items(sections.get('POSTEDRETURNINFORMATION') ?? null).map(i => ({
    key: keyOf(i.label), label: i.label.replace(/:$/, ''), valueText: i.value, valueCents: cents(i.value),
    valueDate: /^\d{2}-\d{2}-\d{4}$/.test(i.value.trim()) ? isoDate(i.value) : null,
  }))

  const table = sections.get('TRANSACTIONCODES')?.querySelector('table') ?? doc.querySelector('table#transaction-codes')
  const rows = (table?.querySelectorAll('tbody tr') ?? []).map(tr => tr.querySelectorAll('td').map(td => txt(td)))
  const noReturnFiled = rows.some(r => !r[0] && /No tax return filed/.test(r[1] ?? ''))

  const txns: Txn[] = []
  let has150 = false
  rows.forEach((r, seq) => {
    const [code, expl = '', cycle = '', date = '', amount = ''] = [...r, '', '', '', '', ''].slice(0, 5)
    if (!code) return
    if (code === '150') has150 = true
    const dln = DLN.exec(expl)
    let rest = expl.replace(DLN, '').trim()
    let otherForm: string | null = null
    let otherPeriod: string | null = null
    const tr = TRANSFER.exec(rest)
    if (tr) { otherForm = tr[1]; otherPeriod = tr[2]; rest = rest.slice(0, tr.index).trim() }
    txns.push({
      seq, code, family: familyOf(code), action: actionOf(code, expl), reverses: reversesOf(code),
      explanation: expl, description: rest.replace(DATE_G, '').replace(/\s+/g, ' ').trim(), cycle: cycle || null,
      date: isoDate(date), amountCents: cents(amount), dln: dln ? dln[1] : null, secondaryDate: isoDate(rest), otherForm, otherPeriod,
    })
  })

  const status: ParsedTranscript['status'] = !dataFound ? 'no_irs_account' : has150 ? 'filed' : noReturnFiled ? 'no_return_filed' : 'activity_no_return'
  const titleEl = doc.querySelector('h1')
  return {
    formTitle: txt(titleEl) || txt(doc.querySelector('title')),
    requestDate: isoDate(header['Request Date']), responseDate: isoDate(header['Response Date']),
    trackingNumber: header['Tracking Number'] || null, tinLast4: last4, dataFound, noReturnFiled,
    balanceCents: cents(amounts['Account balance']),
    balancePlusAccrualsCents: balanceLabel ? cents(amounts[balanceLabel]) : null,
    accruedInterestCents: cents(accruals['Accrued interest']?.value), accruedInterestAsOf: isoDate(accruals['Accrued interest']?.asOf),
    accruedPenaltyCents: cents(accruals['Accrued penalty']?.value), accruedPenaltyAsOf: isoDate(accruals['Accrued penalty']?.asOf),
    returnLines, txns, status,
  }
}

/** A period TaxNow lists but holds no HTML for: refused by the IRS when our
 *  last request for it came back 451, otherwise never synced. */
export function statusWithoutHtml(lastIrsCode: string | number | null | undefined): 'not_authorized' | 'never_synced' {
  return String(lastIrsCode ?? '') === '451' ? 'not_authorized' : 'never_synced'
}

/** An S-corporation's income transcripts sit in TaxNow's 1120 module; the
 *  title says which return it is ("Form 1120S Account Transcript"). */
export function returnFormOf(form: string, formTitle: string): string {
  if (form === '1120' && /1120-?S/.test(formTitle)) return '1120S'
  return form
}

export function periodEnd(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}
