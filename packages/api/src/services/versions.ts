/**
 * Version sets and the amended returns in them: storage and validation
 * (migration 20261018170000_version_sets.sql; the views in review/versions.ts).
 *
 * Why (2026-10-18): the owner's rule is that every set of returns must tie
 * internally. That covers what is filed and each restatement package
 * (v1, v2, ...); a break is an open item. A version is the list of lines its
 * amended return changes. Each change is checked against the return it
 * amends when it is saved: a line that is not on that return is refused
 * unless it says it adds the line, so a mistyped line number cannot quietly
 * become a new line. The value it replaces is recorded beside it.
 *
 * A draft set's versions are working papers, edited in place. A filed or
 * abandoned set is frozen.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_SET_FIELDS, ENCRYPTED_VERSION_FIELDS, ENCRYPTED_CATALOG_FIELDS, SET_ENC_COLS, VERSION_ENC_COLS } from '../lib/row_crypto.js'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView } from '../review/types.js'
import { filed } from '../review/lookup.js'
import { applyChanges, matchEntry, versionsForView, VERSION_FACT_KEYS, type VersionChange, type VersionFactKey, type VersionRow } from '../review/versions.js'

export const SET_STATUSES = ['draft', 'filed', 'abandoned'] as const
export type SetStatus = typeof SET_STATUSES[number]
const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/

export interface StoredSet {
  id: string
  label: string
  title: string | null
  description: string | null
  status: SetStatus
  filed_on: string | null
  created_at: string
  updated_at: string
  versions: StoredVersion[]
}

export interface StoredVersion {
  id: string
  set_id: string
  entity_id: string
  tax_year: number
  form: string | null
  changes: VersionChange[]
  note: string | null
  updated_at: string
}

type Bad = { ok: false; error: string; field: string }
const bad = (field: string, error: string): Bad => ({ ok: false, error, field })

export function checkSetFields(input: Record<string, unknown>, creating: boolean): { ok: true; fields: Record<string, unknown> } | Bad {
  const allowed = creating ? ['label', 'title', 'description'] : ['title', 'description', 'status', 'filed_on']
  for (const k of Object.keys(input)) if (!allowed.includes(k)) return bad(k, `Unknown or unchangeable set field: ${k}`)
  const f: Record<string, unknown> = {}
  if (creating) {
    if (typeof input.label !== 'string' || !LABEL.test(input.label) || input.label === 'filed') return bad('label', 'label is a short lowercase name such as v1 or v2 ("filed" is the filed returns themselves)')
    f.label = input.label
  }
  for (const k of ['title', 'description'] as const) {
    if (input[k] === undefined) continue
    if (input[k] !== null && (typeof input[k] !== 'string' || (input[k] as string).length > (k === 'title' ? 200 : 5000))) return bad(k, `${k} must be text or null`)
    f[k] = (input[k] as string | null)?.trim() || null
  }
  if (input.status !== undefined) {
    if (!['filed', 'abandoned'].includes(input.status as string)) return bad('status', 'a draft set can be marked filed or abandoned')
    f.status = input.status
  }
  if (input.filed_on !== undefined) {
    const d = input.filed_on
    if (d !== null && !(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) return bad('filed_on', 'filed_on must be YYYY-MM-DD')
    f.filed_on = d
  }
  return { ok: true, fields: f }
}

/** Validate a change list against the return it amends (`base`), filling
 *  each line change's `from` with the value it replaces. */
export function checkChanges(input: unknown, base: CatalogView | undefined, year: number): { ok: true; changes: VersionChange[] } | Bad {
  if (!Array.isArray(input) || !input.length) return bad('changes', 'changes is a list of the lines this version changes (at least one)')
  const out: VersionChange[] = []
  const known = ['form', 'section', 'line', 'col', 'row', 'instance', 'to', 'delta', 'reason', 'fact_key', 'subject', 'add']
  for (const [i, raw] of input.entries()) {
    const at = `changes[${i}]`
    if (!raw || typeof raw !== 'object') return bad(at, `${at} must be an object`)
    const c = raw as Record<string, unknown>
    for (const k of Object.keys(c)) if (!known.includes(k)) return bad(`${at}.${k}`, `Unknown change field: ${k}`)
    if (typeof c.reason !== 'string' || !c.reason.trim() || c.reason.length > 500) return bad(`${at}.reason`, 'every change says why (reason, at most 500 characters)')
    const str = (k: string) => (c[k] === undefined || c[k] === null ? undefined : String(c[k]))
    const change: VersionChange = { reason: c.reason.trim() }
    for (const k of ['form', 'section', 'line', 'col', 'row', 'instance'] as const) if (str(k) !== undefined) change[k] = str(k)
    if (c.fact_key !== undefined) {
      if (!VERSION_FACT_KEYS.includes(c.fact_key as VersionFactKey)) return bad(`${at}.fact_key`, `fact_key must be one of ${VERSION_FACT_KEYS.join(', ')}`)
      if (typeof c.subject !== 'string' || !c.subject.trim()) return bad(`${at}.subject`, 'a change that moves an intercompany amount names the related company (subject)')
      change.fact_key = c.fact_key as VersionFactKey
      change.subject = c.subject.trim()
    }
    if (change.form || change.line) {
      if (!change.form || !change.line) return bad(`${at}.line`, 'a line change gives both form (catalog slug, e.g. f1120) and line')
      if (!/^f[0-9a-z]+$/.test(change.form)) return bad(`${at}.form`, 'form is the catalog slug, e.g. f1120, f1120s, f1120ssk, f1040, f1040se, f1125a')
      if (c.to === undefined || (c.to !== null && !['number', 'string', 'boolean'].includes(typeof c.to))) return bad(`${at}.to`, 'a line change gives the new value (to)')
      change.to = c.to as VersionChange['to']
      if (c.add === true) change.add = true
      const hit = matchEntry(base, change)
      if (!hit && !change.add) {
        return bad(`${at}.line`, `${change.form} line ${change.line}${change.section ? ` (${change.section})` : ''}${change.col ? ` column ${change.col}` : ''} is not on the filed ${year} return. Check the form slug, section and column (query_catalog shows them), or pass add: true for a line the amendment adds`)
      }
      change.from = hit ? (hit.value as VersionChange['from']) : null
    } else {
      if (!change.fact_key) return bad(at, 'a change is either a line (form, line, to) or an intercompany amount (fact_key, subject, delta)')
      if (typeof c.delta !== 'number' || !Number.isFinite(c.delta)) return bad(`${at}.delta`, 'an intercompany-amount change gives the amount it moves (delta)')
      change.delta = c.delta
    }
    out.push(change)
  }
  return { ok: true, changes: out }
}

const SET_SELECT = `id, user_id, label, title, description, status, filed_on, created_at, updated_at, ${SET_ENC_COLS}`
const VERSION_SELECT = `id, user_id, set_id, entity_id, tax_year, form, changes, note, updated_at, ${VERSION_ENC_COLS}`

export async function listSets(supabase: SupabaseClient, userId: string): Promise<StoredSet[]> {
  const [{ data: sets, error }, { data: vers, error: e2 }] = await Promise.all([
    supabase.from('version_set').select(SET_SELECT).eq('user_id', userId).order('created_at', { ascending: true }),
    supabase.from('return_version').select(VERSION_SELECT).eq('user_id', userId),
  ])
  if (error || e2) throw new Error((error ?? e2)!.message)
  await Promise.all([hydrateAll(supabase, sets ?? [], ENCRYPTED_SET_FIELDS), hydrateAll(supabase, vers ?? [], ENCRYPTED_VERSION_FIELDS)])
  return (sets ?? []).map((s: any) => ({
    id: s.id, label: s.label, title: s.title ?? null, description: s.description ?? null, status: s.status, filed_on: s.filed_on ?? null,
    created_at: s.created_at, updated_at: s.updated_at,
    versions: (vers ?? []).filter((v: any) => v.set_id === s.id).map((v: any) => ({
      id: v.id, set_id: v.set_id, entity_id: v.entity_id, tax_year: v.tax_year, form: v.form ?? null,
      changes: (v.changes as VersionChange[] | null) ?? [], note: v.note ?? null, updated_at: v.updated_at,
    })).sort((a: StoredVersion, b: StoredVersion) => a.tax_year - b.tax_year),
  }))
}

/** Every version of every non-abandoned set, flattened for the views. */
export function versionRows(sets: StoredSet[]): VersionRow[] {
  return sets.filter(s => s.status !== 'abandoned').flatMap(s => s.versions.map(v => ({
    set_label: s.label, set_status: s.status, filed_on: s.filed_on, set_created_at: s.created_at,
    entity_id: v.entity_id, tax_year: v.tax_year, form: v.form, changes: v.changes, updated_at: v.updated_at,
  })))
}

export async function createSet(supabase: SupabaseClient, userId: string, f: Record<string, unknown>, recordedBy: string | null): Promise<StoredSet | Bad> {
  const row = { user_id: userId, label: f.label, title: f.title ?? null, description: f.description ?? null, recorded_by: recordedBy }
  const { data, error } = await supabase.from('version_set')
    .insert({ ...row, ...(await encryptedFields(supabase, userId, row, ENCRYPTED_SET_FIELDS)) }).select(SET_SELECT).single()
  if (error?.code === '23505') return bad('label', `a set labelled ${String(f.label)} already exists`)
  if (error || !data) throw new Error(error?.message ?? 'set insert failed')
  await hydrate(supabase, data, ENCRYPTED_SET_FIELDS)
  return { id: data.id, label: data.label, title: data.title ?? null, description: data.description ?? null, status: data.status, filed_on: null, created_at: data.created_at, updated_at: data.updated_at, versions: [] }
}

async function findSet(supabase: SupabaseClient, userId: string, label: string) {
  const { data, error } = await supabase.from('version_set').select('id, status, label').eq('user_id', userId).eq('label', label).maybeSingle()
  if (error) throw new Error(error.message)
  return data as { id: string; status: SetStatus; label: string } | null
}

export async function updateSet(supabase: SupabaseClient, userId: string, label: string, f: Record<string, unknown>): Promise<{ ok: true } | Bad | null> {
  const set = await findSet(supabase, userId, label)
  if (!set) return null
  if (set.status !== 'draft' && (f.status !== undefined || f.filed_on !== undefined)) return bad('status', `set ${label} is ${set.status} and frozen`)
  const patch: Record<string, unknown> = { ...f, updated_at: new Date().toISOString() }
  if (f.status === 'filed' && !f.filed_on) patch.filed_on = new Date().toISOString().slice(0, 10)
  const enc = await encryptedFields(supabase, userId, patch, ENCRYPTED_SET_FIELDS)
  const { error } = await supabase.from('version_set').update({ ...patch, ...enc }).eq('user_id', userId).eq('id', set.id)
  if (error) throw new Error(error.message)
  return { ok: true }
}

/** The return a version in `label` amends: the filed catalog with every
 *  filed set's changes applied (what the IRS has now). */
async function baseReturn(supabase: SupabaseClient, userId: string, entityId: string, year: number, sets: StoredSet[], label: string): Promise<CatalogView | undefined> {
  const { data, error } = await supabase.from('return_catalog')
    .select('id, user_id, tax_year, kind, status, entries, entries_enc').eq('user_id', userId).eq('entity_id', entityId)
    .eq('tax_year', year).eq('kind', 'filed_return').is('superseded_by', null)
  if (error) throw new Error(error.message)
  const rows = await hydrateAll(supabase, data ?? [], { json: ENCRYPTED_CATALOG_FIELDS.json })
  const cat = filed(rows.map((r: any) => ({ id: r.id, kind: r.kind, tax_year: r.tax_year, status: r.status, entries: (r.entries as CatalogEntry[] | null) ?? [] })), year)
  if (!cat) return undefined
  return versionsForView(versionRows(sets), 'filed')
    .filter(v => v.entity_id === entityId && v.tax_year === year && v.set_label !== label)
    .reduce((c, v) => applyChanges(c, v.changes, v.set_label), cat)
}

export async function putVersion(
  supabase: SupabaseClient, userId: string, label: string,
  input: { entity_id?: unknown; tax_year?: unknown; form?: unknown; note?: unknown; changes?: unknown }, recordedBy: string | null,
): Promise<{ version: StoredVersion; amends: 'filed return' | 'no filed return on file' } | Bad | null> {
  const sets = await listSets(supabase, userId)
  const set = sets.find(s => s.label === label)
  if (!set) return null
  if (set.status !== 'draft') return bad('label', `set ${label} is ${set.status} and frozen`)
  if (typeof input.entity_id !== 'string') return bad('entity_id', 'entity_id is required')
  const { data: ent } = await supabase.from('tax_entity').select('id').eq('user_id', userId).eq('id', input.entity_id).maybeSingle()
  if (!ent) return bad('entity_id', 'entity_id must be an entity in this account')
  const year = Number(input.tax_year)
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return bad('tax_year', 'tax_year must be a four-digit year')
  if (input.form !== undefined && input.form !== null && (typeof input.form !== 'string' || input.form.length > 40)) return bad('form', 'form names the amended return, e.g. 1120-X, 1040-X, 1120-S (amended)')
  if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > 5000)) return bad('note', 'note must be text')
  const base = await baseReturn(supabase, userId, input.entity_id, year, sets, label)
  const checked = checkChanges(input.changes, base, year)
  if (!checked.ok) return checked
  const row = {
    user_id: userId, set_id: set.id, entity_id: input.entity_id, tax_year: year, form: (input.form as string | null | undefined) ?? null,
    changes: checked.changes, note: (input.note as string | null | undefined) ?? null, recorded_by: recordedBy, updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase.from('return_version')
    .upsert({ ...row, ...(await encryptedFields(supabase, userId, row, ENCRYPTED_VERSION_FIELDS)) }, { onConflict: 'set_id,entity_id,tax_year' })
    .select(VERSION_SELECT).single()
  if (error || !data) throw new Error(error?.message ?? 'version upsert failed')
  await hydrate(supabase, data, ENCRYPTED_VERSION_FIELDS)
  await supabase.from('version_set').update({ updated_at: new Date().toISOString() }).eq('id', set.id)
  return {
    version: { id: data.id, set_id: data.set_id, entity_id: data.entity_id, tax_year: data.tax_year, form: data.form ?? null, changes: (data.changes as VersionChange[]) ?? [], note: data.note ?? null, updated_at: data.updated_at },
    amends: base ? 'filed return' : 'no filed return on file',
  }
}

export async function removeVersion(supabase: SupabaseClient, userId: string, label: string, entityId: string, year: number): Promise<{ ok: true } | Bad | null> {
  const set = await findSet(supabase, userId, label)
  if (!set) return null
  if (set.status !== 'draft') return bad('label', `set ${label} is ${set.status} and frozen`)
  const { error } = await supabase.from('return_version').delete().eq('user_id', userId).eq('set_id', set.id).eq('entity_id', entityId).eq('tax_year', year)
  if (error) throw new Error(error.message)
  return { ok: true }
}

