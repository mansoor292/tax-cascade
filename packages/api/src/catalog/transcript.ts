/**
 * IRS transcripts as structured catalog entries.
 *
 * The IRS's own record of a return answers questions the return can't: when
 * it was actually received (statute dates run from there), whether a copy was
 * set aside as a duplicate (TC976 — EZA's 2021 return was received three
 * times), which penalties were assessed (TC166/246) and what is still owed.
 * EZA's 2021 transcript was the only proof the return had been filed at all.
 * Kept as text rows these facts are unusable by a check; parsed here into
 * entries: section 'Transactions' (line = transaction code, value = amount,
 * date), 'Account' (balances), 'Return information' (figures as processed)
 * and 'Header' (form, period).
 *
 * Three kinds of transcript arrive (2026-10-20, 47 of them in one pull):
 *  - the ACCOUNT transcript: balances and transaction codes (form
 *    'irs_transcript');
 *  - the RETURN transcript: the IRS's line-by-line copy of the return as it
 *    processed it (form 'irs_return_transcript', section = the IRS's own
 *    heading — 'Income', 'Schedule L - Balance Sheets per Books' …);
 *  - the RECORD OF ACCOUNT: both, account part first.
 * Until then every return-transcript line after page 1 was filed as a
 * generic statement row under a junk heading and page 1's figures landed in
 * 'Header' as text — catalogued "complete" yet unusable, and the line-by-line
 * proof that EZA's 2024 slot holds its 2023 return was nowhere a check could
 * read it.
 */
import type { CatalogEntry } from './types.js'

export function isTranscriptText(text: string): boolean {
  return /This Product Contains Sensitive Taxpayer Data|Transcript Delivery System|Report for Tax Period Ending|ACCOUNT TRANSCRIPT|RECORD OF ACCOUNT|TAX RETURN TRANSCRIPT|WAGE AND INCOME TRANSCRIPT/i.test(text)
}

export type TranscriptType = 'account' | 'return' | 'record_of_account' | 'wage_income' | 'other'

/** Which parts a transcript type carries. A record of account is both. */
export function transcriptParts(type: TranscriptType | null | undefined): Array<'account' | 'return'> {
  if (type === 'record_of_account') return ['account', 'return']
  if (type === 'return') return ['return']
  if (type === 'account' || !type) return ['account']
  return []
}

const TITLES: Array<[RegExp, TranscriptType]> = [
  [/Record of Account/i, 'record_of_account'],
  [/Tax Return Transcript/i, 'return'],
  [/Account Transcript/i, 'account'],
  [/Wage (?:and|&) Income Transcript/i, 'wage_income'],
  [/Verification of Non-?filing|Entity Transcript|Civil Penalty/i, 'other'],
]

/** "No record of return filed." (return transcript), "Requested data not
 *  found." (record of account): the IRS has nothing for the period. An
 *  account transcript says "No tax return filed" among its transactions
 *  instead — that one still carries an account, so it is not a no-record. */
const NO_RECORD = /^(No record of return filed|Requested data not found|No record found)\.?$/i

const MONEY = /-?\$[\d,]+\.\d{2}/
const DATE = /\d{2}-\d{2}-\d{4}/
const DLN = /^\d{5}-\d{3}-\d{5}-\d$/

function money(s: string): number | null {
  const m = MONEY.exec(s)
  if (!m) return null
  const n = Number(m[0].replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface TranscriptLine { raw: string; bbox: [number, number, number, number] }

export interface TranscriptContext {
  section: string
  form?: string
  period?: string
  lastTxn?: CatalogEntry
  /** Set from the title line ("Form 1120S Record of Account") */
  type?: TranscriptType
  /** Which part is being read: a record of account switches to 'return'
   *  where the return section begins */
  part?: 'account' | 'return'
  /** The IRS's response date: which of two transcripts is newer */
  asOf?: string
  noRecord?: boolean
  /** Return part: occurrences of each heading (a repeated schedule is
   *  instance #2 …) and of each line within a heading instance */
  instance?: string
  headings?: Map<string, number>
  lines?: Map<string, number>
  /** Return part: a text line awaiting the next one — the first half of a
   *  wrapped label ("…railroad compensation per" / "  computer: $0.00"),
   *  or else a sub-heading ("Income or Loss From Partnerships and S-Corps") */
  pendingRow?: CatalogEntry
  subheading?: string
}

const HEADER_KEYS = /^(Form Number|Report for Tax Period Ending|Taxpayer Identification Number|Spouse Taxpayer Identification Number|Request Date|Response Date|Tracking Number|Tax Period)\s*:?\s*(.*)$/i
const ACCOUNT_KEYS = /^(Account balance plus accruals.*?|Account balance|Accrued interest|Accrued penalty)\s*:?\s*(.*)$/i
const BOILERPLATE = /^(This Product Contains Sensitive Taxpayer Data|Page \d+\s*(?:\/|of)\s*\d+)$/i

/** A heading in a return transcript is printed centred; a data line runs
 *  from the left margin to the amount at the right. */
function centred(bbox: [number, number, number, number], width: number): boolean {
  const cx = (bbox[0] + bbox[2]) / 2
  return bbox[0] > width * 0.12 && Math.abs(cx - width / 2) < width * 0.08
}

export function transcriptEntries(lines: TranscriptLine[], page: number, ctx: TranscriptContext, pageWidth = 612): CatalogEntry[] {
  const out: CatalogEntry[] = []
  const push = (e: Partial<CatalogEntry> & Pick<CatalogEntry, 'section' | 'line' | 'label' | 'raw' | 'kind' | 'value'>) => {
    const ret = ctx.part === 'return'
    const entry: CatalogEntry = {
      id: `transcript:p${page}:${out.length + 1}`,
      form: ret ? 'irs_return_transcript' : 'irs_transcript',
      title: `IRS ${ret ? 'return' : 'account'} transcript${ctx.form ? ' (Form ' + ctx.form + ')' : ''}`,
      rev: ctx.period ? ctx.period.slice(-4) : '', instance: ret ? (ctx.instance ?? '') : '', page,
      desc: `IRS ${ret ? 'return' : 'account'} transcript${ctx.period ? ' for the period ending ' + ctx.period : ''}`,
      method: 'row', ...e,
    }
    out.push(entry)
    return entry
  }
  const header = (key: string, val: string, t: string, bbox: TranscriptLine['bbox']) => {
    if (/^Form( Number)?$/i.test(key) && val) ctx.form = val
    if (/Report for Tax Period Ending|^Tax Period$/i.test(key) && DATE.test(val)) ctx.period = DATE.exec(val)![0]
    if (/^Response Date$/i.test(key) && DATE.test(val)) ctx.asOf = DATE.exec(val)![0]
    if (val) push({ section: 'Header', line: key, label: key, raw: t, kind: 'text', value: val, ...(DATE.test(val) ? { date: DATE.exec(val)![0] } : {}), bbox })
  }
  for (const { raw, bbox } of lines) {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t) continue
    // The banner and page numbers are the IRS's template, like a blank form's
    // printed labels: not data, so not stored.
    if (BOILERPLATE.test(t)) continue
    if (!ctx.type && t.length < 90) {
      const hit = TITLES.find(([re]) => re.test(t))
      if (hit) {
        ctx.type = hit[1]
        ctx.part = hit[1] === 'return' ? 'return' : 'account'
        push({ section: 'Header', line: 'Transcript', label: 'Transcript', raw: t, kind: 'text', value: t, bbox })
        continue
      }
    }
    if (NO_RECORD.test(t)) {
      ctx.noRecord = true
      push({ section: 'Header', line: 'No record', label: 'No record', raw: t, kind: 'text', value: t, bbox })
      continue
    }
    // A record of account turns into a return transcript where the second
    // header block or the return's own preamble begins.
    if (ctx.type === 'record_of_account' && ctx.part !== 'return' &&
        ((ctx.section === 'Transactions' && HEADER_KEYS.test(t)) || /^Duplicate Amendment Number|^The following reflects the federal tax information/i.test(t))) {
      ctx.part = 'return'
      ctx.section = 'Header'
    }
    if (ctx.part === 'return') {
      returnLine(t, bbox)
      continue
    }
    if (/Information from the return or as adjusted/i.test(t)) { ctx.section = 'Return information'; continue }
    if (/^TRANSACTIONS$/i.test(t) || /^CODE EXPLANATION OF TRANSACTION/i.test(t)) { ctx.section = 'Transactions'; continue }
    const h = HEADER_KEYS.exec(t)
    if (h) {
      header(h[1].replace(/\s+/g, ' '), h[2].trim(), t, bbox)
      continue
    }
    const a = ACCOUNT_KEYS.exec(t)
    if (a && MONEY.test(a[2])) {
      ctx.section = ctx.section === 'Header' ? 'Account' : ctx.section
      const asOf = /As of:?\s*(\d{2}-\d{2}-\d{4})/i.exec(a[2])
      push({ section: 'Account', line: a[1].replace(/\s+/g, ' '), label: a[1], raw: t, kind: 'amount', value: money(a[2]), ...(asOf ? { date: asOf[1] } : {}), bbox })
      continue
    }
    if (ctx.section === 'Transactions') {
      // "150 Tax return filed 20240805 04-01-2024 $0.00" (cycle optional)
      const m = /^(\d{3})\s+(.+?)\s+(?:(\d{8})\s+)?(\d{2}-\d{2}-\d{4})\s+(-?\$[\d,]+\.\d{2})$/.exec(t)
      if (m) {
        ctx.lastTxn = push({
          section: 'Transactions', line: m[1], label: m[2], raw: t, kind: 'amount', value: money(m[5]),
          date: m[4], ...(m[3] ? { cycle: m[3] } : {}), bbox,
        })
        continue
      }
      // Continuation line under a transaction: its DLN, or a second date
      // (e.g. the collection statute end date printed under a penalty).
      if (ctx.lastTxn && (DLN.test(t) || /^\d{2}-\d{2}-\d{4}$/.test(t) || /^n\/a$/i.test(t))) {
        ctx.lastTxn.raw += ` | ${t}`
        if (DLN.test(t)) ctx.lastTxn.dln = t
        continue
      }
    }
    if (ctx.section === 'Return information' || ctx.section === 'Account') {
      // "Taxable Income -$35,615.00" | "Processed date: 04-01-2024" | "Principal Business Activity Code 445452"
      const kv = /^(.+?)\s*:?\s+(-?\$[\d,]+\.\d{2}|\d{2}-\d{2}-\d{4}|\d{3,6})$/.exec(t)
      if (kv) {
        const v = kv[2]
        const isMoney = MONEY.test(v)
        push({
          section: ctx.section, line: kv[1].replace(/:$/, ''), label: kv[1].replace(/:$/, ''), raw: t,
          kind: isMoney ? 'amount' : 'text', value: isMoney ? money(v) : v, ...(DATE.test(v) ? { date: v } : {}), bbox,
        })
        continue
      }
    }
    // Anything else on a transcript page is kept as a row, so nothing is lost.
    push({ section: ctx.section, line: '', label: t, raw: t, kind: 'row', value: money(t) ?? t, bbox })
  }
  return out

  /** One line of the return part: a header key, the return's identification
   *  block, a centred heading, or "Label: value" under the current heading. */
  function returnLine(t: string, bbox: TranscriptLine['bbox']) {
    const h = HEADER_KEYS.exec(t) ?? /^(Form):\s*(\S.*)$/.exec(t)
    if (h && ctx.section === 'Header') { header(h[1].replace(/\s+/g, ' '), h[2].trim(), t, bbox); return }
    const dup = /^Duplicate Amendment Number\s*:?\s*(\d+)$/i.exec(t)
    if (dup) {
      ctx.section = 'Return'
      push({ section: 'Return', line: 'Duplicate Amendment Number', label: 'Duplicate Amendment Number', raw: t, kind: 'text', value: dup[1], bbox })
      return
    }
    if (/^(Original|Amended|Duplicate|Corrected) Return$/i.test(t)) {
      ctx.section = 'Return'
      push({ section: 'Return', line: 'Return', label: 'Return', raw: t, kind: 'text', value: t, bbox })
      return
    }
    if (!/:/.test(t) && !MONEY.test(t) && centred(bbox, pageWidth)) {
      ctx.headings ??= new Map()
      const n = (ctx.headings.get(t) ?? 0) + 1
      ctx.headings.set(t, n)
      ctx.section = t
      ctx.instance = n > 1 ? `#${n}` : ''
      ctx.subheading = undefined
      ctx.pendingRow = undefined
      return
    }
    // "Gross Receipts: $1,929,750.00" | "Received Date: 01-20-2026" |
    // "F8586: Low Income Housing Credit: $0.00" (label up to the LAST colon) |
    // "Ordinary Income/Loss $128,143.00" (no colon) | "Designee Check Box:" (blank = no data on file)
    const kv = /^(.+):\s*(.*)$/.exec(t) ?? /^(.+?)\s+(-?\$[\d,]+\.\d{2})$/.exec(t)
    if (!kv || ctx.section === 'Header') {
      const row = push({ section: ctx.section, line: '', label: t, raw: t, kind: 'row', value: t, bbox })
      ctx.pendingRow = ctx.section === 'Header' || ctx.section === 'Return' ? undefined : row
      return
    }
    let label = kv[1].replace(/\s+/g, ' ').trim()
    let raw = t
    const prev = ctx.pendingRow
    ctx.pendingRow = undefined
    if (prev) {
      // The second half of a wrapped label is indented or starts lower-case;
      // otherwise the text line above was a sub-heading.
      if (/^[a-z]/.test(label) || bbox[0] > (prev.bbox?.[0] ?? 0) + 4) {
        label = `${prev.label} ${label}`
        raw = `${prev.raw} ${t}`
        const i = out.indexOf(prev)
        if (i >= 0) out.splice(i, 1)
      } else {
        ctx.subheading = prev.label
      }
    }
    const v = kv[2].trim()
    ctx.lines ??= new Map()
    const key = `${ctx.section}|${ctx.instance ?? ''}|${label.toLowerCase()}`
    const n = (ctx.lines.get(key) ?? 0) + 1
    ctx.lines.set(key, n)
    const isMoney = MONEY.test(v) && money(v) !== null && v.replace(MONEY, '').trim() === ''
    const isDate = /^\d{2}-\d{2}-\d{4}$/.test(v)
    push({
      section: ctx.section, line: label, label, raw,
      ...(ctx.subheading ? { desc: `IRS return transcript${ctx.period ? ' for the period ending ' + ctx.period : ''} — ${ctx.subheading}` } : {}),
      kind: isMoney ? 'amount' : 'text',
      // 00-00-0000 and a blank are the IRS's "no data on file"
      value: isMoney ? money(v) : v === '' || v === '00-00-0000' ? null : v,
      ...(isDate && v !== '00-00-0000' ? { date: v } : {}),
      ...(DLN.test(v) ? { dln: v } : {}),
      ...(n > 1 ? { row: String(n) } : {}),
      bbox,
    })
  }
}

/** The tax year a period-ending date belongs to: a fiscal year is named by
 *  the year it starts in (a year ending 06-30-2025 is tax year 2024). */
export function taxYearOfPeriod(period: string | undefined): number | undefined {
  const m = /^(\d{2})-\d{2}-(\d{4})$/.exec(period ?? '')
  if (!m) return undefined
  return Number(m[1]) === 12 ? Number(m[2]) : Number(m[2]) - 1
}

/** MM-DD-YYYY → YYYY-MM-DD */
export function isoOfTranscriptDate(d: string | undefined): string | undefined {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d ?? '')
  return m && m[3] !== '0000' ? `${m[3]}-${m[1]}-${m[2]}` : undefined
}
