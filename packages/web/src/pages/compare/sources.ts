/**
 * Pure helpers for the all-sources view (SourcesView.tsx), tested without a
 * browser.
 *
 * The view compares chosen sources against one BASE source (2026-10-21: the
 * owner asked to pick a base return and choose what to set beside it — the
 * filed return against the IRS's record and the books, a proforma against the
 * filed return, a scenario against the proforma). A source is the filed
 * return, the IRS's record, the books, the source documents, each stored
 * return (filed import, proforma, amendment) or each scenario.
 */
import type { GoldenRow, GoldenValue, GoldenView } from '@/hooks/use-golden'
import { fmtMoney } from '@/lib/format'

const SCHED: Record<string, string> = {
  f1040s1: 'Schedule 1', f1040s2: 'Schedule 2', f1040s3: 'Schedule 3', f1040sa: 'Schedule A', f1040sb: 'Schedule B',
  f1040sc: 'Schedule C', f1040sd: 'Schedule D', f1040se: 'Schedule E', f1040sse: 'Schedule SE', f1040s8: 'Schedule 8812',
  f1120ssk: 'Schedule K-1 (1120-S)', f1120ssd: '1120-S Schedule D', f1065sk1: 'Schedule K-1 (1065)',
  f1120sg: '1120 Schedule G', f1120so: '1120 Schedule O', f1120sh: '1120 Schedule H',
}

/** "f1120s" → "1120-S", "f1125a" → "1125-A", "f1040se" → "Schedule E". */
export function formTitle(form: string): string {
  if (SCHED[form]) return SCHED[form]
  const m = /^f(\d{3,4})([a-z]*)$/.exec(form)
  if (!m) return form
  const [, num, suffix] = m
  if (num === '1120' && suffix === 's') return '1120-S'
  return suffix ? `${num}-${suffix.toUpperCase()}` : num
}

/** Where a row sits: "1120-S Schedule L line 24 (d)". */
export function lineRef(r: Pick<GoldenRow, 'form' | 'section' | 'line' | 'col'>): string {
  return `${formTitle(r.form)}${r.section ? ` ${r.section}` : ''}${r.line ? ` line ${r.line}` : ''}${r.col ? ` (${r.col})` : ''}`
}

/** The IRS's description up to its first sentence. */
export function shortLabel(label: string): string {
  const first = label.split(/(?<=[a-z)])\. /)[0]
  return first.length > 90 ? `${first.slice(0, 89)}…` : first
}

/** "proforma 2026-10-15 (815a9144)" → "Proforma 10/15/2026". */
export function sourceLabel(label: string): string {
  const m = /^(\w[\w_]*)\s+(\d{4})-(\d{2})-(\d{2})/.exec(label)
  const name = (m ? m[1] : label.replace(/\s*\([0-9a-f]{8}\)$/, '')).replace(/_/g, ' ')
  const cap = name.charAt(0).toUpperCase() + name.slice(1)
  return m ? `${cap} ${m[3]}/${m[4]}/${m[2]}` : cap
}

export const near = (a: GoldenValue | undefined, b: GoldenValue | undefined) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1 : String(a ?? '') === String(b ?? '')

// ─── Sources ───

export type SourceKind = 'filed' | 'irs' | 'books' | 'documents' | 'return' | 'scenario'
export interface Source {
  /** stable id for the URL: filed, irs, books, documents, ret:<id8>, sc:<id8> */
  id: string
  kind: SourceKind
  /** the column heading */
  name: string
  /** the key of a stored return / scenario in row.returns / row.scenarios */
  label?: string
}

/** The sources this year actually has, in a fixed order. */
export function availableSources(data: Pick<GoldenView, 'sources'>): Source[] {
  const s = data.sources
  const out: Source[] = []
  if (s.filed_return) out.push({ id: 'filed', kind: 'filed', name: 'Filed return' })
  if (s.irs_return_transcript) out.push({ id: 'irs', kind: 'irs', name: 'IRS' })
  if (s.books && s.books.available !== false && (s.books.lines ?? 0) > 0) out.push({ id: 'books', kind: 'books', name: 'Books' })
  if (s.documents && s.documents.lines > 0) out.push({ id: 'documents', kind: 'documents', name: 'Documents' })
  for (const r of s.returns) out.push({ id: `ret:${r.id.slice(0, 8)}`, kind: 'return', name: sourceLabel(r.label), label: r.label })
  for (const c of s.scenarios) out.push({ id: `sc:${c.id.slice(0, 8)}`, kind: 'scenario', name: `Scenario: ${c.label}`, label: c.label })
  return out
}

export interface SourceCell {
  value?: GoldenValue
  /** a marker after the value: Σ (a books total of mapped lines), ¹ (the IRS's own calculation) */
  mark?: string
  /** a second line under the value */
  note?: string
  title?: string
}

/** One source's figure on one row. The IRS column shows the figure as filed;
 *  where the transcript carries only the IRS's own calculation, that, marked ¹. */
export function cellOf(r: GoldenRow, s: Source): SourceCell {
  switch (s.kind) {
    case 'filed': return r.filed ? { value: r.filed.value } : {}
    case 'irs': {
      if (r.irs) {
        const calc = r.irs_computed && !near(r.irs_computed.value, r.irs.value) ? r.irs_computed.value : undefined
        return { value: r.irs.value, ...(calc !== undefined && typeof calc === 'number' ? { note: `IRS calc ${fmtMoney(calc)}` } : {}) }
      }
      return r.irs_computed ? { value: r.irs_computed.value, mark: '¹', title: "The IRS's own calculation; the transcript does not carry the figure as filed" } : {}
    }
    case 'books': return r.books ? { value: r.books.value, ...(r.books.summed ? { mark: 'Σ', title: 'Sum of the lines mapped from the books' } : {}) } : {}
    case 'documents': return r.documents ? { value: r.documents.value, ...(r.documents.sources?.length ? { title: r.documents.sources.join('; ') } : {}) } : {}
    case 'return': return r.returns?.[s.label!] ? { value: r.returns[s.label!].value } : {}
    case 'scenario': return r.scenarios?.[s.label!] ? { value: r.scenarios[s.label!].value } : {}
  }
}

const has = (v: GoldenValue | undefined): v is Exclude<GoldenValue, null> => v !== undefined && v !== null && v !== ''

export type Versus = 'matches' | 'differs' | 'not_in_base' | 'only_base' | 'none'

/** A row against the base. A blank is not a difference: the IRS transcript,
 *  the documents and the stored filed imports each carry only some lines. */
export function versusBase(r: GoldenRow, base: Source, others: Source[]): { state: Versus; differ: Source[] } {
  const b = cellOf(r, base).value
  const vals = others.map(s => [s, cellOf(r, s).value] as const).filter(([, v]) => has(v))
  if (!has(b)) return { state: vals.some(([, v]) => v !== 0) ? 'not_in_base' : 'none', differ: [] }
  if (!vals.length) return { state: 'only_base', differ: [] }
  const differ = vals.filter(([, v]) => !near(v, b)).map(([s]) => s)
  return { state: differ.length ? 'differs' : 'matches', differ }
}

/** The base and compared sources: from the URL when they name sources this
 *  year has, else the filed return against the IRS's record and the books
 *  (the documents for a return with no books). */
export function chooseSources(sources: Source[], want: { base?: string | null; with?: string | null }): { base: Source | undefined; others: Source[] } {
  const byId = new Map(sources.map(s => [s.id, s]))
  const base = byId.get(want.base ?? '') ?? byId.get('filed') ?? byId.get('irs') ?? sources[0]
  const asked = want.with != null ? want.with.split(',').filter(Boolean) : null
  const ids = asked ?? ['irs', byId.has('books') ? 'books' : 'documents']
  return { base, others: ids.map(id => byId.get(id)).filter((s): s is Source => !!s && s.id !== base?.id) }
}

// ─── Order: as the form is printed ───

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }
const MAIN: Record<string, string> = { '1120S': 'f1120s', '1120': 'f1120', '1040': 'f1040' }

function sectionKey(s: string): string {
  const m = /^Part ([IVX]+)\b(.*)$/.exec(s)
  return m ? `Part ${String(ROMAN[m[1]] ?? 99).padStart(2, '0')}${m[2]}` : s
}
function lineCmp(a: string, b: string): number {
  const pa = /^(\d+)(.*)$/.exec(a), pb = /^(\d+)(.*)$/.exec(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a.localeCompare(b)  // header items (A–J) before line 1
  return Number(pa[1]) - Number(pb[1]) || pa[2].localeCompare(pb[2])
}

/** Rows in the order the return prints them: the main form, then its
 *  schedules (a 1040's Schedules 1–3, A–E), then the other forms; within a
 *  form by section, line and column. */
export function inFormOrder(rows: GoldenRow[], formType: string): GoldenRow[] {
  const rank = (f: string) => f === MAIN[formType] ? 0 : /^f1040s/.test(f) ? 1 : 2
  return [...rows].sort((a, b) =>
    rank(a.form) - rank(b.form) || formTitle(a.form).localeCompare(formTitle(b.form), undefined, { numeric: true })
    || sectionKey(a.section).localeCompare(sectionKey(b.section)) || lineCmp(a.line, b.line) || (a.col ?? '').localeCompare(b.col ?? '')
    || (a.instance ?? '').localeCompare(b.instance ?? ''))
}
