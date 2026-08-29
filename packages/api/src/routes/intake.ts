/**
 * Intake routes — extraction helpers that run after Textract.
 *
 * Today:
 *   POST /api/intake/gap-fill — given a filed return whose canonical
 *     field_values were partially extracted by the regex/table mapper,
 *     identify the remaining expected lines and ask Gemini to fill them
 *     using the raw Textract KVs. Cheap, text-only, bounded output.
 *
 * This is the standalone-callable version of the gap-fill step that
 * already runs inline during ingest/rearchive — exposed here so the MCP
 * layer (and any other client) can re-run gap-fill on existing filed
 * returns without a full re-archive.
 */
import { Router, type Request } from 'express'
import { hydrate, ENCRYPTED_RETURN_FIELDS, ENCRYPTED_DOC_FIELDS, RETURN_ENC_COLS, DOC_ENC_COLS } from '../lib/row_crypto.js'
import { encryptedFields } from '../lib/row_crypto.js'
import { gapFillWithGemini } from '../intake/gemini_gap_fill.js'
import { serviceClient, requestUserId as getUser } from '../lib/supabase.js'
import { sendDbError } from '../lib/http_error.js'

const supabase = serviceClient()


const router = Router()

/**
 * POST /api/intake/gap-fill
 *
 * Two invocation modes:
 *
 * A. By return_id — automatic data lookup:
 *    { return_id: "...", persist?: boolean }
 *    Looks up the tax_return row, pulls its source document's textract_data.kvs,
 *    and runs gap-fill against the row's current field_values. If persist=true,
 *    merges filled values back into field_values and saves the row.
 *
 * B. Direct inputs — for ad-hoc scoring of arbitrary extractions:
 *    { form_type, tax_year, textract_kvs: [...], current_field_values: {...} }
 *    Runs gap-fill and returns the filled values without persisting anywhere.
 */
router.post('/gap-fill', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const {
    return_id,
    persist,
    form_type,
    tax_year,
    textract_kvs,
    current_field_values,
  } = req.body || {}

  // Mode A: by return_id
  if (return_id) {
    // verification and the *_enc siblings MUST be selected. hydrate() only acts
    // on a `*_enc` column it can see, so without them it silently no-ops and
    // this handler reads the stale plaintext copy. Worse, `verification` was
    // not selected at all, so the spread below started from undefined and
    // overwrote the column with a single key — losing source, mapper_stats,
    // unmapped_count and extracted_count on every gap-fill run.
    const { data: ret } = await supabase.from('tax_return')
      .select(`id, entity_id, tax_year, form_type, source, input_data, field_values, verification, ${RETURN_ENC_COLS}`)
      .eq('id', return_id).single()
    if (!ret) return res.status(404).json({ error: `return ${return_id} not found` })

    // Verify user owns the entity (before hydrate — the DEK is per-user, and
    // tax_return rows carry no user_id of their own, so hydrate needs the
    // userId passed explicitly or it silently no-ops).
    const { data: ent } = await supabase.from('tax_entity')
      .select('id').eq('id', ret.entity_id).eq('user_id', userId).single()
    if (!ent) return res.status(403).json({ error: 'Forbidden' })
    await hydrate(supabase, ret, { ...ENCRYPTED_RETURN_FIELDS, userId })

    const docId = (ret.input_data as any)?.source_document_id
    if (!docId) {
      return res.status(400).json({
        error: 'Return has no source_document_id in input_data — cannot locate Textract KVs. Pass textract_kvs directly.',
      })
    }

    const { data: doc } = await supabase.from('document')
      .select(`id, user_id, textract_data, meta, ${DOC_ENC_COLS}`).eq('id', docId).single()
    if (!doc) return res.status(404).json({ error: `source document ${docId} not found` })
    await hydrate(supabase, doc, { ...ENCRYPTED_DOC_FIELDS, userId })

    const kvs = (doc.textract_data as any)?.kvs || []
    if (!kvs.length) {
      return res.status(400).json({ error: 'Source document has no Textract KVs — run /documents/:id/extract first' })
    }

    const currentFv = (ret.field_values as any) || {}
    const result = await gapFillWithGemini({
      textractKvs:        kvs,
      formType:           ret.form_type,
      taxYear:            ret.tax_year,
      currentFieldValues: currentFv,
    })

    let persisted = false
    let merged: Record<string, any> = { ...currentFv }
    if (persist && Object.keys(result.filled).length > 0) {
      for (const [k, v] of Object.entries(result.filled)) {
        // Non-destructive: never overwrite a value that already exists.
        if (merged[k] === undefined || merged[k] === null || merged[k] === '') {
          merged[k] = v
        }
      }
      const updates: any = {
        field_values: merged,
        verification: {
          ...((ret as any).verification || {}),
          gemini_gap_fill_last_run: {
            at:           new Date().toISOString(),
            gaps_total:   result.gaps_total,
            gaps_filled:  result.gaps_filled,
            model:        result.model,
          },
        },
      }
      // Write BOTH copies. Writing only the ciphertext is what let the two
      // drift apart: this handler updated `_enc` while every read in
      // routes/returns.ts served the plaintext column.
      const enc = await encryptedFields(supabase, userId, updates, ENCRYPTED_RETURN_FIELDS)
      const { error } = await supabase.from('tax_return')
        .update({ ...updates, ...enc }).eq('id', return_id)
      if (error) return sendDbError(res, error)
      persisted = true
    }

    return res.json({
      return_id,
      form_type:   ret.form_type,
      tax_year:    ret.tax_year,
      gaps_total:  result.gaps_total,
      gaps_filled: result.gaps_filled,
      filled:      result.filled,
      model:       result.model,
      error:       result.error,
      persisted,
      preview_field_count: Object.keys(merged).length,
    })
  }

  // Mode B: direct inputs
  if (!form_type || !tax_year || !Array.isArray(textract_kvs)) {
    return res.status(400).json({
      error: 'Provide either {return_id} OR {form_type, tax_year, textract_kvs, current_field_values?}',
    })
  }
  const result = await gapFillWithGemini({
    textractKvs:        textract_kvs,
    formType:           form_type,
    taxYear:            tax_year,
    currentFieldValues: current_field_values || {},
  })
  return res.json({
    form_type, tax_year,
    gaps_total:  result.gaps_total,
    gaps_filled: result.gaps_filled,
    filled:      result.filled,
    model:       result.model,
    error:       result.error,
    persisted:   false,
  })
})

export default router
