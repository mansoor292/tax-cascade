/**
 * Answer questions from the catalog — pure filtering over decrypted entries,
 * so it is testable without a database and identical for REST and MCP.
 *
 * Every hit carries its provenance (tax year, form, page, section, line,
 * column, the IRS's own label) so an answer can always say WHERE on the return
 * it came from — "per the filed 2023 Form 1120-S, Schedule L line 19, column
 * (d)" — without anyone opening the PDF.
 */
import type { CatalogEntry } from './types.js'

export interface CatalogQuery {
  years?: number[]
  /** IRS slugs ('f1120s', 'f1120ssk') or names ('1120-S', 'K-1', '8960') */
  forms?: string[]
  /** Case-insensitive substring: 'Schedule L', 'Part II', a statement title */
  section?: string
  /** Exact printed line: '19', '17a', 'A', 'J(2)' */
  line?: string
  col?: string
  row?: string
  /** Exact canonical field_values key, or a prefix ending in '.' */
  canonical?: string
  /** Case-insensitive search across label, IRS description and printed text */
  text?: string
  kinds?: Array<CatalogEntry['kind']>
  /** Second printed copies (instance copyN) are skipped unless asked for */
  include_copies?: boolean
  /** Text printed outside every box (software notes) — included by default */
  include_unassigned?: boolean
  limit?: number
}

export interface CatalogSource {
  catalog_id: string
  tax_year: number | null
  source_filename?: string | null
  entries: CatalogEntry[]
  kind?: string
  status?: string
  transcript_type?: string | null
  as_of?: string | null
}

export interface QueryHit extends CatalogEntry {
  catalog_id: string
  tax_year: number | null
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function formMatches(entry: Pick<CatalogEntry, 'form' | 'title'>, wanted: string): boolean {
  const w = norm(wanted)
  if (!w) return true
  if (norm(entry.form) === w || norm(entry.form) === 'f' + w) return true
  if (entry.form === 'statement') return w === 'statement' || w === 'statements'
  const title = norm(entry.title)
  // "1120-S" must not also match "1120-S Schedule K-1" unless asked: prefer an
  // exact title match ("form1120s"), else containment.
  return title === 'form' + w || title === w || title.includes(w)
}

export function filterEntries(sources: CatalogSource[], q: CatalogQuery): QueryHit[] {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000)
  const text = q.text?.toLowerCase().trim()
  const section = q.section?.toLowerCase().trim()
  const out: QueryHit[] = []
  for (const src of sources) {
    if (q.years?.length && (src.tax_year === null || !q.years.includes(src.tax_year))) continue
    for (const e of src.entries) {
      if (!q.include_copies && /^copy\d+$/.test(e.instance)) continue
      if (q.include_unassigned === false && e.section === '(unassigned)') continue
      if (q.kinds?.length && !q.kinds.includes(e.kind)) continue
      if (q.forms?.length) {
        // An exact form match wins over a containment match across the list.
        const exact = q.forms.some(f => norm(e.form) === norm(f) || norm(e.title) === 'form' + norm(f))
        if (!exact && !q.forms.some(f => formMatches(e, f))) continue
        const anyExactElsewhere = q.forms.some(f => /^f?\d/.test(norm(f)) && !/schedule|k1/.test(norm(f)))
        if (!exact && anyExactElsewhere && /schedule/i.test(e.title) && !q.forms.some(f => /schedule|k1|sch/i.test(f))) continue
      }
      if (section && !e.section.toLowerCase().includes(section)) continue
      if (q.line && e.line.toLowerCase() !== q.line.toLowerCase()) continue
      if (q.col && (e.col ?? '').toLowerCase() !== q.col.toLowerCase()) continue
      if (q.row && (e.row ?? '').toLowerCase() !== q.row.toLowerCase()) continue
      if (q.canonical) {
        if (!e.canonical) continue
        if (q.canonical.endsWith('.') ? !e.canonical.startsWith(q.canonical) : e.canonical !== q.canonical) continue
      }
      if (text) {
        const hay = `${e.label}\n${e.desc}\n${e.raw}`.toLowerCase()
        if (!text.split(/\s+/).every(t => hay.includes(t))) continue
      }
      out.push({ ...e, catalog_id: src.catalog_id, tax_year: src.tax_year })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** One-line provenance for a hit, the way an answer should cite it. */
export function cite(h: QueryHit): string {
  const where = [
    h.section && h.section !== '(unassigned)' ? h.section : '',
    h.line ? `line ${h.line}` : '',
    h.row ? `row ${h.row}` : '',
    h.col ? `column (${h.col})` : '',
  ].filter(Boolean).join(', ')
  const copy = /^copy\d+$/.test(h.instance) ? ` [${h.instance}]` : ''
  return `${h.tax_year ?? ''} ${h.title}${copy}${where ? ', ' + where : ''} (page ${h.page})`.trim()
}
