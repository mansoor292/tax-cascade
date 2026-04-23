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
import { createClient } from '@supabase/supabase-js'
import { hydrate } from '../lib/row_crypto.js'
import { encryptedFields } from '../lib/row_crypto.js'
import { gapFillWithGemini } from '../intake/gemini_gap_fill.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const ENCRYPTED_RETURN_FIELDS = { json: ['input_data', 'computed_data', 'field_values', 'verification'] }
const ENCRYPTED_DOC_FIELDS = { json: ['textract_data', 'meta'] }

async function getUser(req: Request): Promise<string | null> {
  if ((req as any).userId) return (req as any).userId
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token)
    return user?.id || null
  }
  return null
}

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
    const { data: ret } = await supabase.from('tax_return')
      .select('id, entity_id, tax_year, form_type, source, input_data, field_values')
      .eq('id', return_id).single()
    if (!ret) return res.status(404).json({ error: `return ${return_id} not found` })
    await hydrate(supabase, ret, ENCRYPTED_RETURN_FIELDS)

    // Verify user owns the entity
    const { data: ent } = await supabase.from('tax_entity')
      .select('id').eq('id', ret.entity_id).eq('user_id', userId).single()
    if (!ent) return res.status(403).json({ error: 'Forbidden' })

    const docId = (ret.input_data as any)?.source_document_id
    if (!docId) {
      return res.status(400).json({
        error: 'Return has no source_document_id in input_data — cannot locate Textract KVs. Pass textract_kvs directly.',
      })
    }

    const { data: doc } = await supabase.from('document')
      .select('id, textract_data').eq('id', docId).single()
    if (!doc) return res.status(404).json({ error: `source document ${docId} not found` })
    await hydrate(supabase, doc, ENCRYPTED_DOC_FIELDS)

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
      const enc = await encryptedFields(supabase, userId, updates, ENCRYPTED_RETURN_FIELDS)
      const { error } = await supabase.from('tax_return').update(enc).eq('id', return_id)
      if (error) return res.status(500).json({ error: error.message })
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
