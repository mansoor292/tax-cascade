/**
 * Record an amendment as filed: the signed amended return, uploaded to it.
 *
 * Owner's rule (Mansoor, 2026-10-23): nothing recorded an amendment as filed
 * (UI audit #26). The copy is the record, as a filed PDF is for an original
 * return (decision 1): it is stored, catalogued as 'amended_return' with
 * return_id = the amendment, and the amendment's row becomes status 'filed',
 * which locks its lines (compute_return refuses it) the way a filed return is
 * immutable. Accepted is read from the transcripts on every read
 * (review/filing.ts: a TC977), never stored.
 *
 * Its own catalog kind, not 'filed_return': the year's filed_return catalog
 * is THE return as filed everywhere (Compare, the checks, the amendment base),
 * and an amended copy must never stand in for it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { v4 as uuidv4 } from 'uuid'
import { s3PutObject, s3GetObject } from '../lib/s3.js'
import { encryptedFields, ENCRYPTED_DOC_FIELDS } from '../lib/row_crypto.js'
import { catalogPdf } from '../catalog/extract.js'
import { saveCatalog } from '../catalog/store.js'

export interface FiledCopy { s3_key?: string; content_base64?: string; filename: string }

export type RecordFiledResult =
  | { ok: true; return_id: string; tax_year: number; filed_at: string; document_id: string; catalog_id: string; catalog_status: string }
  | { ok: false; status: number; error: string }

export async function recordAmendmentFiled(
  supabase: SupabaseClient, userId: string, returnId: string, copy: FiledCopy,
): Promise<RecordFiledResult> {
  const { data: ret } = await supabase.from('tax_return')
    .select('id, entity_id, tax_year, form_type, source, status').eq('id', returnId).maybeSingle()
  if (!ret) return { ok: false, status: 404, error: 'Return not found' }
  const { data: ent } = await supabase.from('tax_entity').select('user_id').eq('id', ret.entity_id).maybeSingle()
  if (!ent || ent.user_id !== userId) return { ok: false, status: 404, error: 'Return not found' }
  if (ret.source !== 'amendment') return { ok: false, status: 400, error: 'Only an amendment is recorded as filed this way — upload a filed original return in Documents' }
  if (ret.status === 'filed') return { ok: false, status: 409, error: `This ${ret.tax_year} amendment is already recorded as filed` }
  if (!copy.filename || !/\.pdf$/i.test(copy.filename)) return { ok: false, status: 400, error: 'The filed copy must be a PDF' }

  let buf: Buffer
  let s3Key: string
  if (copy.s3_key) {
    // Only a key this user's presign issued: documents/<user id>/<uuid>.pdf
    if (!copy.s3_key.startsWith(`documents/${userId}/`) || !/\.pdf$/i.test(copy.s3_key)) {
      return { ok: false, status: 400, error: 's3_key is not an upload of yours' }
    }
    s3Key = copy.s3_key
    buf = await s3GetObject(s3Key)
  } else if (copy.content_base64) {
    buf = Buffer.from(String(copy.content_base64), 'base64')
    s3Key = `documents/${userId}/${uuidv4()}.pdf`
  } else {
    return { ok: false, status: 400, error: 's3_key or content_base64 is required' }
  }
  if (buf.subarray(0, 5).toString() !== '%PDF-') return { ok: false, status: 400, error: 'The filed copy is not a PDF' }
  const put = copy.content_base64 ? await s3PutObject(s3Key, buf, 'application/pdf') : null

  const docRow = {
    user_id: userId, entity_id: ret.entity_id, filename: copy.filename, file_type: 'pdf', s3_path: s3Key,
    doc_type: 'amended_return', tax_year: ret.tax_year, extracted_at: new Date().toISOString(),
    processing_status: 'done', meta: { source: 'amendment_filed', return_id: ret.id, size: buf.length, ...(put ? { content_hash: put.sha256 } : {}) },
  }
  const { data: doc, error } = await supabase.from('document')
    .insert({ ...docRow, ...(await encryptedFields(supabase, userId, docRow, ENCRYPTED_DOC_FIELDS)) })
    .select('id').single()
  if (error || !doc) throw new Error(`saving the filed copy failed: ${error?.message ?? 'no row'}`)

  const cat = await catalogPdf(new Uint8Array(buf), { filename: copy.filename, taxYear: ret.tax_year })
  const saved = await saveCatalog(supabase, userId, {
    entityId: ret.entity_id, taxYear: ret.tax_year, documentId: doc.id, returnId: ret.id, kind: 'amended_return', catalog: cat,
  })

  const filedAt = new Date().toISOString()
  const { error: upErr } = await supabase.from('tax_return').update({ status: 'filed', filed_at: filedAt }).eq('id', ret.id)
  if (upErr) throw new Error(`recording the amendment as filed failed: ${upErr.message}`)
  return { ok: true, return_id: ret.id, tax_year: ret.tax_year, filed_at: filedAt, document_id: doc.id, catalog_id: saved.id, catalog_status: saved.status }
}

/** Deleting an amendment deletes the record of its filing too: the
 *  catalogued copy and the uploaded PDF it was filed with. */
export async function deleteAmendmentCopies(supabase: SupabaseClient, userId: string, returnId: string): Promise<void> {
  const { data: cats } = await supabase.from('return_catalog').select('id, document_id')
    .eq('user_id', userId).eq('return_id', returnId).eq('kind', 'amended_return')
  if (!cats?.length) return
  const docs = cats.map(c => c.document_id).filter((x): x is string => !!x)
  await supabase.from('return_catalog').delete().in('id', cats.map(c => c.id))
  if (docs.length) await supabase.from('document').delete().eq('user_id', userId).in('id', docs)
}
