/**
 * The entity map's write path and assembly (migration
 * 20261018150000_entity_link.sql; derivation in review/map.ts).
 *
 * Why (2026-10-18): the owner's model has a hard-coded layer under every
 * return: one map of the group showing who owns what, which entities deal
 * with each other, and which LLCs are disregarded into which corporation.
 * Every check and every session reads that map instead of re-deriving it. A
 * link is recorded deliberately and carries its source and evidence.
 * Suggestions read from the returns only propose links.
 *
 * Versioned like tax_fact and return_note: an edit inserts a new version
 * under the same link_key and supersedes the old one. A link recorded in
 * error gets a version with removed = true and stays, so the same evidence
 * is not suggested again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_LINK_FIELDS, LINK_ENC_COLS } from '../lib/row_crypto.js'
import type { EntityInfo, EntityLink, LinkKind, LinkNature, LinkSource } from '../review/types.js'
import { listFacts } from './facts.js'
import { byOwner, linksFor, suggestLinks, touches, unrecorded, type EntityBundle, type FactLike, type MapEntity } from '../review/map.js'

export const LINK_KINDS: readonly LinkKind[] = ['owns', 'disregarded', 'intercompany']
export const LINK_NATURES: readonly LinkNature[] = ['services', 'loan', 'rent', 'settlement', 'other']
export const LINK_SOURCES: readonly LinkSource[] = ['owner', 'filed_return', 'fact', 'entity_record']

export type LinkFields = Omit<EntityLink, 'link_key'>

export interface StoredLink extends EntityLink {
  id: string
  recorded_by: string | null
  recorded_at: string
  superseded_by: string | null
}

const EDITABLE: Array<keyof LinkFields> = ['kind', 'from_entity_id', 'to_entity_id', 'to_name', 'subject', 'pct', 'nature', 'from_year', 'to_year', 'source', 'evidence', 'detail', 'removed']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Bad = { ok: false; error: string; field: string }
const bad = (field: string, error: string): Bad => ({ ok: false, error, field })

/** Validate the fields present in `input`; unknown fields are refused so a
 *  typo cannot silently drop what the caller meant to record. */
export function checkLinkFields(input: Record<string, unknown>): { ok: true; fields: Partial<LinkFields> } | Bad {
  const fields: Partial<LinkFields> = {}
  for (const k of Object.keys(input)) if (!EDITABLE.includes(k as keyof LinkFields)) return bad(k, `Unknown link field: ${k}`)
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined
  const text = (k: 'to_name' | 'subject' | 'evidence' | 'detail', max: number): Bad | undefined => {
    if (!has(k)) return undefined
    const v = input[k]
    if (v !== null && (typeof v !== 'string' || v.length > max)) return bad(k, `${k} must be text (at most ${max.toLocaleString('en-US')} characters) or null`)
    fields[k] = (typeof v === 'string' ? v.trim() : '') || null
    return undefined
  }
  if (has('kind')) {
    if (!LINK_KINDS.includes(input.kind as LinkKind)) return bad('kind', `kind must be one of ${LINK_KINDS.join(', ')}`)
    fields.kind = input.kind as LinkKind
  }
  for (const k of ['from_entity_id', 'to_entity_id'] as const) {
    if (!has(k)) continue
    const v = input[k]
    if (k === 'to_entity_id' && v === null) { fields.to_entity_id = null; continue }
    if (typeof v !== 'string' || !UUID.test(v)) return bad(k, `${k} must be an entity id from list_entities`)
    fields[k] = v
  }
  for (const [k, max] of [['to_name', 200], ['subject', 200], ['evidence', 2000], ['detail', 10000]] as const) {
    const e = text(k, max)
    if (e) return e
  }
  if (has('pct')) {
    const v = input.pct
    if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100)) return bad('pct', 'pct must be a percentage above 0 and at most 100, or null')
    fields.pct = v === null ? null : Math.round((v as number) * 10000) / 10000
  }
  if (has('nature')) {
    if (input.nature !== null && !LINK_NATURES.includes(input.nature as LinkNature)) return bad('nature', `nature must be one of ${LINK_NATURES.join(', ')} or null`)
    fields.nature = input.nature as LinkNature | null
  }
  for (const k of ['from_year', 'to_year'] as const) {
    if (!has(k)) continue
    const y = input[k]
    if (y !== null && !(Number.isInteger(y) && (y as number) >= 1900 && (y as number) <= 2100)) return bad(k, `${k} must be a four-digit year or null (open-ended)`)
    fields[k] = y as number | null
  }
  if (has('source')) {
    if (!LINK_SOURCES.includes(input.source as LinkSource)) return bad('source', `source must be one of ${LINK_SOURCES.join(', ')}`)
    fields.source = input.source as LinkSource
  }
  if (has('removed')) {
    if (typeof input.removed !== 'boolean') return bad('removed', 'removed must be true or false')
    fields.removed = input.removed
  }
  return { ok: true, fields }
}

/** A complete link: both ends known, and the fields its kind needs. */
export function checkLinkComplete(
  l: Partial<LinkFields>, entities: Array<Pick<EntityInfo, 'id' | 'form_type'>>,
): { ok: true; link: LinkFields } | Bad {
  const link: LinkFields = {
    kind: l.kind as LinkKind, from_entity_id: l.from_entity_id ?? '', to_entity_id: l.to_entity_id ?? null, to_name: l.to_name ?? null,
    subject: l.subject ?? null, pct: l.pct ?? null, nature: l.nature ?? null, from_year: l.from_year ?? null, to_year: l.to_year ?? null,
    source: l.source ?? 'owner', evidence: l.evidence ?? null, detail: l.detail ?? null, removed: l.removed ?? false,
  }
  if (!link.kind) return bad('kind', `kind is required (${LINK_KINDS.join(', ')})`)
  const from = entities.find(e => e.id === link.from_entity_id)
  if (!from) return bad('from_entity_id', 'from_entity_id must be an entity in this account')
  if ((link.to_entity_id === null) === (link.to_name === null)) return bad('to_entity_id', 'give exactly one of to_entity_id (an entity in this account) or to_name (a party with no return here)')
  const to = link.to_entity_id ? entities.find(e => e.id === link.to_entity_id) : undefined
  if (link.to_entity_id && !to) return bad('to_entity_id', 'to_entity_id must be an entity in this account')
  if (link.to_entity_id === link.from_entity_id) return bad('to_entity_id', 'a link joins two different entities')
  if (link.from_year !== null && link.to_year !== null && link.from_year > link.to_year) return bad('to_year', 'to_year is before from_year')
  if (link.source !== 'owner' && !link.evidence) return bad('evidence', `a link from ${link.source.replace('_', ' ')} must cite its evidence`)
  if (link.kind === 'owns') {
    if (link.pct === null && !link.removed) return bad('pct', 'an ownership link needs its percentage')
    if (link.nature !== null) return bad('nature', 'nature applies to intercompany links only')
    if (link.subject && from.form_type !== '1040') return bad('subject', 'subject names the person on a 1040 who holds the interest; a business owner is the entity itself')
    if (to && to.form_type === '1040') return bad('to_entity_id', 'an individual return cannot be owned')
  } else {
    if (link.pct !== null) return bad('pct', 'pct applies to ownership links only')
    if (link.subject !== null) return bad('subject', 'subject applies to ownership links only')
    if (from.form_type === '1040' || to?.form_type === '1040') return bad('from_entity_id', `a ${link.kind} link joins businesses; an owner's loans and pay are facts on the owner's entity`)
    if (link.kind === 'intercompany' && !link.nature) return bad('nature', `an intercompany link says how they deal: ${LINK_NATURES.join(', ')}`)
    if (link.kind === 'disregarded' && link.nature !== null) return bad('nature', 'nature applies to intercompany links only')
  }
  return { ok: true, link }
}

function publicRow(r: any): StoredLink {
  return {
    id: r.id, link_key: r.link_key, kind: r.kind, from_entity_id: r.from_entity_id, to_entity_id: r.to_entity_id ?? null, to_name: r.to_name ?? null,
    subject: r.subject ?? null, pct: r.pct === null || r.pct === undefined ? null : Number(r.pct), nature: r.nature ?? null,
    from_year: r.from_year ?? null, to_year: r.to_year ?? null, source: r.source, evidence: r.evidence ?? null, detail: r.detail ?? null,
    removed: !!r.removed, recorded_by: r.recorded_by ?? null, recorded_at: r.recorded_at, superseded_by: r.superseded_by ?? null,
  }
}

const SELECT = `id, link_key, user_id, kind, from_entity_id, to_entity_id, to_name, subject, pct, nature, from_year, to_year, source, evidence, detail, removed, recorded_by, recorded_at, superseded_by, ${LINK_ENC_COLS}`

async function insertVersion(supabase: SupabaseClient, userId: string, link: LinkFields, recordedBy: string | null, linkKey?: string): Promise<any> {
  const payload: Record<string, any> = { user_id: userId, ...link, recorded_by: recordedBy, ...(linkKey ? { link_key: linkKey } : {}) }
  const { data, error } = await supabase.from('entity_link')
    .insert({ ...payload, ...(await encryptedFields(supabase, userId, payload, ENCRYPTED_LINK_FIELDS)) })
    .select(SELECT).single()
  if (error || !data) throw new Error(error?.message ?? 'link insert failed')
  await hydrate(supabase, data, ENCRYPTED_LINK_FIELDS)
  return data
}

export async function addLink(supabase: SupabaseClient, userId: string, link: LinkFields, recordedBy: string | null): Promise<StoredLink> {
  return publicRow(await insertVersion(supabase, userId, link, recordedBy))
}

/** Apply `patch` to the current version of a link: a new version is written
 *  and the old one points at it. Null when there is no current version. */
export async function updateLink(
  supabase: SupabaseClient, userId: string, linkKey: string, patch: Partial<LinkFields>,
  entities: Array<Pick<EntityInfo, 'id' | 'form_type'>>, recordedBy: string | null,
): Promise<{ link: StoredLink } | Bad | null> {
  const { data: rows, error } = await supabase.from('entity_link').select(SELECT)
    .eq('user_id', userId).eq('link_key', linkKey).is('superseded_by', null)
  if (error) throw new Error(error.message)
  const current = (rows ?? [])[0]
  if (!current) return null
  await hydrate(supabase, current, ENCRYPTED_LINK_FIELDS)
  const { id: _id, link_key: _k, recorded_by: _rb, recorded_at: _ra, superseded_by: _sb, ...fields } = publicRow(current)
  const merged = checkLinkComplete({ ...fields, ...patch }, entities)
  if (!merged.ok) return merged
  const inserted = await insertVersion(supabase, userId, merged.link, recordedBy, linkKey)
  const { error: updErr } = await supabase.from('entity_link').update({ superseded_by: inserted.id })
    .eq('user_id', userId).eq('id', current.id).is('superseded_by', null)
  if (updErr) throw new Error(updErr.message)
  return { link: publicRow(inserted) }
}

/** Current versions (removed ones included — they answer suggestions), or
 *  every version with includeHistory. */
export async function listLinks(supabase: SupabaseClient, userId: string, opts: { includeHistory?: boolean } = {}): Promise<StoredLink[]> {
  let q = supabase.from('entity_link').select(SELECT).eq('user_id', userId)
  if (!opts.includeHistory) q = q.is('superseded_by', null)
  const { data, error } = await q.order('recorded_at', { ascending: false })
  if (error) throw new Error(error.message)
  const rows = data ?? []
  await hydrateAll(supabase, rows, ENCRYPTED_LINK_FIELDS)
  return rows.map(publicRow)
}

/** Facts of every entity, for the suggestions that read facts. */
export async function factsByEntity(supabase: SupabaseClient, userId: string, entityIds: string[]): Promise<Map<string, FactLike[]>> {
  const lists = await Promise.all(entityIds.map(id => listFacts(supabase, userId, id)))
  return new Map(entityIds.map((id, i) => [id, lists[i] as unknown as FactLike[]]))
}

/** The whole map for an account: entities, links, owners, what each entity
 *  touches, and the evidence no link answers yet. */
export function assembleMap(bundles: EntityBundle[], links: StoredLink[], facts: Map<string, FactLike[]>) {
  const entities: MapEntity[] = bundles.map(b => ({
    id: b.entity.id, name: b.entity.name, form_type: b.entity.form_type,
    years: [...new Set(b.catalogs.filter(c => c.kind === 'filed_return' && c.tax_year !== null).map(c => c.tax_year as number))].sort(),
  }))
  const suggestions = suggestLinks(bundles, facts)
  const name = (id: string | null) => entities.find(e => e.id === id)?.name ?? null
  return {
    entities: entities.map(e => ({ ...e, touches: touches(e.id, links, entities) })),
    links: linksFor(links).map(l => ({ ...l, from_entity_name: name(l.from_entity_id), to_entity_name: l.to_entity_id ? name(l.to_entity_id) : l.to_name })),
    removed_links: links.filter(l => l.removed).map(l => ({ link_key: l.link_key, kind: l.kind, from_entity_name: name(l.from_entity_id), to_entity_name: l.to_entity_id ? name(l.to_entity_id) : l.to_name, detail: l.detail })),
    owners: byOwner(links, entities),
    unrecorded: unrecorded(links, suggestions).map(s => ({ ...s, from_entity_name: name(s.from_entity_id), to_entity_name: s.to_entity_id ? name(s.to_entity_id) : s.to_name })),
  }
}
