/**
 * Persistence for return catalogs (table return_catalog — see its migration
 * for why). Entries and per-page detail are taxpayer data and are written
 * ciphertext-only; the plaintext columns carry structure only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, hydrateAll, ENCRYPTED_CATALOG_FIELDS } from '../lib/row_crypto.js'
import type { Catalog, CatalogEntry } from './types.js'
import type { CatalogSource } from './query.js'

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
): Promise<{ id: string; status: 'complete' | 'incomplete' }> {
  const { catalog } = args
  const status: 'complete' | 'incomplete' = catalog.coverage.complete ? 'complete' : 'incomplete'
  const plain = {
    user_id: userId,
    entity_id: args.entityId,
    tax_year: args.taxYear,
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
  return { id: data.id, status }
}

export interface CatalogRow {
  id: string
  entity_id: string
  tax_year: number | null
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

const LIST_COLS = 'id, entity_id, tax_year, document_id, return_id, kind, extractor, source_filename, status, forms, coverage, page_index, created_at'

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
    .select('id, user_id, tax_year, kind, source_filename, entries, entries_enc')
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
    entries: ((r.entries as CatalogEntry[] | null) ?? []),
  }))
}
