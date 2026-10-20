/**
 * The golden view of one return year: every golden key with its value from
 * each source, side by side — the filed return (catalog), the IRS's record
 * of it (return transcript: the figure as filed, and the IRS's own
 * recomputation), and the returns stored here (filed import, proforma,
 * amendment). One row per box, whatever year's form or source it came from.
 *
 * The golden value of a filed year: the IRS's figure where its transcript
 * carries the box and holds THIS year's return (it is what the IRS assessed
 * on); otherwise the filed return. When the transcript holds another year's
 * return (EZA 2024 holds its 2023 return) the IRS column is labelled so and
 * never becomes golden.
 */
import type { CatalogEntry } from '../catalog/types.js'
import { parseAmount } from '../catalog/amount.js'
import { formSchema, goldenKey, keyInfo } from './index.js'
import { resolveBox, transcriptKey } from './transcript_map.js'
import type { BooksLine } from './books.js'
import type { DocLine } from './documents.js'
import { resolveKey } from './validate.js'

export type GoldenValue = number | string | boolean | null
export interface Cell { value: GoldenValue; where: string }
export type RowStatus = 'agrees' | 'differs' | 'irs_only' | 'filed_only' | 'irs_recomputed' | 'returns_only'

export interface GoldenRow {
  form: string
  key: string
  instance?: string
  label: string
  section: string
  line: string
  col?: string
  filed?: Cell
  irs?: Cell
  irs_computed?: Cell
  /** stored returns by label ("proforma", "amendment 2026-10-14" …) */
  returns?: Record<string, Cell>
  /** the books (QuickBooks, classified to this line, before any tax computation) */
  books?: Cell & { summed?: boolean; accounts?: Array<{ account: string; amount: number; rule: string }> }
  /** the source documents (W-2s, 1099s, K-1s) placed on the line, before any computation */
  documents?: Cell & { sources?: string[] }
  /** scenarios by name */
  scenarios?: Record<string, Cell>
  /** documents differ from the golden value by more than a dollar */
  documents_differs?: boolean
  /** books differ from the golden value by more than a dollar */
  books_differs?: boolean
  golden?: GoldenValue
  golden_from?: 'irs' | 'filed' | 'return'
  status: RowStatus
  headline?: boolean
}

export interface GoldenInput {
  formType: string
  year: number
  filed?: { id: string; entries: CatalogEntry[] }
  transcript?: { id: string; entries: CatalogEntry[]; as_of?: string | null; holdsYear?: number }
  returns?: Array<{ id: string; label: string; field_values: Record<string, unknown> | null | undefined }>
  books?: { label: string; lines: BooksLine[] }
  documents?: { label: string; lines: DocLine[] }
  scenarios?: Array<{ id: string; label: string; field_values: Record<string, unknown> | null | undefined }>
  includeText?: boolean
}

/** Forms whose keys can appear in a return's field_values, main form first. */
const FAMILY: Record<string, string[]> = {
  '1120S': ['f1120s', 'f1125a', 'f1125e', 'f1120ssd', 'f1120ssk', 'f4562', 'f8825', 'f4797', 'f7004'],
  '1120': ['f1120', 'f1125a', 'f1125e', 'f4562', 'f1120sg', 'f1120so', 'f2220', 'f4797', 'f7004', 'f1120x'],
  '1040': ['f1040', 'f1040s1', 'f1040s2', 'f1040s3', 'f1040sa', 'f1040sb', 'f1040sc', 'f1040sd', 'f1040se', 'f1040sse', 'f1040s8', 'f7203', 'f8582', 'f8959', 'f8960', 'f8995', 'f8995a', 'f4562', 'f2210', 'f8949', 'f4868'],
}

/** Headline boxes: the ones a misposting and a material difference are read from. */
const HEADLINE: Record<string, string[]> = {
  '1120S': ['f1120s||1a|', 'f1120s||6|', 'f1120s||21|', 'f1120s||22|'],
  '1120': ['f1120||1a|', 'f1120||11|', 'f1120||27|', 'f1120||31|'],
  '1040': ['f1040||9|', 'f1040||11a|', 'f1040||15|', 'f1040||24|', 'f1040||33|'],
}
export function headlineKeys(formType: string): Set<string> {
  return new Set((HEADLINE[formType] ?? []).map(resolveBox).filter((r): r is { form: string; key: string } => !('error' in r)).map(r => `${r.form}|${r.key}`))
}

/** Which form a field_values key belongs to, for a return type. */
export function formOfKey(formType: string, key: string): string | undefined {
  for (const f of FAMILY[formType] ?? []) {
    const s = formSchema(f)
    if (s && (s.byKey.has(key) || s.aliasOf.has(key))) return f
  }
  return undefined
}

function amountOf(e: Pick<CatalogEntry, 'value' | 'raw' | 'kind'>): GoldenValue {
  if (typeof e.value === 'number' || typeof e.value === 'boolean') return e.value
  if (e.kind === 'amount' || e.kind === 'text') {
    const n = parseAmount(String(e.raw ?? e.value ?? ''))
    if (n !== null && /\d/.test(String(e.raw ?? ''))) return n
  }
  return e.value ?? null
}
const isNum = (v: GoldenValue | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const same = (a: GoldenValue, b: GoldenValue) => isNum(a) && isNum(b) ? Math.abs(a - b) <= 1 : String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

export function goldenRows(input: GoldenInput): GoldenRow[] {
  const rows = new Map<string, GoldenRow>()
  const id = (form: string, key: string, instance = '') => `${form}|${key}|${instance}`
  const row = (form: string, key: string, instance = '', at?: Pick<CatalogEntry, 'section' | 'line' | 'col' | 'label'>): GoldenRow => {
    const k = id(form, key, instance)
    let r = rows.get(k)
    if (!r) {
      const info = keyInfo(form, key)
      r = { form, key, ...(instance ? { instance } : {}), label: info?.label ?? at?.label ?? key, section: info?.section ?? at?.section ?? '', line: info?.line ?? at?.line ?? '', ...((info?.col ?? at?.col) ? { col: info?.col ?? at?.col } : {}), status: 'filed_only' }
      rows.set(k, r)
    }
    return r
  }
  const wantText = !!input.includeText
  // the filed return
  for (const e of input.filed?.entries ?? []) {
    if (!e.canonical || /^copy/.test(e.instance)) continue
    const v = amountOf(e)
    if (!isNum(v) && !wantText) continue
    if (v === null || v === '') continue
    const r = row(e.form, goldenKey(e.form, e.canonical), e.instance, e)
    if (!r.filed) r.filed = { value: v, where: `${input.year} filed return, ${e.title || e.form} ${e.section ? e.section + ' ' : ''}line ${e.line}${e.col ? ' (' + e.col + ')' : ''}, page ${e.page}` }
  }
  // the IRS's record
  for (const e of input.transcript?.entries ?? []) {
    if (e.form !== 'irs_return_transcript' || e.instance || e.row || typeof e.value !== 'number') continue
    const m = transcriptKey(input.formType, e.section, e.line)
    if (!m) continue
    const r = row(m.form, m.key)
    const cell = { value: (m.sign ?? 1) * e.value, where: `${input.year} IRS return transcript${input.transcript?.as_of ? ' dated ' + input.transcript.as_of : ''}: ${e.section} — ${e.line}` }
    if (m.variant === 'as_filed' && !r.irs) r.irs = cell
    if (m.variant === 'irs_computed' && !r.irs_computed) r.irs_computed = cell
  }
  // returns stored here (canonical keys; older rows' descriptive names resolve too)
  for (const ret of input.returns ?? []) {
    for (const [k, v] of Object.entries(ret.field_values ?? {})) {
      const at = resolveKey(input.formType, k)
      if (!at) continue
      const val: GoldenValue = typeof v === 'number' || typeof v === 'boolean' ? v : typeof v === 'string' ? (parseAmount(v) ?? v) : null
      if (val === null || (!isNum(val) && !wantText)) continue
      const r = row(at.form, at.key)
      r.returns = { ...(r.returns ?? {}), [ret.label]: { value: val, where: `${ret.label} (return ${ret.id.slice(0, 8)}), ${k}` } }
    }
  }
  // the books
  for (const b of input.books?.lines ?? []) {
    const r = row(b.form, b.key)
    r.books = { value: b.value, where: `${input.books!.label}${b.summed ? ' (sum of the lines mapped from the books)' : ''}`, ...(b.summed ? { summed: true } : {}), ...(b.accounts?.length ? { accounts: b.accounts } : {}) }
  }
  // the source documents
  for (const d of input.documents?.lines ?? []) {
    const r = row(d.form, d.key)
    r.documents = { value: d.value, where: `${input.documents!.label}: ${d.sources.join('; ')}`, sources: d.sources }
  }
  // scenarios (engine field_values, canonical keys)
  for (const sc of input.scenarios ?? []) {
    for (const [k, v] of Object.entries(sc.field_values ?? {})) {
      const at = resolveKey(input.formType, k)
      if (!at || typeof v !== 'number' || !Number.isFinite(v)) continue
      const r = row(at.form, at.key)
      r.scenarios = { ...(r.scenarios ?? {}), [sc.label]: { value: v, where: `scenario "${sc.label}" (${sc.id.slice(0, 8)}), ${k}` } }
    }
  }
  const head = headlineKeys(input.formType)
  const misposted = input.transcript?.holdsYear !== undefined
  for (const r of rows.values()) {
    if (head.has(`${r.form}|${r.key}`)) r.headline = true
    // a recomputation of 0 against a real figure is the IRS not computing it
    if (r.irs_computed && r.irs_computed.value === 0 && isNum(r.filed?.value) && r.filed!.value !== 0) delete r.irs_computed
    const irsVal = r.irs?.value
    if (r.filed && r.irs) r.status = same(r.filed.value, irsVal ?? null) ? 'agrees' : 'differs'
    else if (r.irs) r.status = irsVal === 0 ? 'agrees' : 'irs_only'
    else if (r.filed && r.irs_computed && !same(r.filed.value, r.irs_computed.value ?? null)) r.status = 'irs_recomputed'
    else if (r.filed) r.status = 'filed_only'
    else r.status = 'returns_only'  // stored returns, books or scenarios only
    if (r.irs && !misposted) { r.golden = r.irs.value; r.golden_from = 'irs' }
    else if (r.filed) { r.golden = r.filed.value; r.golden_from = 'filed' }
    else if (r.returns) { const first = Object.values(r.returns)[0]; r.golden = first.value; r.golden_from = 'return' }
    if (r.books && isNum(r.golden) && !same(r.books.value, r.golden)) r.books_differs = true
    if (r.documents && isNum(r.golden) && !same(r.documents.value, r.golden)) r.documents_differs = true
  }
  // an IRS line reported as 0 with no box on the filed return says nothing
  return [...rows.values()].filter(r => !(r.status === 'agrees' && !r.filed && !r.returns && !r.books && !r.documents && !r.scenarios))
}

/** Does the transcript hold another year's return? Its headline figures all
 *  match that year's filed return and not this year's. */
export function heldYear(formType: string, year: number, transcriptEntries: CatalogEntry[], filedByYear: Map<number, CatalogEntry[]>): number | undefined {
  const head = headlineKeys(formType)
  const irs = new Map<string, number>()
  for (const e of transcriptEntries) {
    if (e.form !== 'irs_return_transcript' || e.instance || e.row || typeof e.value !== 'number') continue
    const m = transcriptKey(formType, e.section, e.line)
    if (m && m.variant === 'as_filed' && head.has(`${m.form}|${m.key}`) && !irs.has(`${m.form}|${m.key}`)) irs.set(`${m.form}|${m.key}`, (m.sign ?? 1) * e.value)
  }
  const matches = (y: number) => {
    const f = filedByYear.get(y)
    if (!f) return undefined
    const vals = new Map<string, number>()
    for (const e of f) if (e.canonical && !e.instance) { const v = amountOf(e); if (isNum(v)) vals.set(`${e.form}|${goldenKey(e.form, e.canonical)}`, v) }
    const pairs = [...irs.entries()].filter(([k]) => vals.has(k))
    if (pairs.length < 2 || pairs.every(([, v]) => v === 0)) return undefined
    return pairs.every(([k, v]) => Math.abs(vals.get(k)! - v) <= 1)
  }
  if (matches(year) !== false) return undefined
  return [year - 1, year + 1, year - 2, year + 2].find(y => matches(y) === true)
}

export function summarize(rows: GoldenRow[]) {
  const by: Record<RowStatus, number> = { agrees: 0, differs: 0, irs_only: 0, filed_only: 0, irs_recomputed: 0, returns_only: 0 }
  for (const r of rows) by[r.status]++
  return {
    keys: rows.length, ...by, headline_differs: rows.filter(r => r.headline && r.status === 'differs').length,
    books_lines: rows.filter(r => r.books).length, books_differ_from_golden: rows.filter(r => r.books_differs).length,
    documents_lines: rows.filter(r => r.documents).length, documents_differ_from_golden: rows.filter(r => r.documents_differs).length,
  }
}
