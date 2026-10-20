/**
 * Catalog lookups shared by the checks. Everything a check reads goes through
 * here, so "which return, which line, which copy" is decided once.
 */
import type { CatalogEntry } from '../catalog/types.js'
import { parseAmount } from '../catalog/amount.js'
import { transcriptParts } from '../catalog/transcript.js'
import type { CatalogView, Evidence, ReviewContext } from './types.js'

export interface Sel {
  section?: string
  line: string
  col?: string
  row?: string
  /** match the label too (case-insensitive substring) */
  label?: string
}

/** The filed return catalog for a year (complete preferred). */
export function filed(catalogs: CatalogView[], year: number): CatalogView | undefined {
  const c = catalogs.filter(c => c.kind === 'filed_return' && c.tax_year === year)
  return c.find(x => x.status === 'complete') ?? c[0]
}

/** The golden transcript carrying `part` for a year: the newest by the IRS's
 *  response date, the dedicated transcript before a record of account of the
 *  same date. Storage keeps one golden copy of each kind current
 *  (catalog/store.ts reconcileTranscripts); choosing here too keeps a check
 *  deterministic if two ever coexist — it used to take whichever row came
 *  first, so a return transcript could stand in for the account transcript. */
function goldenOf(catalogs: CatalogView[], year: number, part: 'account' | 'return'): CatalogView | undefined {
  return catalogs
    .filter(c => c.kind === 'irs_transcript' && c.tax_year === year && transcriptParts(c.transcript_type).includes(part))
    .sort((a, b) => (b.as_of ?? '').localeCompare(a.as_of ?? '') ||
      Number((a.transcript_type ?? 'account') !== part) - Number((b.transcript_type ?? 'account') !== part))[0]
}

/** The year's account transcript (an account transcript or record of account). */
export function transcript(catalogs: CatalogView[], year: number): CatalogView | undefined {
  return goldenOf(catalogs, year, 'account')
}

/** The year's return transcript (a return transcript or record of account):
 *  the IRS's line-by-line copy of the return it processed, entries of form
 *  'irs_return_transcript', section = the IRS's heading. */
export function returnTranscript(catalogs: CatalogView[], year: number): CatalogView | undefined {
  return goldenOf(catalogs, year, 'return')
}

/** A line of a return transcript, by heading and label. */
export function returnLine(cat: CatalogView | undefined, section: RegExp, line: RegExp): CatalogEntry | undefined {
  return cat?.entries.find(e => e.form === 'irs_return_transcript' && section.test(e.section) && line.test(e.line) && !e.instance && !e.row)
}

/** "No record of return filed": the IRS has no return for the period. */
export function noRecord(cat: CatalogView | undefined): boolean {
  return !!cat?.entries.some(e => e.section === 'Header' && e.line === 'No record')
}

/** Entries of one form in a catalog, first printed copy only. */
export function formEntries(cat: CatalogView | undefined, form: string): CatalogEntry[] {
  if (!cat) return []
  return cat.entries.filter(e => e.form === form && !/^copy\d+$/.test(e.instance))
}

export function find(cat: CatalogView | undefined, form: string, sel: Sel, instance = ''): CatalogEntry | undefined {
  return formEntries(cat, form).find(e =>
    (instance === '*' || e.instance === instance) &&
    e.line.toLowerCase() === sel.line.toLowerCase() &&
    (sel.section === undefined ? true : e.section === sel.section) &&
    (sel.col === undefined ? !e.col : e.col === sel.col) &&
    (sel.row === undefined ? true : e.row === sel.row) &&
    (sel.label === undefined ? true : e.label.toLowerCase().includes(sel.label.toLowerCase())),
  )
}

/** Amount on a line: the number, 0 when the form is present but the box is
 *  blank, undefined when the form isn't in the return at all. */
export function amount(cat: CatalogView | undefined, form: string, sel: Sel, instance = ''): number | undefined {
  const e = find(cat, form, sel, instance)
  if (e && typeof e.value === 'number') return e.value
  if (e && typeof e.raw === 'string') {
    const n = parseAmount(e.raw)
    if (n !== null) return n
  }
  return formEntries(cat, form).length ? 0 : undefined
}

export function checked(cat: CatalogView | undefined, form: string, sel: Sel): boolean {
  const e = find(cat, form, sel)
  return !!e && e.kind === 'check' && e.value === true
}

export function text(cat: CatalogView | undefined, form: string, sel: Sel): string | undefined {
  const e = find(cat, form, sel)
  return e ? String(e.raw ?? e.value ?? '') : undefined
}

/** K-1 coded boxes (16, 17, 12, 13…): the code widgets and the amount widgets
 *  are separate boxes paired by "Line N of M" in their IRS description. */
export function k1Codes(cat: CatalogView | undefined, box: string, form = 'f1120ssk', instance = ''): Array<{ code: string; amount: number | null; raw: string; entry: CatalogEntry }> {
  const es = formEntries(cat, form).filter(e => e.instance === instance && e.line === box)
  const byIdx = new Map<string, { code?: CatalogEntry; amt?: CatalogEntry }>()
  for (const e of es) {
    const m = /Line (\d+) of \d+\.\s*(Code|Amount)/i.exec(e.label) ?? /Line (\d+) of \d+\.\s*(Code|Amount)/i.exec(e.desc)
    if (!m) continue
    const slot = byIdx.get(m[1]) ?? {}
    if (/code/i.test(m[2])) slot.code = e
    else slot.amt = e
    byIdx.set(m[1], slot)
  }
  const out: Array<{ code: string; amount: number | null; raw: string; entry: CatalogEntry }> = []
  for (const [, s] of [...byIdx.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!s.code) continue
    const code = String(s.code.raw).replace(/[^A-Z]/g, '').slice(0, 2)
    const amt = s.amt && typeof s.amt.value === 'number' ? s.amt.value : null
    out.push({ code, amount: amt, raw: `${s.code.raw} ${s.amt?.raw ?? ''}`.trim(), entry: s.amt ?? s.code })
  }
  return out
}

export function k1CodeAmount(cat: CatalogView | undefined, box: string, code: string, form = 'f1120ssk'): number | undefined {
  const rows = k1Codes(cat, box, form)
  if (!formEntries(cat, form).length) return undefined
  return rows.filter(r => r.code === code).reduce((s, r) => s + (r.amount ?? 0), 0)
}

/** Citation for an entry in a catalog. */
export function cite(cat: CatalogView, e: CatalogEntry): string {
  const where = [
    e.section && e.section !== '(unassigned)' ? e.section : '',
    e.line ? `line ${e.line}` : '',
    e.row ? `row ${e.row}` : '',
    e.col ? `column (${e.col})` : '',
  ].filter(Boolean).join(', ')
  return `${cat.tax_year ?? ''} ${e.title}${where ? ', ' + where : ''} (page ${e.page})`.trim()
}

export function ev(cat: CatalogView | undefined, form: string, sel: Sel, instance = ''): Evidence | null {
  if (!cat) return null
  const e = find(cat, form, sel, instance)
  if (!e) return { where: `${cat.tax_year} ${form} line ${sel.line}${sel.col ? ' (' + sel.col + ')' : ''}: blank`, catalog_id: cat.id, value: 0 }
  return { where: cite(cat, e), entry_id: e.id, catalog_id: cat.id, value: e.value }
}

export const evs = (...xs: Array<Evidence | null | undefined>): Evidence[] => xs.filter((x): x is Evidence => !!x)

/** Transcript transactions (code, amount, date) for a year. */
export function transactions(cat: CatalogView | undefined): Array<{ code: string; label: string; amount: number; date?: string; entry: CatalogEntry }> {
  if (!cat) return []
  return cat.entries
    .filter(e => e.form === 'irs_transcript' && e.section === 'Transactions' && /^\d{3}$/.test(e.line))
    .map(e => ({ code: e.line, label: e.label, amount: typeof e.value === 'number' ? e.value : 0, date: e.date, entry: e }))
}

export function transcriptValue(cat: CatalogView | undefined, section: string, key: RegExp): { value: unknown; date?: string; entry: CatalogEntry } | undefined {
  if (!cat) return undefined
  const e = cat.entries.find(x => x.form === 'irs_transcript' && x.section === section && key.test(x.line))
  return e ? { value: e.value, date: e.date, entry: e } : undefined
}

/** MM-DD-YYYY (transcripts) or YYYY-MM-DD → Date */
export function parseDate(s: string | undefined | null): Date | undefined {
  if (!s) return undefined
  let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s) ?? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])))
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return undefined
}

export const iso = (d: Date) => d.toISOString().slice(0, 10)

export function yearsBack(ctx: ReviewContext, n: number): number[] {
  return Array.from({ length: n }, (_, i) => ctx.year - i)
}

export const money = (n: number | undefined | null) =>
  n === undefined || n === null ? '—' : (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString('en-US')
