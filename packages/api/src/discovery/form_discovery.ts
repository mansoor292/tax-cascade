/**
 * Form Discovery Orchestrator
 *
 * Auto-discovers and verifies IRS form field maps.
 * Handles both new form types and existing forms for unsupported years.
 *
 * Pipeline: download → detect fillable → label → textract → verify → save
 */

import { PDFDocument, PDFTextField } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { s3PutObject, s3GetObject, s3Bucket } from '../lib/s3.js'
import { analyzeToBlocks, parseKeyValuePairs } from '../lib/textract.js'
import { serviceClient } from '../lib/supabase.js'

const FORMS_DIR = 'data/irs_forms'
const MAPS_DIR = 'data/field_maps'

interface FieldEntry { page: number; field_id: string; label: string; acro_name?: string }
interface DiscoveryResult {
  status: string; form_name: string; tax_year: number
  field_count?: number; map_count?: number
  verify_matches?: number; verify_mismatches?: number
  error?: string; warning?: string
}

async function updateStatus(formName: string, year: number, status: string, extra: Record<string, any> = {}) {
  await serviceClient().from('form_discovery').upsert({
    form_name: formName, tax_year: year, status, updated_at: new Date().toISOString(), ...extra
  }, { onConflict: 'form_name,tax_year' })
}

// Step 1: Resolve IRS download URL
export function resolveIrsUrl(formName: string, year: number, currentYear = 2025): string {
  // IRS naming: f1040 → f1040, f1040s1 → f1040s1, f1120s → f1120s
  if (year >= currentYear) {
    return `https://www.irs.gov/pub/irs-pdf/${formName}.pdf`
  }
  return `https://www.irs.gov/pub/irs-prior/${formName}--${year}.pdf`
}

// Step 2: Download blank PDF (from IRS)
async function downloadBlankPdf(formName: string, year: number): Promise<string> {
  const url = resolveIrsUrl(formName, year)
  const localPath = `${FORMS_DIR}/${formName}_${year}.pdf`
  mkdirSync(FORMS_DIR, { recursive: true })

  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to download ${url}: HTTP ${resp.status}`)
  const pdfBytes = Buffer.from(await resp.arrayBuffer())
  writeFileSync(localPath, pdfBytes)

  // Also upload to S3
  const s3Key = `blank-forms/${formName}_${year}.pdf`
  await s3PutObject(s3Key, pdfBytes, 'application/pdf')

  return localPath
}

// Alternate step 2: caller supplies the PDF directly (state forms, private forms, etc.)
// Writes to the same local path the rest of the pipeline expects.
export async function ingestProvidedPdf(
  formName: string,
  year: number,
  source: { base64?: string; s3_key?: string },
): Promise<string> {
  const localPath = `${FORMS_DIR}/${formName}_${year}.pdf`
  mkdirSync(FORMS_DIR, { recursive: true })

  if (source.base64) {
    writeFileSync(localPath, Buffer.from(source.base64, 'base64'))
  } else if (source.s3_key) {
    writeFileSync(localPath, await s3GetObject(source.s3_key))
  } else {
    throw new Error('ingestProvidedPdf: base64 or s3_key required')
  }

  // Mirror to S3 for downstream Textract (same convention as IRS path)
  const s3Key = `blank-forms/${formName}_${year}.pdf`
  await s3PutObject(s3Key, readFileSync(localPath), 'application/pdf')

  return localPath
}

// Step 3: Detect if PDF has fillable fields
async function detectFillable(localPath: string): Promise<{ fillable: boolean; fieldCount: number }> {
  const pdf = await PDFDocument.load(readFileSync(localPath))
  const form = pdf.getForm()
  const textFields = form.getFields().filter(f => f instanceof PDFTextField)
  return { fillable: textFields.length > 0, fieldCount: textFields.length }
}

// Step 4: Label fields with their IDs.
// Returns acroMap so downstream steps (verify, fill) can find each field by its
// real AcroForm name instead of guessing from the short id.
async function labelFields(formName: string, year: number): Promise<{ count: number; fields: string[]; path: string; acroMap: Record<string, string> }> {
  const blankPath = `${FORMS_DIR}/${formName}_${year}.pdf`
  const pdf = await PDFDocument.load(readFileSync(blankPath))
  const form = pdf.getForm()
  const fields: string[] = []
  const acroMap: Record<string, string> = {}

  for (const f of form.getFields()) {
    if (f instanceof PDFTextField) {
      const name = f.getName()
      // IRS naming: .f1_47[0] → f1_47
      let short = name.match(/\.(f\d+_\d+)\[/)?.[1] || ''
      if (!short) {
        // Fallback for state / non-IRS forms. Handles nested AcroForm names
        // ("topmostSubform[0].Page1[0].p1-t1[0]") and flat ones ("TP_first_name").
        // Prefix with "f_" so the result keeps the "starts-with-f + contains-_"
        // shape that textractMap filters on. Index suffix guarantees uniqueness.
        const nestedLast = name.match(/\.([\w-]+)\[\d*\]$/)?.[1]
        const raw = nestedLast || name
        const sanitized = raw.replace(/[^\w]/g, '_').slice(0, 32)
        short = `f_${sanitized}_${fields.length}`
      }
      if (short) {
        try {
          const ml = f.getMaxLength()
          if (ml !== undefined) f.setMaxLength(50)
          f.setText(short)
          fields.push(short)
          acroMap[short] = name
        } catch {}
      }
    }
  }

  mkdirSync('output/discovery', { recursive: true })
  const labeledPath = `output/discovery/${formName}_${year}_LABELS.pdf`
  writeFileSync(labeledPath, await pdf.save())

  return { count: fields.length, fields, path: labeledPath, acroMap }
}

// Step 5: Textract the labeled PDF to build field map
async function textractMap(formName: string, year: number, labeledPath: string): Promise<FieldEntry[]> {
  const s3Key = `discovery/labels/${formName}_${year}_LABELS.pdf`
  await s3PutObject(s3Key, readFileSync(labeledPath), 'application/pdf')

  const kvs = parseKeyValuePairs(await analyzeToBlocks(s3Key, { maxWaitMs: 180_000 }))

  // The labeling step stamps each field's own id into the field, so one side
  // of every pair is that id ("f1_07[0]" — leading 'f', contains '_') and the
  // other is the printed label. Whichever side looks like an id is the id.
  const isFieldId = (t: string) => t.startsWith('f') && t.includes('_')
  const results: FieldEntry[] = []
  for (const kv of kvs) {
    if (isFieldId(kv.value)) results.push({ page: kv.page, field_id: kv.value, label: kv.key })
    else if (isFieldId(kv.key)) results.push({ page: kv.page, field_id: kv.key, label: kv.value })
  }
  // Codepoint order on field_id, matching the Python tuple sort this replaces
  // (localeCompare would reorder underscores and case differently).
  results.sort((a, b) =>
    a.page - b.page || (a.field_id < b.field_id ? -1 : a.field_id > b.field_id ? 1 : 0))
  return results
}

// Step 6: Verify by filling test values and re-extracting
async function verifyFieldMap(formName: string, year: number, fieldMap: FieldEntry[]): Promise<{ matches: number; mismatches: number }> {
  // Pick up to 5 fields to test
  const testFields = fieldMap.filter(f => f.label && f.label.length > 5).slice(0, 5)
  if (testFields.length === 0) return { matches: 0, mismatches: 0 }

  // Fill with test values
  const blankPath = `${FORMS_DIR}/${formName}_${year}.pdf`
  const pdf = await PDFDocument.load(readFileSync(blankPath))
  const form = pdf.getForm()

  const testValues: Record<string, string> = {}
  for (const tf of testFields) {
    const testVal = `TEST_${tf.field_id}`
    // Prefer the real AcroForm name when we captured it at labeling time.
    // Fall back to the IRS-style "includes field_id + '['" match for legacy
    // maps that predate acro_name.
    let target: PDFTextField | undefined
    if (tf.acro_name) {
      try {
        const f = form.getField(tf.acro_name)
        if (f instanceof PDFTextField) target = f
      } catch {}
    }
    if (!target) {
      for (const f of form.getFields()) {
        if (f instanceof PDFTextField && f.getName().includes(tf.field_id + '[')) {
          target = f
          break
        }
      }
    }
    if (target) {
      try {
        const ml = target.getMaxLength()
        if (ml !== undefined) target.setMaxLength(50)
        target.setText(testVal)
        testValues[tf.label.substring(0, 40)] = testVal
      } catch {}
    }
  }

  const filledPath = `output/discovery/${formName}_${year}_VERIFY.pdf`
  writeFileSync(filledPath, await pdf.save())

  // Textract the filled PDF and look for the test values back out of it.
  const s3Key = `discovery/verify/${formName}_${year}_VERIFY.pdf`
  await s3PutObject(s3Key, readFileSync(filledPath), 'application/pdf')
  const kvs = parseKeyValuePairs(await analyzeToBlocks(s3Key, { maxWaitMs: 120_000 }))


  // Compare
  let matches = 0, mismatches = 0
  for (const [label, expected] of Object.entries(testValues)) {
    const found = kvs.find((kv: any) => kv.key.includes(label) && kv.value.includes(expected))
    if (found) matches++
    else mismatches++
  }

  return { matches, mismatches }
}

// Step 7: Save field map to JSON + Supabase
async function saveFieldMap(formName: string, year: number, fieldMap: FieldEntry[]) {
  // JSON file
  mkdirSync(MAPS_DIR, { recursive: true })
  const jsonPath = `${MAPS_DIR}/${formName}_${year}_fields.json`
  writeFileSync(jsonPath, JSON.stringify(fieldMap, null, 2))

  // Supabase field_map table
  for (const entry of fieldMap) {
    await serviceClient().from('field_map').upsert({
      form_name: formName, tax_year: year,
      page: entry.page, field_id: entry.field_id, label: entry.label,
      acro_name: entry.acro_name ?? null,
      verified: true,
    }, { onConflict: 'form_name,tax_year,field_id' })
  }
}

// ─── Main orchestrator ───

export async function discoverForm(
  formName: string,
  year: number,
  opts: { base64?: string; s3_key?: string; force?: boolean } = {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { status: 'pending', form_name: formName, tax_year: year }
  const userProvided = !!(opts.base64 || opts.s3_key)

  // Idempotency guard: discovery is expensive (40-100 page IRS form PDF
  // through Textract FORMS at ~$0.05/page = $2-5 each). The auto-trigger
  // in routes/documents.ts already checks hasFieldMap() before calling
  // here, but defending in depth costs a single import — and protects
  // against ad-hoc / dev re-runs that would otherwise silently rebuild
  // a working map.
  if (!opts.force && !userProvided) {
    try {
      const { hasFieldMap } = await import('../maps/field_maps.js')
      if (hasFieldMap(formName, year)) {
        return {
          status: 'success',
          form_name: formName,
          tax_year: year,
          map_count: 0,
          error: undefined,
          // Surface that we skipped intentionally — calling code can log it.
          skipped_reason: 'pdf_field_map already exists; pass {force:true} to rebuild',
        } as any
      }
    } catch { /* if import fails, fall through and run discovery */ }
  }

  try {
    // Create/update discovery record
    const sourceUrl = userProvided
      ? (opts.s3_key ? `s3://${s3Bucket()}/${opts.s3_key}` : 'user-provided:base64')
      : resolveIrsUrl(formName, year)
    await updateStatus(formName, year, 'pending', { source_url: sourceUrl })

    // Step 1: Obtain PDF — either from the caller or from IRS
    await updateStatus(formName, year, 'downloading')
    const localPath = userProvided
      ? await ingestProvidedPdf(formName, year, opts)
      : await downloadBlankPdf(formName, year)
    await updateStatus(formName, year, 'downloading', { pdf_s3_key: `blank-forms/${formName}_${year}.pdf` })

    // Step 2: Check fillable
    const { fillable, fieldCount } = await detectFillable(localPath)
    if (!fillable) {
      await updateStatus(formName, year, 'failed', { is_fillable: false, error_message: 'PDF has no fillable fields (scanned only)', field_count: 0 })
      return { ...result, status: 'failed', error: 'Non-fillable PDF (scanned only)' }
    }
    await updateStatus(formName, year, 'labeling', { is_fillable: true, field_count: fieldCount })
    result.field_count = fieldCount

    // Step 3: Label
    const { path: labeledPath, acroMap } = await labelFields(formName, year)
    await updateStatus(formName, year, 'labeling', { labeled_s3_key: `discovery/labels/${formName}_${year}_LABELS.pdf` })

    // Step 4: Textract map
    await updateStatus(formName, year, 'mapping')
    const rawMap = await textractMap(formName, year, labeledPath)
    // Attach the real AcroForm name to each entry — verify + fill use it for direct lookup.
    const fieldMap: FieldEntry[] = rawMap.map(e => ({ ...e, acro_name: acroMap[e.field_id] }))
    result.map_count = fieldMap.length
    await updateStatus(formName, year, 'mapping', { map_count: fieldMap.length })

    if (fieldMap.length === 0) {
      await updateStatus(formName, year, 'failed', { error_message: 'Textract found no form fields' })
      return { ...result, status: 'failed', error: 'Textract found no form fields' }
    }

    // Step 5: Verify
    await updateStatus(formName, year, 'verifying')
    const { matches, mismatches } = await verifyFieldMap(formName, year, fieldMap)
    result.verify_matches = matches
    result.verify_mismatches = mismatches
    await updateStatus(formName, year, 'verifying', { verify_matches: matches, verify_mismatches: mismatches })

    // Step 6: Save
    await saveFieldMap(formName, year, fieldMap)

    // Step 7: Register in FORM_INVENTORY
    const { registerDiscoveredForm } = await import('../maps/field_maps.js')
    registerDiscoveredForm(formName, year)

    // Check if tax tables exist for compute
    const { TAX_TABLES } = await import('../engine/tax_tables.js')
    if (!TAX_TABLES[year]) {
      result.warning = `No tax tables for year ${year} — PDF fill works but compute unavailable`
    }

    await updateStatus(formName, year, 'active')
    result.status = 'active'
    return result

  } catch (e: any) {
    await updateStatus(formName, year, 'failed', { error_message: e.message })
    return { ...result, status: 'failed', error: e.message }
  }
}

export async function getDiscoveryStatus(formName: string, year: number) {
  const { data } = await serviceClient().from('form_discovery')
    .select('*').eq('form_name', formName).eq('tax_year', year).single()
  return data
}
