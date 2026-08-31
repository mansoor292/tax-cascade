/**
 * Document routes — Presigned upload, Gemini categorization, Textract extraction
 *
 * Flow:
 *   1. GET /presign — get presigned S3 PUT URL
 *   2. Browser uploads directly to S3
 *   3. POST /register — tell API about the file, triggers Gemini categorization
 *   4. POST /:id/extract — run Textract
 */
import { Router,  } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { s3PresignPut, s3PresignGet, s3PresignGetMany, s3PutObject, s3GetObject } from '../lib/s3.js'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_DOC_FIELDS, DOC_ENC_COLS } from '../lib/row_crypto.js'
import { sendError, sendDbError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import {
  archiveDocumentAsReturn, extractAndArchive, reextractDocument,
  classifyTaxDocument, CLASSIFIABLE_EXTENSIONS,
} from '../services/document_extraction.js'
import { dispatchExtraction } from '../lib/extraction_dispatch.js'


const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

const supabase = lazyServiceClient()

const router = Router()

// Shared archive orchestrator — runs the mapper + archiveFiledReturn against
// a document's stored textract_data and inserts a filed_import tax_return row.
// Used on first ingest and by the /:id/rearchive endpoint (after mapper fixes).
// Get presigned upload URL
router.get('/presign', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const filename = req.query.filename as string
  if (!filename) return res.status(400).json({ error: 'filename required' })

  const ext = filename.split('.').pop()?.toLowerCase() || 'pdf'
  const s3Key = `documents/${userId}/${uuidv4()}.${ext}`

  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }

  try {
    const url = await s3PresignPut(s3Key, contentTypes[ext] || 'application/octet-stream', 300)

    res.json({
      upload_url: url,
      s3_key: s3Key,
      content_type: contentTypes[ext] || 'application/octet-stream',
      expires_in: 300,
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// Get presigned download URL
router.get('/:id/download', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: doc } = await supabase.from('document')
    .select('s3_path').eq('id', req.params.id).eq('user_id', userId!).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })

  try {
    res.json({ url: await s3PresignGet(doc.s3_path, 3600) })
  } catch (e: any) {
    sendError(res, e)
  }
})

// Ingest document — dual-mode:
//   Mode A: inline base64 (image pasted in chat) → uploads to S3 first
//   Mode B: s3_key (already uploaded via presign) → skips upload
// Either way, delegates to the same classify+extract pipeline as /register.
router.post('/ingest', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { filename, base64, s3_key: existingKey, file_size, entity_id } = req.body
  if (!filename) return res.status(400).json({ error: 'filename required' })
  if (!base64 && !existingKey) return res.status(400).json({ error: 'base64 or s3_key required' })

  // Mode B: s3_key already provided (file was pre-uploaded via presign) — skip straight to register
  if (existingKey && !base64) {
    req.body = { s3_key: existingKey, filename, file_size, entity_id }
    return registerHandler(req, res)
  }

  const ext = filename.split('.').pop()?.toLowerCase() || 'pdf'
  const s3Key = `documents/${userId}/${uuidv4()}.${ext}`
  const contentType = ({
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    heic: 'image/heic', webp: 'image/webp',
  } as any)[ext] || 'application/octet-stream'

  // Upload to S3, computing the SHA-256 of the content so we can dedupe
  // against prior uploads — when the same PDF is uploaded twice (different
  // filename, different s3_key, same bytes) the second upload reuses the
  // cached textract_data and skips the AWS call entirely. Saves the full
  // ~$0.065/page bill on repeated uploads.
  try {
    const { bytes: size, sha256: contentHash } = await s3PutObject(
      s3Key, Buffer.from(base64, 'base64'), contentType,
    )

    // Look for a prior document with the same content hash that already has
    // a successful Textract extraction. We can copy its textract_data and
    // skip the AWS call. The presigned-upload path doesn't go through here
    // (it skips straight to registerHandler), so this dedupe only kicks in
    // for inline-base64 uploads — which is fine, that's where the hash is
    // already in hand.
    let dedupeTextract: any = null
    if (contentHash) {
      // Limitation: the match runs on the PLAINTEXT meta->>content_hash, which
      // rows written after the encryption cutover no longer carry — so dedupe
      // only ever matches pre-cutover rows. Moving content_hash to its own
      // column (or a blind index) is a roadmap item; until then a re-upload of
      // a post-cutover document re-runs Textract.
      const { data: priorDoc } = await supabase.from('document')
        .select(`user_id, textract_data, doc_type, tax_year, meta, ${DOC_ENC_COLS}`)
        .eq('user_id', userId)
        .eq('meta->>content_hash', contentHash)
        .not('textract_data', 'is', null)
        .order('extracted_at', { ascending: false })
        .limit(1).maybeSingle()
      if (priorDoc?.textract_data) {
        await hydrate(supabase, priorDoc, { ...ENCRYPTED_DOC_FIELDS, userId })
        dedupeTextract = priorDoc.textract_data
      }
    }

    // Forward to /register — pass content_hash so registerHandler can stash
    // it on the new row and (if dedupe hit) skip the Textract call.
    req.body = {
      s3_key: s3Key,
      filename,
      file_size: size,
      entity_id,
      content_hash: contentHash,
      ...(dedupeTextract ? { _deduped_textract: dedupeTextract } : {}),
    }
    return registerHandler(req, res)
  } catch (e: any) {
    sendError(res, e)
  }
})

// Factored so /ingest can reuse it
/**
 * Register an uploaded file.
 *
 * The row is created and returned IMMEDIATELY; classification and extraction
 * run afterwards and update it.
 *
 * They used to run on the request. Gemini plus a Textract job — including its
 * polling loop — takes roughly 8s plus 0.85s per page, and the proxy in front
 * of the site gives up at about 26s. Measured: a 20-page return took 24.8s and
 * squeaked through; a 34-page return answered 504 to the browser at 28.0s
 * while the same request straight to the API returned 200 and created the
 * document. So the upload succeeded and the person was told it had failed —
 * and could not tell that from a genuine failure, which is worse than either.
 *
 * Pass ?wait=1 to keep the old synchronous behaviour for callers that control
 * their own timeout and want the extraction in the response.
 */
const registerHandler = async (req: any, res: any) => {
  const userId = await getUser(req)

  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { s3_key, filename, file_size, entity_id, content_hash, _deduped_textract } = req.body
  if (!s3_key || !filename) return res.status(400).json({ error: 's3_key and filename required' })

  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const wait = req.query?.wait === '1' || req.query?.wait === 'true'

  // Create the row up front so the file is visible and attributable the moment
  // the upload lands, whatever happens to the extraction afterwards.
  const { data: doc0, error: insErr } = await supabase.from('document').insert({
    user_id: userId,
    entity_id: entity_id || null,
    filename,
    file_type: ext,
    s3_path: s3_key,
    doc_type: 'other',
    processing_status: 'processing',
    processing_started_at: new Date().toISOString(),
  }).select().single()
  if (insErr) return sendDbError(res, insErr)

  const args = {
    docId: doc0.id, userId, s3_key, filename, file_size, ext,
    entity_id: entity_id || null, content_hash, _deduped_textract,
  }

  if (!wait) {
    // Answer now. The browser shows the document as processing and polls.
    res.status(202).json({
      document: { ...doc0, processing_status: 'processing' },
      processing: true,
      note: 'Upload stored. Classification and extraction are running; the document will update shortly.',
    })
    dispatchExtraction({ kind: 'ingest', ...args }, () => extractAndArchive(args))
      .catch(e => console.error(`[register] background work failed for ${doc0.id}:`, e?.message))
    return
  }

  // ?wait=1 asks for the finished result in the response body, which an async
  // worker cannot provide — so this path stays in-process by definition.
  const result = await extractAndArchive(args)
  return res.json(result)
}

router.post('/register', registerHandler)

// Re-run archive on a previously-ingested prior_return_* document. Uses the
// stored textract_data (no new AWS calls) with the CURRENT mapper rules —
// inserts a fresh filed_import row so mapper/archive improvements can be
// applied without re-running Textract. Older filed_import rows are left in
// place; compare_returns prefers the newest by computed_at.
router.post('/:id/rearchive', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data: doc } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })
  await hydrate(supabase, doc, ENCRYPTED_DOC_FIELDS)

  const isReturn = ['prior_return_1040', 'prior_return_1120', 'prior_return_1120s', 'prior_return_1065'].includes(doc.doc_type)
  if (!isReturn) return res.status(400).json({ error: `doc_type ${doc.doc_type} is not a prior return` })
  if (!doc.textract_data?.kvs?.length) {
    return res.status(400).json({ error: 'Document has no textract data — run /extract first' })
  }

  const classification = {
    doc_type: doc.doc_type,
    tax_year: doc.tax_year,
    entity_name: doc.meta?.entity_name || '',
  }
  const result = await archiveDocumentAsReturn(doc, classification, userId, doc.entity_id, doc.textract_data)
  if (!result) return res.status(500).json({ error: 'Archive failed (see server logs)' })
  res.json({ rearchived: result })
})

// Record a tax fact directly from conversation (no file upload required).
// Creates a document row with doc_type set to the category — flows through
// the same auto-merge pipeline as uploaded W-2s / 1099s / K-1s.
router.post('/fact', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { entity_id, tax_year, category, values, source_note, summary } = req.body
  if (!entity_id || !tax_year || !category || !values) {
    return res.status(400).json({ error: 'entity_id, tax_year, category, values required' })
  }

  // The row is written under the caller's own user_id, so this was never a
  // cross-account write — but the entity was not checked, so a fact could be
  // filed against an entity the caller does not own and would then sit in
  // their account attached to nothing they can see.
  const { data: ownEntity } = await supabase.from('tax_entity')
    .select('id').eq('id', entity_id).eq('user_id', userId).maybeSingle()
  if (!ownEntity) return res.status(404).json({ error: 'Entity not found' })

  // Whitelist categories to match doc_type vocabulary
  const validCategories = [
    'w2', 'k1',
    '1099_int', '1099_div', '1099_b', '1099_r', '1099_misc', '1099_nec',
    '1099_k', '1099_g', '1099_sa', '1099_oid', '1099',
    'bank_statement', 'rental_income', 'business_income', 'other',
  ]
  if (!validCategories.includes(category)) {
    return res.status(400).json({
      error: `Invalid category: ${category}`,
      supported: validCategories,
    })
  }

  const factMeta = {
    source: 'manual',
    source_note: source_note || '',
    summary: summary || `Recorded ${category} fact`,
    key_values: values,
  }
  const factEnc = await encryptedFields(supabase, userId,
    { meta: factMeta }, ENCRYPTED_DOC_FIELDS)
  const { data, error } = await supabase.from('document').insert({
    user_id: userId,
    entity_id,
    filename: `manual: ${category}${source_note ? ` — ${source_note.slice(0, 50)}` : ''}`,
    file_type: 'fact',
    s3_path: `fact://${entity_id}/${tax_year}/${category}/${Date.now()}`,
    doc_type: category,
    tax_year,
    textract_data: null,
    extracted_at: new Date().toISOString(),
    meta: factMeta,
    ...factEnc,
  }).select().single()

  if (error) return sendDbError(res, error)

  // ── Auto-compute on fact write ────────────────────────────────────
  // Fact drop-ins flow through compute_return's auto-merge block — but
  // only when compute_return actually runs. To keep the proforma in
  // sync without requiring a separate call, fire a compute inline here.
  // We pass inputs:{} so compute preserves existing input_data and only
  // the newly-added fact (and any other facts) flow through the merge.
  let auto_computed: { return_id?: string; error?: string } | null = null
  try {
    const { data: ent } = await supabase.from('tax_entity')
      .select('form_type').eq('id', entity_id).eq('user_id', userId).single()
    const form_type = ent?.form_type
    if (form_type) {
      const base = `${req.protocol}://${req.get('host')}`
      const computeResp = await fetch(`${base}/api/returns/compute`, {
        method: 'POST',
        headers: {
          'Authorization': req.headers.authorization || '',
          'x-api-key': (req.headers['x-api-key'] as string) || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id, tax_year, form_type, inputs: {} }),
      }).then(r => r.json())
      if (computeResp?.return_id) {
        auto_computed = { return_id: computeResp.return_id }
      } else if (computeResp?.error) {
        auto_computed = { error: computeResp.error }
      }
    }
  } catch (e: any) {
    auto_computed = { error: e.message }
  }

  res.json({
    document_id: data.id,
    category,
    values,
    auto_computed,
    note: 'Recorded as a virtual document and synced into the matching proforma (if entity has a form_type). Use auto_computed.return_id to reference the updated return.',
  })
})

// Re-categorize an existing document with Gemini
router.post('/:id/categorize', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: doc } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId!).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })
  await hydrate(supabase, doc, ENCRYPTED_DOC_FIELDS)

  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const ext = doc.file_type || doc.filename?.split('.').pop()?.toLowerCase() || ''
  if (!CLASSIFIABLE_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: 'Only PDF and image files can be categorized' })
  }

  try {
    // Same prompt and call as ingest — classifyTaxDocument. This route used
    // to carry its own inline copy, which drifted: it never learned
    // prior_return_1065 (or the specific 1099 variants), so re-categorizing
    // an already-uploaded 1065 kept answering "other".
    const base64 = (await s3GetObject(doc.s3_path)).toString('base64')
    const classification = await classifyTaxDocument(base64, ext)

    const newMeta = {
      ...doc.meta,
      entity_name: classification.entity_name || '',
      ein_or_ssn: classification.ein_or_ssn || '',
      summary: classification.summary || '',
      key_values: classification.key_values || {},
    }
    const recatEnc = await encryptedFields(supabase, userId,
      { meta: newMeta }, ENCRYPTED_DOC_FIELDS)
    await supabase.from('document').update({
      doc_type: classification.doc_type || doc.doc_type,
      tax_year: classification.tax_year || doc.tax_year,
      meta: newMeta,
      ...recatEnc,
    }).eq('id', req.params.id)

    res.json({ document_id: req.params.id, classification })
  } catch (e: any) {
    sendError(res, e)
  }
})

// List documents — includes presigned download_url per doc so callers
// don't have to round-trip through /:id/download.
//
// Textract payloads are stripped by default. They dominate the response:
// on a 22-document account, textract_data + textract_data_enc were 98% of
// a 4.9 MB body, which overflows an MCP client's context on the first call.
// Callers that need the raw KVs fetch one doc via GET /:id, or pass ?full=1.
router.get('/', async (req, res) => {
  const userId = await getUser(req)

  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data, error } = await supabase.from('document')
    .select('*, tax_entity(name)')
    .eq('user_id', userId!)
    .order('created_at', { ascending: false })

  if (error) return sendDbError(res, error)

  const docs = data || []
  await hydrateAll(supabase, docs, ENCRYPTED_DOC_FIELDS)

  const full = req.query.full === '1' || req.query.full === 'true'
  const wantUrls = full || req.query.urls === '1' || req.query.urls === 'true'

  const keys = wantUrls ? docs.map((d: any) => d.s3_path).filter(Boolean) : []

  // Batch-generate presigned URLs for all docs in one boto3 call.
  // Skipped unless asked for: the URLs were 60% of the response body and the
  // web app never used them (it calls GET /:id/download on demand), so this
  // also removes a boto3 subprocess from every list request.
  let urlMap: Record<string, string> = {}
  if (keys.length) {
    try {
      urlMap = await s3PresignGetMany(keys, 3600)
    } catch (e: any) {
      console.error('list_documents presign batch failed:', e.message)
    }
  }

  const documents = docs.map((d: any) => {
    const base = {
      ...d,
      ...(wantUrls ? { download_url: d.s3_path ? urlMap[d.s3_path] || null : null } : {}),
    }
    if (full) return base

    // Replace the Textract blob with the three counts the UI actually renders,
    // and drop the ciphertext columns — they're never read client-side.
    const t = d.textract_data
    const { _textract_data, _textract_data_enc, _meta_enc, ...rest } = base
    return {
      ...rest,
      textract_summary: t
        ? {
            num_pages: t.num_pages ?? null,
            kv_count: t.kvs?.length ?? 0,
            table_count: t.tables?.length ?? 0,
          }
        : null,
    }
  })

  res.json({ documents })
})

// Get single document
router.get('/:id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data, error } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId!).single()
  if (error || !data) return res.status(404).json({ error: 'Not found' })
  await hydrate(supabase, data, ENCRYPTED_DOC_FIELDS)
  res.json({ document: data })
})

// Delete document
router.delete('/:id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  // Reporting success for a document that was never there is a small lie with
  // a real cost: the caller (or Claude, on the user's behalf) concludes the
  // file is gone when the id was simply wrong, and stops looking for it.
  const { data: removed, error } = await supabase.from('document')
    .delete().eq('id', req.params.id).eq('user_id', userId!).select('id')
  if (error) return sendDbError(res, error)
  if (!removed?.length) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true, deleted: removed[0].id })
})

// Run Textract
router.post('/:id/extract', async (req, res) => {
  const userId = await getUser(req)

  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: doc } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId!).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })
  await hydrate(supabase, doc, ENCRYPTED_DOC_FIELDS)

  // Idempotency: if we already have textract_data for this doc and the
  // caller didn't explicitly ask for a refresh, return the cached result
  // instead of paying for another AWS call. Prior returns are 30-50 pages
  // @ ~$0.065/page = $2-3 each — easy to drop $50+ on accidental re-runs.
  // Force a refresh with ?force=true.
  const force = req.query.force === 'true' || req.body?.force === true
  if (!force && doc.textract_data?.kvs?.length && doc.extracted_at) {
    return res.json({
      document_id: req.params.id,
      extraction: doc.textract_data,
      cached: true,
      extracted_at: doc.extracted_at,
      note: 'Returning cached extraction. Pass ?force=true to re-run Textract (charged per page).',
    })
  }

  // Same TABLES gating as /ingest — only prior returns benefit; everything
  // else uses FORMS-only. /extract is also called manually for re-runs of
  // misclassified docs, so honor the doc_type that's now on the row.
  const needsTables = ['prior_return_1040', 'prior_return_1120', 'prior_return_1120s', 'prior_return_1065']
    .includes(doc.doc_type || '')

  // Same shape as /ingest: mark the row in flight, answer 202, finish in the
  // background. Textract on a 30-50 page prior return runs for minutes, and
  // holding an HTTP request open for that is what forced the whole API onto a
  // multi-minute request budget. Pass ?wait=1 for the old blocking behaviour.
  const wait = req.query?.wait === '1' || req.query?.wait === 'true'

  await supabase.from('document').update({
    processing_status: 'processing',
    processing_started_at: new Date().toISOString(),
    processing_error: null,
  }).eq('id', req.params.id)

  const args = { docId: req.params.id, userId, s3_path: doc.s3_path, needsTables }

  if (!wait) {
    res.status(202).json({
      document_id: req.params.id,
      processing: true,
      note: 'Extraction is running; poll this document until processing_status is done.',
    })
    dispatchExtraction({ kind: 'extract', ...args }, () => reextractDocument(args))
      .catch(e => console.error(`[extract] background work failed for ${req.params.id}:`, e?.message))
    return
  }

  // Same as /ingest: ?wait=1 wants the extraction in the response body.
  try {
    res.json(await reextractDocument(args))
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
