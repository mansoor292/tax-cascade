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
 */
import type { CatalogEntry } from './types.js'

export function isTranscriptText(text: string): boolean {
  return /This Product Contains Sensitive Taxpayer Data|Transcript Delivery System|Report for Tax Period Ending|ACCOUNT TRANSCRIPT|RECORD OF ACCOUNT|TAX RETURN TRANSCRIPT/i.test(text)
}

const MONEY = /-?\$[\d,]+\.\d{2}/
const DATE = /\d{2}-\d{2}-\d{4}/

function money(s: string): number | null {
  const m = MONEY.exec(s)
  if (!m) return null
  const n = Number(m[0].replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface TranscriptLine { raw: string; bbox: [number, number, number, number] }

export interface TranscriptContext {
  section: 'Header' | 'Account' | 'Return information' | 'Transactions'
  form?: string
  period?: string
  lastTxn?: CatalogEntry
}

const HEADER_KEYS = /^(Form Number|Report for Tax Period Ending|Taxpayer Identification Number|Request Date|Response Date|Tracking Number|Tax Period)\s*:?\s*(.*)$/i
const ACCOUNT_KEYS = /^(Account balance plus accruals.*?|Account balance|Accrued interest|Accrued penalty)\s*:?\s*(.*)$/i

export function transcriptEntries(lines: TranscriptLine[], page: number, ctx: TranscriptContext): CatalogEntry[] {
  const out: CatalogEntry[] = []
  const rev = ctx.period ? ctx.period.slice(-4) : ''
  const push = (e: Partial<CatalogEntry> & Pick<CatalogEntry, 'section' | 'line' | 'label' | 'raw' | 'kind' | 'value'>) => {
    const entry: CatalogEntry = {
      id: `transcript:p${page}:${out.length + 1}`,
      form: 'irs_transcript', title: `IRS account transcript${ctx.form ? ' (Form ' + ctx.form + ')' : ''}`,
      rev, instance: '', page, desc: `IRS transcript${ctx.period ? ' for the period ending ' + ctx.period : ''}`,
      method: 'row', ...e,
    }
    out.push(entry)
    return entry
  }
  for (const { raw, bbox } of lines) {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (/Information from the return or as adjusted/i.test(t)) { ctx.section = 'Return information'; continue }
    if (/^TRANSACTIONS$/i.test(t) || /^CODE EXPLANATION OF TRANSACTION/i.test(t)) { ctx.section = 'Transactions'; continue }
    const h = HEADER_KEYS.exec(t)
    if (h) {
      const key = h[1].replace(/\s+/g, ' ')
      const val = h[2].trim()
      if (/^Form Number$/i.test(key) && val) ctx.form = val
      if (/Report for Tax Period Ending|^Tax Period$/i.test(key) && DATE.test(val)) ctx.period = DATE.exec(val)![0]
      if (val) push({ section: 'Header', line: key, label: key, raw: t, kind: 'text', value: val, bbox })
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
      if (ctx.lastTxn && (/^\d{5}-\d{3}-\d{5}-\d$/.test(t) || /^\d{2}-\d{2}-\d{4}$/.test(t) || /^n\/a$/i.test(t))) {
        ctx.lastTxn.raw += ` | ${t}`
        if (/^\d{5}-/.test(t)) (ctx.lastTxn as CatalogEntry & { dln?: string }).dln = t
        continue
      }
    }
    if (ctx.section === 'Return information' || ctx.section === 'Account') {
      // "Taxable Income -$41,424.00" | "Processed date: 04-01-2024" | "Principal Business Activity Code 551112"
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
}
