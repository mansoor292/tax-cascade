/**
 * Catalog routes — every value on every page of a return, and questions
 * answered from it (docs/RETURN_CATALOG_AND_REVIEW.md, requirement R1).
 *
 *   POST /api/catalog/documents/:id     catalogue a stored document (PDF)
 *   POST /api/catalog/upload            store a new return PDF and catalogue it
 *   GET  /api/catalog/:entity_id        current catalogs (structure only)
 *   GET  /api/catalog/:entity_id/status every filed return: catalogued? complete?
 *   GET  /api/catalog/:entity_id/query  entries matching a question, with provenance
 *
 * Upload deliberately does NOT go through /documents/ingest: that path runs
 * Gemini classification, Textract and the regex filed-import mapper, which
 * keeps 10–40% of a return and writes another filed_import row each time
 * (EZA has three for 2022). The catalog replaces that reading of a return.
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { s3PutObject, s3GetObject } from '../lib/s3.js'
import { encryptedFields, ENCRYPTED_DOC_FIELDS } from '../lib/row_crypto.js'
import { sendError, sendDbError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { catalogPdf } from '../catalog/extract.js'
import { saveCatalog, listCatalogs, loadSources, kindForDocType, type CatalogKind } from '../catalog/store.js'
import { filterEntries, cite, type CatalogQuery } from '../catalog/query.js'

const supabase = lazyServiceClient()
const router = Router()

async function ownsEntity(userId: string, entityId: string): Promise<boolean> {
  const { data } = await supabase.from('tax_entity').select('id').eq('id', entityId).eq('user_id', userId).maybeSingle()
  return !!data
}

function summary(id: string, status: string, cat: Awaited<ReturnType<typeof catalogPdf>>) {
  return {
    catalog_id: id,
    status,
    coverage: cat.coverage,
    pages: cat.pages.map(p => ({
      page: p.page, kind: p.kind, form: p.title, rev: p.rev, instance: p.instance || undefined,
      aligned: p.aligned || undefined, entries: p.entries, unassigned: p.residue.length,
    })),
  }
}

router.post('/documents/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { data: doc, error } = await supabase.from('document')
      .select('id, entity_id, s3_path, filename, doc_type, tax_year, file_type')
      .eq('id', req.params.id).eq('user_id', userId).maybeSingle()
    if (error) return sendDbError(res, error)
    if (!doc) return res.status(404).json({ error: 'Not found' })
    if (!doc.entity_id) return res.status(400).json({ error: 'Document is not linked to an entity' })
    if (doc.file_type === 'fact' || !/\.pdf$/i.test(doc.s3_path ?? '')) {
      return res.status(400).json({ error: 'Only PDF documents can be catalogued' })
    }
    const taxYear = Number(req.body?.tax_year ?? doc.tax_year) || undefined
    const bytes = new Uint8Array(await s3GetObject(doc.s3_path))
    const cat = await catalogPdf(bytes, { filename: doc.filename, taxYear })
    const kind: CatalogKind = req.body?.kind ?? kindForDocType(doc.doc_type)
    const saved = await saveCatalog(supabase, userId, {
      entityId: doc.entity_id, taxYear: taxYear ?? null, documentId: doc.id, kind, catalog: cat,
    })
    res.json(summary(saved.id, saved.status, cat))
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/upload', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const { entity_id, tax_year, filename, content_base64, doc_type } = req.body ?? {}
  if (!entity_id || !filename || !content_base64) {
    return res.status(400).json({ error: 'entity_id, filename and content_base64 are required' })
  }
  if (!/\.pdf$/i.test(filename)) return res.status(400).json({ error: 'Only PDF returns can be catalogued' })
  try {
    if (!(await ownsEntity(userId, entity_id))) return res.status(404).json({ error: 'Entity not found' })
    const buf = Buffer.from(String(content_base64), 'base64')
    if (buf.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'content_base64 is not a PDF' })
    const year = Number(tax_year) || null
    const s3Key = `documents/${userId}/${uuidv4()}.pdf`
    const { bytes, sha256 } = await s3PutObject(s3Key, buf, 'application/pdf')
    const meta = { source: 'catalog_upload', size: bytes, content_hash: sha256 }
    const docRow = {
      user_id: userId, entity_id, filename, file_type: 'pdf', s3_path: s3Key,
      doc_type: doc_type ?? null, tax_year: year, extracted_at: new Date().toISOString(),
      processing_status: 'done', meta,
    }
    const { data: doc, error } = await supabase.from('document')
      .insert({ ...docRow, ...(await encryptedFields(supabase, userId, docRow, ENCRYPTED_DOC_FIELDS)) })
      .select('id').single()
    if (error || !doc) return sendDbError(res, error ?? { message: 'insert failed' })
    const cat = await catalogPdf(new Uint8Array(buf), { filename, taxYear: year ?? undefined })
    const saved = await saveCatalog(supabase, userId, {
      entityId: entity_id, taxYear: year, documentId: doc.id, kind: kindForDocType(doc_type), catalog: cat,
    })
    res.json({ document_id: doc.id, ...summary(saved.id, saved.status, cat) })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.get('/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    if (!(await ownsEntity(userId, req.params.entity_id))) return res.status(404).json({ error: 'Entity not found' })
    res.json({ catalogs: await listCatalogs(supabase, userId, req.params.entity_id, { all: req.query.all === '1' }) })
  } catch (e: any) {
    sendError(res, e)
  }
})

/** The completeness question the owner asks: is every filed return in the
 *  system catalogued, and catalogued completely? A filed-return document
 *  without a current catalog is listed as a gap. */
router.get('/:entity_id/status', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const entityId = req.params.entity_id
  try {
    if (!(await ownsEntity(userId, entityId))) return res.status(404).json({ error: 'Entity not found' })
    const catalogs = await listCatalogs(supabase, userId, entityId)
    const { data: docs, error } = await supabase.from('document')
      .select('id, filename, doc_type, tax_year, file_type')
      .eq('user_id', userId).eq('entity_id', entityId)
    if (error) return sendDbError(res, error)
    const returnDocs = (docs ?? []).filter(d => d.file_type !== 'fact' && /^prior_return_|transcript/.test(d.doc_type ?? ''))
    const byDoc = new Map(catalogs.filter(c => c.document_id).map(c => [c.document_id!, c]))
    const years = new Map<number | 'unknown', any[]>()
    for (const d of returnDocs) {
      const c = byDoc.get(d.id)
      const row = {
        document_id: d.id, filename: d.filename, doc_type: d.doc_type,
        catalogued: !!c, status: c?.status ?? 'not catalogued',
        catalog_id: c?.id, problems: c?.coverage.problems ?? [], warnings: c?.coverage.warnings?.length ?? 0,
      }
      const k = d.tax_year ?? 'unknown'
      years.set(k, [...(years.get(k) ?? []), row])
    }
    const rows = [...years.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([year, documents]) => ({ tax_year: year, documents }))
    const gaps = rows.flatMap(r => r.documents.filter((d: any) => d.status !== 'complete')
      .map((d: any) => `${r.tax_year} ${d.doc_type}: ${d.status}`))
    res.json({ entity_id: entityId, complete: gaps.length === 0, gaps, years: rows })
  } catch (e: any) {
    sendError(res, e)
  }
})

function listParam(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  const arr = Array.isArray(v) ? v : String(v).split(',')
  const out = arr.map(s => String(s).trim()).filter(Boolean)
  return out.length ? out : undefined
}

router.get('/:entity_id/query', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const entityId = req.params.entity_id
  try {
    if (!(await ownsEntity(userId, entityId))) return res.status(404).json({ error: 'Entity not found' })
    const years = listParam(req.query.years)?.map(Number).filter(Number.isFinite)
    const q: CatalogQuery = {
      years,
      forms: listParam(req.query.forms),
      section: req.query.section as string | undefined,
      line: req.query.line as string | undefined,
      col: req.query.col as string | undefined,
      row: req.query.row as string | undefined,
      canonical: req.query.canonical as string | undefined,
      text: req.query.text as string | undefined,
      kinds: listParam(req.query.kinds) as CatalogQuery['kinds'],
      include_copies: req.query.include_copies === '1' || req.query.include_copies === 'true',
      include_unassigned: req.query.include_unassigned === '0' || req.query.include_unassigned === 'false' ? false : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }
    const kinds = listParam(req.query.sources) as CatalogKind[] | undefined
    const sources = await loadSources(supabase, userId, entityId, years, kinds)
    const hits = filterEntries(sources, q)
    res.json({
      count: hits.length,
      catalogs_searched: sources.length,
      hits: hits.map(h => ({
        where: cite(h), tax_year: h.tax_year, form: h.title, page: h.page, section: h.section,
        line: h.line, row: h.row, col: h.col, label: h.label, kind: h.kind, value: h.value, printed: h.raw,
        amounts: h.amounts, canonical: h.canonical, instance: h.instance || undefined, entry_id: h.id, catalog_id: h.catalog_id,
      })),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
