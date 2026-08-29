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
import { GoogleGenerativeAI } from '@google/generative-ai'
import { v4 as uuidv4 } from 'uuid'
import { s3PresignPut, s3PresignGet, s3PresignGetMany, s3PutObject, s3GetObject } from '../lib/s3.js'
import { analyzeDocument } from '../lib/textract.js'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_DOC_FIELDS, ENCRYPTED_RETURN_FIELDS, DOC_ENC_COLS } from '../lib/row_crypto.js'
import { sendError, sendDbError } from '../lib/http_error.js'
import { serviceClient, requestUserId as getUser } from '../lib/supabase.js'


const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

const supabase = serviceClient()

const router = Router()

// Shared archive orchestrator — runs the mapper + archiveFiledReturn against
// a document's stored textract_data and inserts a filed_import tax_return row.
// Used on first ingest and by the /:id/rearchive endpoint (after mapper fixes).
async function archiveDocumentAsReturn(
  doc: any,
  classification: any,
  userId: string,
  entityIdHint: string | null,
  textractData: any,
): Promise<any> {
  try {
    const { mapToCanonical } = await import('../intake/json_model_mapper.js')
    const { archiveFiledReturn } = await import('../intake/archive_filed_return.js')

    const formTypeMap: Record<string, string> = {
      prior_return_1040: '1040', prior_return_1120: '1120', prior_return_1120s: '1120S',
      prior_return_1065: '1065',
    }
    // No silent default. Archiving an unrecognised return as an 1120 would
    // file a partnership's figures onto a C-corporation form — wrong in a way
    // nobody would notice until it mattered.
    const formType = formTypeMap[classification.doc_type]
    if (!formType) {
      console.warn(`[archive] no return mapping for doc_type ${classification.doc_type} — stored, not archived`)
      return null
    }
    const txYear = classification.tax_year || doc.tax_year

    const mapped = mapToCanonical({
      source: 'textract', form_type: formType === '1120S' ? '1120S' : formType,
      tax_year: txYear,
      key_value_pairs: textractData.kvs,
      tables: textractData.tables,  // enables Schedule L table-based extraction
    })

    let entityId = entityIdHint || doc.entity_id || null
    if (!entityId && classification.entity_name) {
      const firstName = classification.entity_name.split(' ')[0]
      const { data: existing } = await supabase.from('tax_entity')
        .select('id').eq('user_id', userId).ilike('name', `%${firstName}%`).single()
      entityId = existing?.id || null
    }
    if (!entityId || !txYear) return null

    const archive = archiveFiledReturn(mapped, formType, classification.entity_name || null)

    // Gemini gap-fill: whatever canonical keys the regex/table mapper didn't
    // produce, send the raw KVs to Gemini and ask it to fill the remaining
    // expected lines. Cheap text-only call; does not re-parse the PDF.
    let gapFillReport: any = null
    try {
      const { gapFillWithGemini } = await import('../intake/gemini_gap_fill.js')
      const result = await gapFillWithGemini({
        textractKvs: textractData.kvs || [],
        formType,
        taxYear: txYear,
        currentFieldValues: archive.field_values,
      })
      for (const [k, v] of Object.entries(result.filled)) {
        // Don't overwrite anything the mapper already produced — gap-fill only.
        const existing = archive.field_values[k]
        if (existing === undefined || existing === null || existing === '') {
          archive.field_values[k] = v
        }
      }
      gapFillReport = {
        gaps_total:  result.gaps_total,
        gaps_filled: result.gaps_filled,
        model:       result.model,
        error:       result.error,
      }
    } catch (e: any) {
      gapFillReport = { error: e.message }
    }

    const archiveRaw = {
      input_data: {
        source_document_id: doc.id,
        mapper_model: mapped.model,
        mapper_unmapped: mapped.unmapped,
      },
      computed_data: { computed: archive.totals, field_values: archive.field_values },
      field_values: archive.field_values,
      verification: {
        mapper_stats: mapped.stats,
        extracted_count: mapped.fields.length,
        unmapped_count: mapped.unmapped.length,
        gemini_gap_fill: gapFillReport,
        source: 'filed_import',
      },
    }
    const archiveEnc = await encryptedFields(supabase, userId, archiveRaw, ENCRYPTED_RETURN_FIELDS)
    const archiveAggs = {
      agg_total_income:   archive.totals.total_income   ?? null,
      agg_taxable_income: archive.totals.taxable_income ?? null,
      agg_total_tax:      archive.totals.total_tax      ?? null,
      agg_agi:            (archive.totals as any).agi   ?? null,
    }
    const { data: taxReturn } = await supabase.from('tax_return').insert({
      entity_id: entityId,
      tax_year: txYear,
      form_type: formType,
      status: 'filed',
      source: 'filed_import',
      is_amended: false,
      ...archiveRaw,
      ...archiveEnc,
      ...archiveAggs,
      computed_at: new Date().toISOString(),
    }).select().single()

    return {
      id: taxReturn?.id,
      form_type: formType, tax_year: txYear,
      source: 'filed_import',
      totals: archive.totals,
      mapped_fields: mapped.fields.length,
      unmapped_count: mapped.unmapped.length,
    }
  } catch (e: any) {
    console.error('Auto-archive failed:', e.message)
    return null
  }
}

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

  const work = extractAndArchive({
    docId: doc0.id, userId, s3_key, filename, file_size, ext,
    entity_id: entity_id || null, content_hash, _deduped_textract,
  })

  if (!wait) {
    // Answer now. The browser shows the document as processing and polls.
    res.status(202).json({
      document: { ...doc0, processing_status: 'processing' },
      processing: true,
      note: 'Upload stored. Classification and extraction are running; the document will update shortly.',
    })
    work.catch(e => console.error(`[register] background work failed for ${doc0.id}:`, e?.message))
    return
  }

  const result = await work
  return res.json(result)
}

/** Everything that used to happen inline. Updates the row it is given. */
async function extractAndArchive(args: {
  docId: string; userId: string; s3_key: string; filename: string
  file_size?: number; ext: string; entity_id: string | null
  content_hash?: string; _deduped_textract?: any
}): Promise<any> {
  const { docId, userId, s3_key, filename, file_size, ext, entity_id, content_hash, _deduped_textract } = args
  try {

  // Categorize with Gemini
  let classification: any = { doc_type: 'other' }

  if (GEMINI_KEY && ['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    try {
      // Download from S3 for Gemini
      const base64 = (await s3GetObject(s3_key)).toString('base64')

      const genAI = new GoogleGenerativeAI(GEMINI_KEY)
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })
      const mimeType = ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`

      const result = await model.generateContent([
        { inlineData: { data: base64, mimeType } },
        { text: `Analyze this tax document. Respond ONLY with valid JSON (no markdown):
{
  "doc_type": one of
    "w2" | "1099_int" | "1099_div" | "1099_b" | "1099_r" | "1099_misc" | "1099_nec" | "1099_k" | "1099_g" | "1099_sa" | "1099_oid" | "1099"
    | "k1" | "prior_return_1040" | "prior_return_1120" | "prior_return_1120s" | "prior_return_1065"
    | "bank_statement" | "invoice" | "receipt" | "tax_transcript" | "other",
  "tax_year": integer or null,
  "entity_name": string or "",
  "ein_or_ssn": string or "",
  "summary": one-line description,
  "key_values": {
    // Use specific field names — e.g. for W-2: box_1, box_2, box_3, box_4, box_5, box_6
    //   1099-INT: interest (box 1), early_withdrawal_penalty, us_bonds_interest (box 3), federal_tax_withheld (box 4)
    //   1099-DIV: ordinary_dividends (box 1a), qualified_dividends (box 1b), capital_gain_dist (box 2a)
    //   1099-R: gross_distribution (box 1), taxable_amount (box 2a), federal_tax_withheld (box 4), distribution_code (box 7)
    //   1099-MISC: rents (box 1), royalties (box 2), other_income (box 3), fishing (box 5)
    //   1099-NEC: nonemployee_comp (box 1), federal_tax_withheld (box 4)
    //   1099-K: gross_amount (box 1a)
    //   K-1: ordinary_income (box 1), w2_wages, rental_income (box 2)
    // Up to ~15 key financial values. Strip $ and commas from numeric values.
  }
}

Use the specific 1099 variant (1099_int, 1099_div, etc.) when identifiable.
Fall back to "1099" only if the variant is unclear.` }
      ])

      const text = result.response.text().trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
      classification = JSON.parse(text)
    } catch (e: any) {
      console.error('Gemini classification failed:', e.message)
    }
  }

  // Run Textract (for PDFs/images). Three short-circuit paths first:
  //   1. Dedupe — if /ingest matched the file's SHA-256 against a prior
  //      document, skip the AWS call and reuse the cached extraction.
  //   2. TABLES costs an extra ~$0.015/page on top of FORMS. Only request
  //      it for prior returns where Schedule L (1120/1120S balance sheet)
  //      actually needs table extraction. 1099s/W-2s/K-1s/receipts use
  //      FORMS only — saves ~25% of the per-page Textract bill.
  let textractData: any = _deduped_textract || null
  if (textractData) {
    console.log(`[ingest] reused cached textract_data via content_hash for ${filename}`)
  }
  if (!textractData && ['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    const needsTables = ['prior_return_1040', 'prior_return_1120', 'prior_return_1120s', 'prior_return_1065']
      .includes(classification.doc_type || '')
    try {
      textractData = await analyzeDocument(s3_key, { tables: needsTables, maxWaitMs: 180000 })
    } catch (e: any) {
      console.error('Textract failed:', e.message)
    }
  }

  // Save to DB (dual-write plaintext + _enc for meta + textract_data).
  // Stash content_hash on meta so future uploads of the same file can
  // dedupe against this row's textract_data without paying for AWS again.
  const metaPayload: Record<string, any> = {
    size: file_size,
    entity_name: classification.entity_name || '',
    ein_or_ssn: classification.ein_or_ssn || '',
    summary: classification.summary || '',
    key_values: classification.key_values || {},
  }
  if (content_hash) metaPayload.content_hash = content_hash
  const docEnc = await encryptedFields(supabase, userId,
    { meta: metaPayload, textract_data: textractData }, ENCRYPTED_DOC_FIELDS)
  // UPDATE, not insert — the row was created before the response went out.
  const { data: doc, error } = await supabase.from('document').update({
    entity_id: entity_id || null,
    doc_type: classification.doc_type || 'other',
    tax_year: classification.tax_year || null,
    textract_data: textractData,
    extracted_at: textractData ? new Date().toISOString() : null,
    meta: metaPayload,
    processing_status: 'done',
    processing_error: null,
    ...docEnc,
  }).eq('id', docId).select().single()

  if (error) throw new Error(error.message)
  await hydrate(supabase, doc, ENCRYPTED_DOC_FIELDS)

  // Auto-archive if it's a recognized prior-year return. Inserts a filed_import
  // tax_return row with every extracted canonical field in field_values, verbatim.
  const isReturn = ['prior_return_1040', 'prior_return_1120', 'prior_return_1120s', 'prior_return_1065'].includes(classification.doc_type || '')
  const processedReturn = isReturn && textractData?.kvs?.length && doc
    ? await archiveDocumentAsReturn(doc, classification, userId, entity_id || null, textractData)
    : null

  // Auto-trigger discovery if form/year has no field map
  let discoveryStarted = false
  if (isReturn && classification.tax_year) {
    try {
      const { hasFieldMap } = await import('../maps/field_maps.js')
      const formNameMap: Record<string, string> = {
        prior_return_1040: 'f1040', prior_return_1120: 'f1120', prior_return_1120s: 'f1120s',
      }
      const irsFormName = formNameMap[classification.doc_type]
      if (irsFormName && !hasFieldMap(irsFormName, classification.tax_year)) {
        const { discoverForm } = await import('../discovery/form_discovery.js')
        discoveryStarted = true
        // Run in background — don't await
        discoverForm(irsFormName, classification.tax_year).then(result => {
          console.log(`Auto-discovery ${irsFormName}/${classification.tax_year}: ${result.status}`)
        }).catch(err => {
          console.error(`Auto-discovery ${irsFormName}/${classification.tax_year} error:`, err.message)
        })
      }
    } catch (e: any) {
      console.error('Discovery check failed:', e.message)
    }
  }

  return {
    document: doc, classification,
    textract: textractData ? { num_pages: textractData.num_pages, num_fields: textractData.kvs?.length } : null,
    processed_return: processedReturn,
    discovery_started: discoveryStarted,
  }
  } catch (e: any) {
    // Record the failure on the row rather than losing it: the file is stored
    // and attributed, so the person can see it and retry extraction.
    console.error(`[register] extraction failed for ${docId}:`, e?.message)
    await supabase.from('document').update({
      processing_status: 'failed',
      processing_error: String(e?.message || e).slice(0, 500),
    }).eq('id', docId)
    throw e
  }
}

// Expose the register handler as a route
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
  if (!['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    return res.status(400).json({ error: 'Only PDF and image files can be categorized' })
  }

  try {
    const base64 = (await s3GetObject(doc.s3_path)).toString('base64')

    const genAI = new GoogleGenerativeAI(GEMINI_KEY)
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })
    const mimeType = ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      { text: `Analyze this tax document. Respond ONLY with valid JSON (no markdown):
{
  "doc_type": one of "w2" | "1099" | "k1" | "prior_return_1040" | "prior_return_1120" | "prior_return_1120s" | "bank_statement" | "invoice" | "receipt" | "tax_transcript" | "other",
  "tax_year": integer or null,
  "entity_name": string or "",
  "ein_or_ssn": string or "",
  "summary": one-line description,
  "key_values": { up to 10 key financial values }
}` }
    ])

    const text = result.response.text().trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
    const classification = JSON.parse(text)

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

  try {
    const textractData = await analyzeDocument(doc.s3_path, { tables: needsTables, maxWaitMs: 120000 })

    const extractEnc = await encryptedFields(supabase, userId,
      { textract_data: textractData }, ENCRYPTED_DOC_FIELDS)
    await supabase.from('document').update({
      textract_data: textractData,
      ...extractEnc,
      extracted_at: new Date().toISOString(),
    }).eq('id', req.params.id)

    res.json({ document_id: req.params.id, extraction: textractData })
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
