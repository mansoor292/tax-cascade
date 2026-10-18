/**
 * Return notes: the open threads about a return that are neither a registry
 * fact nor a review finding (migration 20261018120000_return_note.sql).
 *
 * Why (2026-10-18): the catalog held every document correctly, but the open
 * threads around the returns lived only in conversation and died with the
 * session. Examples: a payroll refund check nobody had confirmed arriving,
 * refund interest the IRS may owe, a misposting the representative still had
 * to call about. A note is one such thread. It says who it is waiting on, and
 * review_summary lists every open one beside the findings, so the "one list
 * of everything to act on" really is one list.
 *
 * Where things go:
 *  - A question every return of a type should answer goes in the fact
 *    registry (@taxengine/shared facts.ts), not here.
 *  - A decision about a finding goes in review_resolution.
 *  - Everything else that is still open, or that a new session must know, is
 *    a note. A note may point at the fact or finding it concerns.
 *
 * Versioned like tax_fact: an edit inserts a new version under the same
 * note_key and supersedes the old one; nothing is overwritten.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getFactDef } from '@taxengine/shared'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_NOTE_FIELDS, NOTE_ENC_COLS } from '../lib/row_crypto.js'

export const NOTE_STATUSES = ['open', 'closed', 'info'] as const
export const WAITING_ON = ['owner', 'irs', 'preparer', 'agent', 'third_party'] as const
export type NoteStatus = typeof NOTE_STATUSES[number]
export type WaitingOn = typeof WAITING_ON[number]

export interface NoteFields {
  tax_year: number | null
  status: NoteStatus
  waiting_on: WaitingOn | null
  title: string
  body: string | null
  fact_key: string | null
  finding_fingerprint: string | null
  due_date: string | null
}

export interface StoredNote extends NoteFields {
  id: string
  note_key: string
  entity_id: string
  recorded_by: string | null
  recorded_at: string
  superseded_by: string | null
}

const EDITABLE: Array<keyof NoteFields> = ['tax_year', 'status', 'waiting_on', 'title', 'body', 'fact_key', 'finding_fingerprint', 'due_date']

type Checked = { ok: true; fields: Partial<NoteFields> } | { ok: false; error: string; field: string }

/** Validate the fields present in `input`; unknown fields are refused so a
 *  typo cannot silently drop what the caller meant to record. */
export function checkNoteFields(input: Record<string, unknown>): Checked {
  const fields: Partial<NoteFields> = {}
  for (const k of Object.keys(input)) {
    if (!EDITABLE.includes(k as keyof NoteFields)) return { ok: false, error: `Unknown note field: ${k}`, field: k }
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined
  if (has('tax_year')) {
    const y = input.tax_year
    if (y !== null && !(Number.isInteger(y) && (y as number) >= 1900 && (y as number) <= 2100)) return { ok: false, error: 'tax_year must be a four-digit year or null (the whole entity)', field: 'tax_year' }
    fields.tax_year = y as number | null
  }
  if (has('status')) {
    if (!NOTE_STATUSES.includes(input.status as NoteStatus)) return { ok: false, error: `status must be one of ${NOTE_STATUSES.join(', ')}`, field: 'status' }
    fields.status = input.status as NoteStatus
  }
  if (has('waiting_on')) {
    if (input.waiting_on !== null && !WAITING_ON.includes(input.waiting_on as WaitingOn)) return { ok: false, error: `waiting_on must be one of ${WAITING_ON.join(', ')} or null`, field: 'waiting_on' }
    fields.waiting_on = input.waiting_on as WaitingOn | null
  }
  if (has('title')) {
    const t = typeof input.title === 'string' ? input.title.trim() : ''
    if (!t || t.length > 300) return { ok: false, error: 'title is required (at most 300 characters)', field: 'title' }
    fields.title = t
  }
  if (has('body')) {
    if (input.body !== null && (typeof input.body !== 'string' || input.body.length > 10000)) return { ok: false, error: 'body must be text (at most 10,000 characters) or null', field: 'body' }
    fields.body = (input.body as string | null) || null
  }
  if (has('fact_key')) {
    if (input.fact_key !== null && (typeof input.fact_key !== 'string' || !getFactDef(input.fact_key))) return { ok: false, error: `fact_key is not in the fact registry: ${String(input.fact_key)}`, field: 'fact_key' }
    fields.fact_key = input.fact_key as string | null
  }
  if (has('finding_fingerprint')) {
    if (input.finding_fingerprint !== null && (typeof input.finding_fingerprint !== 'string' || !input.finding_fingerprint.includes('|'))) return { ok: false, error: 'finding_fingerprint must be a fingerprint from get_review / review_summary', field: 'finding_fingerprint' }
    fields.finding_fingerprint = input.finding_fingerprint as string | null
  }
  if (has('due_date')) {
    const d = input.due_date
    if (d !== null && !(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) return { ok: false, error: 'due_date must be YYYY-MM-DD or null', field: 'due_date' }
    fields.due_date = d as string | null
  }
  return { ok: true, fields }
}

/** A complete note must have a title, and an open one must say who it waits on. */
export function checkComplete(n: Partial<NoteFields>): { ok: true; note: NoteFields } | { ok: false; error: string; field: string } {
  const note: NoteFields = {
    tax_year: n.tax_year ?? null, status: n.status ?? 'open', waiting_on: n.waiting_on ?? null,
    title: n.title ?? '', body: n.body ?? null, fact_key: n.fact_key ?? null,
    finding_fingerprint: n.finding_fingerprint ?? null, due_date: n.due_date ?? null,
  }
  if (!note.title) return { ok: false, error: 'title is required', field: 'title' }
  if (note.status === 'open' && !note.waiting_on) return { ok: false, error: `an open note must say who it is waiting on (${WAITING_ON.join(', ')})`, field: 'waiting_on' }
  return { ok: true, note }
}

function publicRow(r: any): StoredNote {
  return {
    id: r.id, note_key: r.note_key, entity_id: r.entity_id, tax_year: r.tax_year ?? null,
    status: r.status, waiting_on: r.waiting_on ?? null, title: r.title ?? '', body: r.body ?? null,
    fact_key: r.fact_key ?? null, finding_fingerprint: r.finding_fingerprint ?? null, due_date: r.due_date ?? null,
    recorded_by: r.recorded_by ?? null, recorded_at: r.recorded_at, superseded_by: r.superseded_by ?? null,
  }
}

const SELECT = `id, note_key, user_id, entity_id, tax_year, status, waiting_on, title, body, fact_key, finding_fingerprint, due_date, recorded_by, recorded_at, superseded_by, ${NOTE_ENC_COLS}`

async function insertVersion(
  supabase: SupabaseClient, userId: string, entityId: string, note: NoteFields, recordedBy: string | null, noteKey?: string,
): Promise<any> {
  const payload: Record<string, any> = { user_id: userId, entity_id: entityId, ...note, recorded_by: recordedBy, ...(noteKey ? { note_key: noteKey } : {}) }
  const { data, error } = await supabase.from('return_note')
    .insert({ ...payload, ...(await encryptedFields(supabase, userId, payload, ENCRYPTED_NOTE_FIELDS)) })
    .select(SELECT).single()
  if (error || !data) throw new Error(error?.message ?? 'note insert failed')
  await hydrate(supabase, data, ENCRYPTED_NOTE_FIELDS)
  return data
}

export async function addNote(
  supabase: SupabaseClient, userId: string, entityId: string, note: NoteFields, recordedBy: string | null,
): Promise<StoredNote> {
  return publicRow(await insertVersion(supabase, userId, entityId, note, recordedBy))
}

/** Apply `patch` to the current version of a note: a new version is written
 *  and the old one points at it. Null when there is no current version. */
export async function updateNote(
  supabase: SupabaseClient, userId: string, entityId: string, noteKey: string, patch: Partial<NoteFields>, recordedBy: string | null,
): Promise<{ note: StoredNote } | { error: string; field: string } | null> {
  const { data: rows, error } = await supabase.from('return_note').select(SELECT)
    .eq('user_id', userId).eq('entity_id', entityId).eq('note_key', noteKey).is('superseded_by', null)
  if (error) throw new Error(error.message)
  const current = (rows ?? [])[0]
  if (!current) return null
  await hydrate(supabase, current, ENCRYPTED_NOTE_FIELDS)
  const merged = checkComplete({ ...publicRow(current), ...patch })
  if (!merged.ok) return { error: merged.error, field: merged.field }
  const inserted = await insertVersion(supabase, userId, entityId, merged.note, recordedBy, noteKey)
  const { error: updErr } = await supabase.from('return_note').update({ superseded_by: inserted.id })
    .eq('user_id', userId).eq('id', current.id).is('superseded_by', null)
  if (updErr) throw new Error(updErr.message)
  return { note: publicRow(inserted) }
}

const STATUS_ORDER: Record<NoteStatus, number> = { open: 0, info: 1, closed: 2 }

/** Notes for one or more entities. `years` keeps those years plus the
 *  entity-wide notes (tax_year null), which is everything a return for those
 *  years should read. Current versions only unless includeHistory. */
export async function listNotes(
  supabase: SupabaseClient, userId: string, entityIds: string[],
  opts: { years?: number[]; statuses?: NoteStatus[]; includeHistory?: boolean } = {},
): Promise<StoredNote[]> {
  if (!entityIds.length) return []
  let q = supabase.from('return_note').select(SELECT).eq('user_id', userId).in('entity_id', entityIds)
  if (opts.statuses?.length) q = q.in('status', opts.statuses)
  if (!opts.includeHistory) q = q.is('superseded_by', null)
  const { data, error } = await q.order('recorded_at', { ascending: false })
  if (error) throw new Error(error.message)
  const rows = (data ?? []).filter((r: any) => !opts.years?.length || r.tax_year === null || opts.years.includes(r.tax_year))
  await hydrateAll(supabase, rows, ENCRYPTED_NOTE_FIELDS)
  return rows.map(publicRow).sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999'))
    || (a.tax_year ?? 0) - (b.tax_year ?? 0)
    || b.recorded_at.localeCompare(a.recorded_at))
}
