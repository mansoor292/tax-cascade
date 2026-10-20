/**
 * Persistence for return catalogs (table return_catalog — see its migration
 * for why). Entries and per-page detail are taxpayer data and are written
 * ciphertext-only; the plaintext columns carry structure only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, hydrateAll, ENCRYPTED_CATALOG_FIELDS } from '../lib/row_crypto.js'
import type { Catalog, CatalogEntry, TranscriptMeta } from './types.js'
import type { CatalogSource } from './query.js'
import { transcriptParts } from './transcript.js'
import { keyEntries } from '../schema/index.js'

export type CatalogKind = 'filed_return' | 'computed_return' | 'irs_transcript' | 'irs_notice' | 'other'

export interface PageIndexRow {
  page: number
  kind: string
  form?: string
  title?: string
  rev?: string
  blank_page?: number
  instance?: string
  score?: number
  aligned?: boolean
  entries: number
  residue: number
}

export function pageIndex(cat: Catalog): PageIndexRow[] {
  return cat.pages.map(p => ({
    page: p.page, kind: p.kind,
    ...(p.form ? { form: p.form, title: p.title, rev: p.rev, blank_page: p.blank_page } : {}),
    ...(p.instance ? { instance: p.instance } : {}),
    ...(p.score !== undefined ? { score: p.score } : {}),
    ...(p.aligned ? { aligned: true } : {}),
    entries: p.entries, residue: p.residue.length,
  }))
}

export function kindForDocType(docType: string | null | undefined): CatalogKind {
  if (!docType) return 'other'
  if (docType.startsWith('prior_return_')) return 'filed_return'
  if (/transcript/.test(docType)) return 'irs_transcript'
  if (/notice|irs_letter/.test(docType)) return 'irs_notice'
  return 'other'
}

export async function saveCatalog(
  supabase: SupabaseClient,
  userId: string,
  args: { entityId: string; taxYear: number | null; documentId?: string | null; returnId?: string | null; kind: CatalogKind; catalog: Catalog },
): Promise<{ id: string; status: 'complete' | 'incomplete'; tax_year: number | null; transcript?: TranscriptMeta & { golden: boolean } }> {
  const { catalog } = args
  const status: 'complete' | 'incomplete' = catalog.coverage.complete ? 'complete' : 'incomplete'
  // A transcript's own period names its year (an upload labelled 2024 that
  // is the 2025 transcript is filed under 2025).
  const taxYear = args.kind === 'irs_transcript' ? (catalog.transcript?.tax_year ?? args.taxYear) : args.taxYear
  const plain = {
    user_id: userId,
    entity_id: args.entityId,
    tax_year: taxYear,
    transcript_type: args.kind === 'irs_transcript' ? (catalog.transcript?.type ?? 'account') : null,
    as_of: args.kind === 'irs_transcript' ? (catalog.transcript?.as_of ?? null) : null,
    document_id: args.documentId ?? null,
    return_id: args.returnId ?? null,
    kind: args.kind,
    extractor: catalog.extractor,
    source_sha256: catalog.source.sha256,
    source_filename: catalog.source.filename,
    status,
    forms: [...new Set(catalog.pages.filter(p => p.title).map(p => p.title!))],
    coverage: catalog.coverage,
    page_index: pageIndex(catalog),
    entries: catalog.entries,
    pages: catalog.pages,
  }
  // Previous current catalog of the same source (same document, or the same
  // bytes for this entity) — superseded, never edited.
  let prev: Array<{ id: string }> = []
  if (args.documentId) {
    const { data } = await supabase.from('return_catalog').select('id')
      .eq('document_id', args.documentId).is('superseded_by', null)
    prev = data ?? []
  } else {
    const { data } = await supabase.from('return_catalog').select('id')
      .eq('entity_id', args.entityId).eq('source_sha256', catalog.source.sha256).is('superseded_by', null)
    prev = data ?? []
  }
  // The unique "one current catalog per document" index forbids two current
  // rows, so detach the old one first, then point it at the new row.
  if (prev.length) {
    await supabase.from('return_catalog').update({ document_id: null }).in('id', prev.map(p => p.id))
  }
  const { data, error } = await supabase.from('return_catalog')
    .insert({ ...plain, ...(await encryptedFields(supabase, userId, plain, ENCRYPTED_CATALOG_FIELDS)) })
    .select('id').single()
  if (error || !data) throw new Error(`saving catalog failed: ${error?.message ?? 'no row'}`)
  if (prev.length) {
    await supabase.from('return_catalog').update({ superseded_by: data.id, document_id: args.documentId ?? null })
      .in('id', prev.map(p => p.id))
  }
  if (args.kind !== 'irs_transcript' || taxYear === null) return { id: data.id, status, tax_year: taxYear }
  const kept = await reconcileTranscripts(supabase, userId, args.entityId, taxYear)
  return { id: data.id, status, tax_year: taxYear, transcript: { ...(catalog.transcript ?? { type: 'account', form: null, period: null, tax_year: taxYear, as_of: null, no_record: false }), golden: kept.keep.has(data.id) } }
}

export type TranscriptType = TranscriptMeta['type']

export interface TranscriptRow { id: string; transcript_type: TranscriptType | null; as_of: string | null; created_at: string | null }

/** The golden transcripts of one entity-year: the newest account transcript
 *  and the newest return transcript, by the IRS's response date. A record of
 *  account carries both, and loses a tie to the dedicated transcript of the
 *  same date. Wage-and-income and other transcripts keep one per type.
 *  Everything else is superseded by the golden copy of its own kind. */
export function goldenTranscripts(rows: TranscriptRow[]): { account?: string; return?: string; keep: Set<string>; supersede: Array<{ id: string; by: string }> } {
  const newest = (cands: TranscriptRow[], dedicated: TranscriptType | null) => [...cands].sort((a, b) =>
    (b.as_of ?? '').localeCompare(a.as_of ?? '') ||
    Number((a.transcript_type ?? 'account') !== dedicated) - Number((b.transcript_type ?? 'account') !== dedicated) ||
    (b.created_at ?? '').localeCompare(a.created_at ?? '') ||
    b.id.localeCompare(a.id))[0]
  const of = (part: 'account' | 'return') => newest(rows.filter(r => transcriptParts(r.transcript_type).includes(part)), part)?.id
  const account = of('account')
  const ret = of('return')
  const keep = new Set([account, ret].filter((x): x is string => !!x))
  const byType = new Map<string, string>()
  for (const t of ['wage_income', 'other'] as const) {
    const g = newest(rows.filter(r => r.transcript_type === t), t)
    if (g) { keep.add(g.id); byType.set(t, g.id) }
  }
  const supersede = rows.filter(r => !keep.has(r.id)).map(r => {
    const part = transcriptParts(r.transcript_type)[0]
    const by = part === 'account' ? account : part === 'return' ? ret : byType.get(r.transcript_type ?? '')
    return { id: r.id, by: by ?? account ?? ret! }
  }).filter(x => !!x.by)
  return { account, return: ret, keep, supersede }
}

/** Enforce one golden transcript of each kind for an entity-year. Idempotent
 *  and deterministic, so two workers reconciling at once converge. */
export async function reconcileTranscripts(supabase: SupabaseClient, userId: string, entityId: string, taxYear: number): Promise<ReturnType<typeof goldenTranscripts>> {
  const { data, error } = await supabase.from('return_catalog')
    .select('id, transcript_type, as_of, created_at')
    .eq('user_id', userId).eq('entity_id', entityId).eq('tax_year', taxYear)
    .eq('kind', 'irs_transcript').is('superseded_by', null)
  if (error) throw new Error(`reading transcripts failed: ${error.message}`)
  const g = goldenTranscripts((data ?? []) as TranscriptRow[])
  for (const s of g.supersede) {
    const { error: e } = await supabase.from('return_catalog').update({ superseded_by: s.by }).eq('id', s.id).is('superseded_by', null)
    if (e) throw new Error(`superseding transcript failed: ${e.message}`)
  }
  return g
}

export interface CatalogRow {
  id: string
  entity_id: string
  tax_year: number | null
  transcript_type?: TranscriptType | null
  as_of?: string | null
  superseded_by?: string | null
  document_id: string | null
  return_id: string | null
  kind: CatalogKind
  extractor: string
  source_filename: string | null
  status: string
  forms: string[]
  coverage: Catalog['coverage']
  page_index: PageIndexRow[]
  created_at: string
}

const LIST_COLS = 'id, entity_id, tax_year, transcript_type, as_of, superseded_by, document_id, return_id, kind, extractor, source_filename, status, forms, coverage, page_index, created_at'

export async function listCatalogs(supabase: SupabaseClient, userId: string, entityId: string, opts: { all?: boolean } = {}): Promise<CatalogRow[]> {
  let q = supabase.from('return_catalog').select(LIST_COLS)
    .eq('user_id', userId).eq('entity_id', entityId)
    .order('tax_year', { ascending: true }).order('created_at', { ascending: false })
  if (!opts.all) q = q.is('superseded_by', null)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as CatalogRow[]
}

/** Current catalogs of an entity with their entries decrypted. */
export async function loadSources(
  supabase: SupabaseClient, userId: string, entityId: string, years?: number[], kinds?: CatalogKind[],
): Promise<CatalogSource[]> {
  let q = supabase.from('return_catalog')
    .select('id, user_id, tax_year, kind, status, transcript_type, as_of, source_filename, entries, entries_enc')
    .eq('user_id', userId).eq('entity_id', entityId).is('superseded_by', null)
  if (years?.length) q = q.in('tax_year', years)
  if (kinds?.length) q = q.in('kind', kinds)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = await hydrateAll(supabase, data ?? [], { json: ['entries'] })
  return rows.map(r => ({
    catalog_id: r.id as string,
    tax_year: (r.tax_year as number | null) ?? null,
    source_filename: r.source_filename as string | null,
    kind: r.kind as string, status: r.status as string,
    transcript_type: (r.transcript_type as string | null) ?? null, as_of: (r.as_of as string | null) ?? null,
    // golden keys applied on read: a schema improvement reaches stored catalogs
    entries: keyEntries((r.entries as CatalogEntry[] | null) ?? []),
  }))
}
