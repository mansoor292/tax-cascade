/**
 * A TaxNow transaction export (CSV) → periods the opportunity rules read.
 *
 * Why (2026-10-26): Kenneth (TaxNow's owner) handed over an export of his
 * own book — 8,834 clients, ~845,000 transactions — as prospects he would
 * bring in under his own id. There is no 8821 with us for any of them, so
 * they are never read through TaxNow and never trigger an IRS pull: they
 * live in a practice of their own whose clients are IMPORTED, keyed by the
 * export's client number, so a later export (or his API, mapped later) can
 * attach to the same client.
 *
 * The export is one row per transaction:
 *   <client number>, form_number, tax_year, tax_period (month), transaction_index,
 *   code, explanation, transaction_date (M/D/YY, a few ISO),
 *   transaction_amount (dollars, the IRS's signs: tax and refunds +, payments -)
 * A period with no transactions is one row with no code. Clients carry a
 * number only — no name, no TIN.
 *
 * What it does NOT carry, and how each gap is filled (the same choices as the
 * prototype's ~/taxnow-data/tools/build_export_db.py, which this ports):
 *   balance        the sum of the period's transactions. Checked on the
 *                  API-read orgs: the IRS's own balance equals that sum in
 *                  3,676 of 3,677 periods. Accrued interest/penalty is not in it.
 *   status         filed if a TC150 posted; no_return_filed if anything else
 *                  posted, or the code is 'n/a' (the "No tax return filed"
 *                  line); no_transactions if the period is listed empty. The
 *                  export drops that line, so activity_no_return is not told apart.
 *   received date  the first TC150 date (later than the IRS received date, so
 *                  refund windows read slightly generous).
 *   as-of date     one date for every period: the export does not say when
 *                  each transcript was pulled.
 *   1120 vs 1120-S not told apart — every 1120 reads as a C-corp (due 4/15),
 *                  which only makes the missing-return rule later, never earlier.
 */
import { createHash } from 'node:crypto'
import { actionOf, familyOf, reversesOf } from './codes.js'
import type { ParsedTranscript, Txn } from './transcript.js'

export const EXPORT_HEADER = ['form_number', 'tax_year', 'tax_period', 'transaction_index', 'code', 'explanation', 'transaction_date', 'transaction_amount']

/** Same shape as transcript.ts's: "Credit transferred out to 1120 202312". */
const TRANSFER = /\s(\d{3,4}(?: Series)?|Civil Penalty \(Business\))\s+(\d{6,8})\s*$/

export type ExportStatus = 'filed' | 'no_return_filed' | 'no_transactions'

export interface ExportPeriod {
  form: string
  taxYear: number
  periodMonth: number
  status: ExportStatus
  parsed: ParsedTranscript
}

export interface ExportClient {
  /** The export's client number, as written (some are negative). */
  number: string
  /** 'individual' when every form is a 1040, else 'business'. */
  kind: 'individual' | 'business'
  periods: ExportPeriod[]
}

export interface ExportStats {
  sha256: string
  rows: number
  clients: number
  periods: number
  transactions: number
  by_status: Record<ExportStatus, number>
  by_form: Record<string, number>
  unparsed: { date: number; amount: number }
}

export class ExportFormatError extends Error {}

/** M/D/YY, M/D/YYYY or YYYY-MM-DD → ISO; anything else null. */
export function exportDate(v: string): string | null {
  v = (v ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v)
  if (!m) return null
  let y = Number(m[3])
  if (y <= 99) y = y < 70 ? 2000 + y : 1900 + y
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/** Dollars → cents; blank or unreadable → null. */
export function exportCents(v: string): number | null {
  const s = (v ?? '').trim().replace(/[,$]/g, '')
  if (!s || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null
  return Math.round(Number(s) * 100)
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
export function* csvRows(text: string): Generator<string[]> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = text.length
  while (i < n) {
    const row: string[] = []
    for (;;) {
      let field = ''
      if (text[i] === '"') {
        i++
        for (;;) {
          const q = text.indexOf('"', i)
          if (q < 0) { field += text.slice(i); i = n; break }
          field += text.slice(i, q)
          if (text[q + 1] === '"') { field += '"'; i = q + 2 } else { i = q + 1; break }
        }
      }
      let j = i
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++
      field += text.slice(i, j)
      row.push(field)
      i = j
      if (text[i] === ',') { i++; continue }
      if (text[i] === '\r') i++
      if (text[i] === '\n') i++
      break
    }
    if (row.length > 1 || row[0] !== '') yield row
  }
}

interface RawTxn { code: string; expl: string; date: string | null; cents: number | null }

/**
 * Read an export. `asOf` stands in for every period's pull date.
 *
 * `only` limits which clients' periods are built (the stats and the client
 * list always cover the whole file): a pm2 worker restarts past 768 MB, so a
 * batch builds its own few hundred clients, not all 845,000 transactions.
 */
export function parseExport(text: string, asOf: string, only?: Set<string>): { clients: ExportClient[]; numbers: Map<string, ExportClient['kind']>; stats: ExportStats } {
  const sha256 = createHash('sha256').update(text).digest('hex')
  interface Acc { client: string; form: string; year: number; month: number; txns: RawTxn[] | null; n: number; has150: boolean; nrf: boolean }
  const periods = new Map<string, Acc>()
  const unparsed = { date: 0, amount: 0 }
  let rows = 0
  let head = true
  for (const r of csvRows(text)) {
    if (head) {
      head = false
      if (r.slice(1).join(',') !== EXPORT_HEADER.join(',')) throw new ExportFormatError(`This is not a TaxNow transaction export: the columns should be <client>, ${EXPORT_HEADER.join(', ')}.`)
      continue
    }
    rows++
    const [client, form, yearS, monthS, , code = '', expl = '', date = '', amount = ''] = r
    const year = Number(yearS), month = Number(monthS)
    if (!client || !form || !Number.isInteger(year) || !Number.isInteger(month)) throw new ExportFormatError(`Row ${rows + 1} has no client, form or period.`)
    const k = `${client}|${form}|${year}|${month}`
    let p = periods.get(k)
    if (!p) { p = { client, form, year, month, txns: !only || only.has(client) ? [] : null, n: 0, has150: false, nrf: false }; periods.set(k, p) }
    if (!code) continue
    if (code === 'n/a') { p.nrf = true; continue } // the "No tax return filed" line: not a transaction
    p.n++
    if (code === '150') p.has150 = true
    const d = exportDate(date), c = exportCents(amount)
    if (date && !d) unparsed.date++
    if (amount && c == null) unparsed.amount++
    p.txns?.push({ code, expl: expl.trim(), date: d, cents: c })
  }

  const byClient = new Map<string, ExportPeriod[]>()
  const formsOf = new Map<string, Set<string>>()
  const byStatus: Record<ExportStatus, number> = { filed: 0, no_return_filed: 0, no_transactions: 0 }
  const byForm: Record<string, number> = {}
  let transactions = 0
  for (const p of periods.values()) {
    byForm[p.form] = (byForm[p.form] ?? 0) + 1
    ;(formsOf.get(p.client) ?? formsOf.set(p.client, new Set()).get(p.client)!).add(p.form)
    transactions += p.n
    const status: ExportStatus = p.has150 ? 'filed' : p.n || p.nrf ? 'no_return_filed' : 'no_transactions'
    byStatus[status]++
    if (!p.txns) continue
    const list = byClient.get(p.client) ?? byClient.set(p.client, []).get(p.client)!
    list.push({ form: p.form, taxYear: p.year, periodMonth: p.month, status, parsed: periodParsed(p.form, p.txns, status, p.nrf, asOf) })
  }

  const kindOf = (n: string): ExportClient['kind'] => [...formsOf.get(n)!].every(f => f === '1040') ? 'individual' : 'business'
  const numbers = new Map([...formsOf.keys()].sort(compareNumbers).map(n => [n, kindOf(n)] as const))
  const clients: ExportClient[] = [...byClient.entries()].map(([number, ps]) => ({
    number, kind: kindOf(number),
    periods: ps.sort((a, b) => a.form.localeCompare(b.form) || a.taxYear - b.taxYear || a.periodMonth - b.periodMonth),
  }))
  clients.sort((a, b) => compareNumbers(a.number, b.number))
  return { clients, numbers, stats: { sha256, rows, clients: formsOf.size, periods: periods.size, transactions, by_status: byStatus, by_form: byForm, unparsed } }
}

/** Client numbers in numeric order where they are numbers. */
export function compareNumbers(a: string, b: string): number {
  const x = Number(a), y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b)
}

function periodParsed(form: string, raw: RawTxn[], status: ExportStatus, nrf: boolean, asOf: string): ParsedTranscript {
  // The prototype orders by date (undated last), then code, keeping file order on ties.
  const ts = [...raw].sort((a, b) => cmp(a.date ?? '9999', b.date ?? '9999') || cmp(a.code, b.code))
  const txns: Txn[] = ts.map((t, seq) => {
    const tr = TRANSFER.exec(' ' + t.expl)
    return {
      seq, code: t.code, family: familyOf(t.code), action: actionOf(t.code, t.expl), reverses: reversesOf(t.code),
      explanation: t.expl, description: t.expl, cycle: null, date: t.date, amountCents: t.cents, dln: null, secondaryDate: null,
      otherForm: tr ? tr[1] : null, otherPeriod: tr ? tr[2] : null,
    }
  })
  const first150 = ts.filter(t => t.code === '150' && t.date).map(t => t.date!).sort()[0] ?? null
  return {
    formTitle: `Form ${form} Account Transcript (export)`,
    requestDate: asOf, responseDate: asOf, trackingNumber: null, tinLast4: null,
    dataFound: txns.length > 0, noReturnFiled: status === 'no_return_filed' && (nrf || txns.length > 0),
    balanceCents: txns.length ? txns.reduce((s, t) => s + (t.amountCents ?? 0), 0) : null,
    balancePlusAccrualsCents: null, accruedInterestCents: null, accruedInterestAsOf: null, accruedPenaltyCents: null, accruedPenaltyAsOf: null,
    returnLines: first150 ? [{ key: 'received_date', label: 'TC150 date (export: stands in for the received date)', valueText: first150, valueCents: null, valueDate: first150 }] : [],
    txns,
    // The rules read the period's own status; this field only types the shape.
    status: status === 'filed' ? 'filed' : 'no_return_filed',
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What an imported period stores (encrypted, taxnow_transcript.parsed): the
 * transactions as code, wording, date and amount only. Family, action,
 * reversal and transfer are re-derived on read (unpackParsed), the same way
 * the rules re-derive them, so the ~100,000 rows of an export hold about half
 * the bytes. `v` marks the shape; anything else is a parsed HTML transcript
 * and passes through unchanged.
 */
export interface PackedPeriod {
  v: 'export1'
  form: string
  asOf: string | null
  bal: number | null
  received: string | null
  nrf: boolean
  t: Array<[code: string, explanation: string, date: string | null, amountCents: number | null]>
}

export function packParsed(form: string, p: ParsedTranscript): PackedPeriod {
  return {
    v: 'export1', form, asOf: p.responseDate, bal: p.balanceCents,
    received: p.returnLines.find(l => l.key === 'received_date')?.valueDate ?? null, nrf: p.noReturnFiled,
    t: p.txns.map(x => [x.code, x.explanation, x.date, x.amountCents]),
  }
}

export function unpackParsed(raw: any): ParsedTranscript | null {
  if (!raw || raw.v !== 'export1') return raw ?? null
  const k = raw as PackedPeriod
  const txns: Txn[] = k.t.map(([code, expl, date, amt], seq) => {
    const tr = TRANSFER.exec(' ' + expl)
    return {
      seq, code, family: familyOf(code), action: actionOf(code, expl), reverses: reversesOf(code), explanation: expl, description: expl,
      cycle: null, date, amountCents: amt, dln: null, secondaryDate: null, otherForm: tr ? tr[1] : null, otherPeriod: tr ? tr[2] : null,
    }
  })
  return {
    formTitle: `Form ${k.form} Account Transcript (export)`, requestDate: k.asOf, responseDate: k.asOf, trackingNumber: null, tinLast4: null,
    dataFound: txns.length > 0, noReturnFiled: k.nrf, balanceCents: k.bal,
    balancePlusAccrualsCents: null, accruedInterestCents: null, accruedInterestAsOf: null, accruedPenaltyCents: null, accruedPenaltyAsOf: null,
    returnLines: k.received ? [{ key: 'received_date', label: 'TC150 date (export: stands in for the received date)', valueText: k.received, valueCents: null, valueDate: k.received }] : [],
    txns, status: txns.some(t => t.code === '150') ? 'filed' : 'no_return_filed',
  }
}
