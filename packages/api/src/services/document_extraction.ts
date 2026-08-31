/**
 * Document extraction — the work that happens after a file lands in S3.
 *
 * Lifted out of routes/documents.ts unchanged. It used to be a private
 * function in the route module, which was fine while the only caller was an
 * Express handler; it is now also the body of the extraction worker, and a
 * Lambda should not have to import an Express router to reach it. Same reason
 * services/compute_return.ts exists — routes stay thin, the engine room is
 * callable.
 *
 * Nothing here touches req/res. Every entry point takes plain arguments and
 * updates the document row it is given, so the caller can be an HTTP handler,
 * a queue consumer, or a test.
 */
import { GoogleGenerativeAI } from '@google/generative-ai'
import { s3GetObject } from '../lib/s3.js'
import { analyzeDocument } from '../lib/textract.js'
import { encryptedFields, hydrate, ENCRYPTED_DOC_FIELDS, ENCRYPTED_RETURN_FIELDS } from '../lib/row_crypto.js'
import { lazyServiceClient } from '../lib/supabase.js'

const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
const supabase = lazyServiceClient()

export async function archiveDocumentAsReturn(
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


/**
 * THE document-classification prompt and call — one copy.
 *
 * It used to exist twice: here (ingest) and inline in POST /:id/categorize.
 * The copies drifted: when 1065 support landed, only this one gained
 * prior_return_1065 (and the specific 1099 variants), so re-categorizing an
 * already-uploaded 1065 kept answering "other" — found when a partnership
 * return uploaded the day BEFORE 1065 support could not be re-read into a
 * 1065 afterwards. The route now calls this function.
 */
export const CLASSIFIABLE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg']

export const CLASSIFICATION_PROMPT = `Analyze this tax document. Respond ONLY with valid JSON (no markdown):
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
Fall back to "1099" only if the variant is unclear.`

export async function classifyTaxDocument(base64: string, ext: string): Promise<any> {
  const genAI = new GoogleGenerativeAI(GEMINI_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })
  const mimeType = ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    { text: CLASSIFICATION_PROMPT },
  ])
  const text = result.response.text().trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
  return JSON.parse(text)
}

/** Everything that used to happen inline on ingest. Updates the row it is given. */
export async function extractAndArchive(args: {
  docId: string; userId: string; s3_key: string; filename: string
  file_size?: number; ext: string; entity_id: string | null
  content_hash?: string; _deduped_textract?: any
}): Promise<any> {
  const { docId, userId, s3_key, filename, file_size, ext, entity_id, content_hash, _deduped_textract } = args
  try {

  // Categorize with Gemini
  let classification: any = { doc_type: 'other' }

  if (GEMINI_KEY && CLASSIFIABLE_EXTENSIONS.includes(ext)) {
    try {
      const base64 = (await s3GetObject(s3_key)).toString('base64')
      classification = await classifyTaxDocument(base64, ext)
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

/**
 * Re-run Textract for one document and store the result. Mirrors
 * extractAndArchive's status contract (processing -> done | failed) so a
 * caller can poll either route's work the same way.
 */
export async function reextractDocument(args: {
  docId: string; userId: string; s3_path: string; needsTables: boolean
}): Promise<any> {
  const { docId, userId, s3_path, needsTables } = args
  try {
    const textractData = await analyzeDocument(s3_path, { tables: needsTables, maxWaitMs: 120000 })

    const extractEnc = await encryptedFields(supabase, userId,
      { textract_data: textractData }, ENCRYPTED_DOC_FIELDS)
    await supabase.from('document').update({
      textract_data: textractData,
      ...extractEnc,
      extracted_at: new Date().toISOString(),
      processing_status: 'done',
      processing_error: null,
    }).eq('id', docId)

    return { document_id: docId, extraction: textractData }
  } catch (e: any) {
    await supabase.from('document').update({
      processing_status: 'failed',
      processing_error: String(e?.message || e).slice(0, 500),
    }).eq('id', docId)
    throw e
  }
}

