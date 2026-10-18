/**
 * Version sets, read as returns: the view of every return that a set
 * describes, so the same tie checks run on "filed" and on each restatement
 * package (migration 20261018170000_version_sets.sql; storage in
 * services/versions.ts).
 *
 * Why (2026-10-18): the owner's rule is that every set of returns must tie
 * internally. That means what is filed with the IRS, and each package of
 * amendments being prepared (v1, v2, ...). A break is an open item. A version
 * is stored as the lines it changes, not as a second copy of the return. Its
 * full return is the filed catalog with those changes applied. That keeps
 * every check (arithmetic, year-to-year, K-1 to 1040, intercompany) working on
 * a version without a line of version-specific code, and an incomplete change
 * list shows up as the arithmetic break it is.
 *
 * Views:
 *   filed  the original filed returns plus every FILED set's changes, in the
 *          order the sets were filed
 *   <set>  the filed view plus that set's own changes
 * An abandoned set is in no view.
 */
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView } from './types.js'
import { filed } from './lookup.js'
import type { EntityBundle, FactLike } from './map.js'

/** Facts a change can move: the intercompany amounts the cross-entity ties compare. */
export const VERSION_FACT_KEYS = ['intercompany.fee_expense', 'intercompany.fee_revenue', 'intercompany.balance_end'] as const
export type VersionFactKey = typeof VERSION_FACT_KEYS[number]

export interface VersionChange {
  /** Catalog form slug, e.g. f1120, f1120s, f1120ssk, f1040, f1125a */
  form?: string
  section?: string
  line?: string
  col?: string
  row?: string
  instance?: string
  /** The line's value in this version */
  to?: number | string | boolean | null
  /** The line's value in the view this version amends (filled when saved) */
  from?: number | string | boolean | null
  /** A change to an intercompany amount that is not a line of its own */
  delta?: number
  reason: string
  /** The intercompany amount this change moves, and the related company it is with */
  fact_key?: VersionFactKey
  subject?: string
  /** The line is not on the filed return (a schedule or line the amendment adds) */
  add?: boolean
}

export interface VersionRow {
  set_label: string
  set_status: 'draft' | 'filed' | 'abandoned'
  filed_on: string | null
  set_created_at: string
  entity_id: string
  tax_year: number
  form: string | null
  changes: VersionChange[]
  updated_at: string
}

export const isLineChange = (c: VersionChange) => !!(c.form && c.line)

/** The entry a change addresses: same form, line, section, column, row and
 *  instance as the catalog stores them. */
export function matchEntry(cat: CatalogView | undefined, c: VersionChange): CatalogEntry | undefined {
  if (!cat || !isLineChange(c)) return undefined
  return cat.entries.find(e => sameLine(e, c) && e.instance === (c.instance ?? ''))
}

function sameLine(e: CatalogEntry, c: VersionChange): boolean {
  return e.form === c.form &&
    e.line.toLowerCase() === String(c.line).toLowerCase() &&
    (c.section === undefined ? true : e.section === c.section) &&
    (c.col === undefined ? !e.col : e.col === c.col) &&
    (c.row === undefined ? true : e.row === c.row)
}

const printed = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : v === true ? 'X' : v === false || v === null || v === undefined ? '' : String(v))

/** A catalog with a version's line changes applied. Every printed copy of a
 *  changed line changes too, so the copies still agree. */
export function applyChanges(cat: CatalogView, changes: VersionChange[], label: string): CatalogView {
  const entries = [...cat.entries]
  for (const c of changes.filter(isLineChange)) {
    let hit = false
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const target = e.instance === (c.instance ?? '') || (/^copy\d+$/.test(e.instance) && (c.instance ?? '') === '')
      if (!target || !sameLine(e, c)) continue
      entries[i] = { ...e, value: c.to ?? null, raw: printed(c.to), method: 'amendment', title: `${e.title} (${label})` }
      hit = true
    }
    if (!hit && c.add) {
      entries.push({
        id: `${label}:${c.form}:${c.instance ?? ''}:${c.section ?? ''}:${c.line}:${c.row ?? ''}:${c.col ?? ''}`,
        form: c.form!, title: `${c.form} (${label})`, rev: cat.entries.find(x => x.form === c.form)?.rev ?? '', instance: c.instance ?? '', page: 0,
        section: c.section ?? '', line: String(c.line), ...(c.row ? { row: c.row } : {}), ...(c.col ? { col: c.col } : {}),
        label: c.reason, desc: c.reason, kind: typeof c.to === 'number' ? 'amount' : typeof c.to === 'boolean' ? 'check' : 'text',
        value: c.to ?? null, raw: printed(c.to), method: 'amendment',
      })
    }
  }
  return { ...cat, entries }
}

/** The versions a view is made of, in the order they apply. */
export function versionsForView(versions: VersionRow[], view: string): VersionRow[] {
  const order = (v: VersionRow) => `${v.filed_on ?? '9999'}|${v.set_created_at}`
  const filedSets = versions.filter(v => v.set_status === 'filed').sort((a, b) => order(a).localeCompare(order(b)))
  if (view === 'filed') return filedSets
  return [...filedSets, ...versions.filter(v => v.set_label === view && v.set_status === 'draft')]
}

/** Every entity's catalogs as the view has them: the filed return of each
 *  amended year replaced by the return with the view's changes applied. */
export function viewBundles(bundles: EntityBundle[], versions: VersionRow[]): EntityBundle[] {
  if (!versions.length) return bundles
  return bundles.map(b => {
    const mine = versions.filter(v => v.entity_id === b.entity.id)
    if (!mine.length) return b
    let catalogs = [...b.catalogs]
    for (const v of mine) {
      const base = filed(catalogs, v.tax_year) ?? {
        id: `version:${v.set_label}:${b.entity.id}:${v.tax_year}`, kind: 'filed_return' as const, tax_year: v.tax_year, status: 'partial', entries: [],
      }
      const amended = applyChanges(base, v.changes, v.set_label)
      catalogs = [...catalogs.filter(c => c !== base), amended]
    }
    return { ...b, catalogs }
  })
}

const subjectKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Every entity's facts as the view has them: the intercompany amounts each
 *  change moves, added to the recorded answer for that year and company. */
export function viewFacts<T extends FactLike>(facts: Map<string, T[]>, versions: VersionRow[]): Map<string, T[]> {
  if (!versions.length) return facts
  const out = new Map([...facts.entries()].map(([k, v]) => [k, [...v]]))
  for (const v of versions) {
    for (const c of v.changes) {
      if (!c.fact_key || !c.subject) continue
      const delta = typeof c.delta === 'number' ? c.delta
        : typeof c.to === 'number' && typeof c.from === 'number' ? c.to - c.from : undefined
      if (delta === undefined) continue
      const rows = out.get(v.entity_id) ?? []
      const i = rows.findIndex(r => !r.superseded_by && r.fact_key === c.fact_key && r.tax_year === v.tax_year && subjectKey(r.subject) === subjectKey(c.subject))
      if (i < 0 || typeof rows[i].value !== 'number') continue
      rows[i] = { ...rows[i], value: (rows[i].value as number) + delta }
      out.set(v.entity_id, rows)
    }
  }
  return out
}
