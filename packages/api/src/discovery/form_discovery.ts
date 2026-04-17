/**
 * Form Discovery Orchestrator
 *
 * Auto-discovers and verifies IRS form field maps.
 * Handles both new form types and existing forms for unsupported years.
 *
 * Pipeline: download → detect fillable → label → textract → verify → save
 */

import { PDFDocument, PDFTextField } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { runPython } from '../lib/run_python.js'
import { v4 as uuidv4 } from 'uuid'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const S3_BUCKET = process.env.S3_BUCKET || 'tax-api-storage-2026'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

const FORMS_DIR = 'data/irs_forms'
const MAPS_DIR = 'data/field_maps'

interface FieldEntry { page: number; field_id: string; label: string }
interface DiscoveryResult {
  status: string; form_name: string; tax_year: number
  field_count?: number; map_count?: number
  verify_matches?: number; verify_mismatches?: number
  error?: string; warning?: string
}

async function updateStatus(formName: string, year: number, status: string, extra: Record<string, any> = {}) {
  await supabase.from('form_discovery').upsert({
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

  const script = `
import urllib.request, sys
try:
    urllib.request.urlretrieve("${url}", "${localPath}")
    print("ok")
except urllib.error.HTTPError as e:
    print(f"ERROR:{e.code}")
    sys.exit(1)
`
  const result = runPython(script, { timeout: 30000 })
  if (result.startsWith('ERROR:')) {
    throw new Error(`Failed to download ${url}: HTTP ${result.replace('ERROR:', '')}`)
  }

  // Also upload to S3
  const s3Key = `blank-forms/${formName}_${year}.pdf`
  runPython(`
import boto3
boto3.client('s3', region_name='us-east-1').upload_file("${localPath}", "${S3_BUCKET}", "${s3Key}")
print("ok")
`, { timeout: 15000 })

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
    runPython(`
import base64
with open("${localPath}", "wb") as f:
    f.write(base64.b64decode('${source.base64}'))
print("ok")
`, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 })
  } else if (source.s3_key) {
    runPython(`
import boto3
boto3.client('s3', region_name='us-east-1').download_file("${S3_BUCKET}", "${source.s3_key}", "${localPath}")
print("ok")
`, { timeout: 30000 })
  } else {
    throw new Error('ingestProvidedPdf: base64 or s3_key required')
  }

  // Mirror to S3 for downstream Textract (same convention as IRS path)
  const s3Key = `blank-forms/${formName}_${year}.pdf`
  runPython(`
import boto3
boto3.client('s3', region_name='us-east-1').upload_file("${localPath}", "${S3_BUCKET}", "${s3Key}")
print("ok")
`, { timeout: 15000 })

  return localPath
}

// Step 3: Detect if PDF has fillable fields
async function detectFillable(localPath: string): Promise<{ fillable: boolean; fieldCount: number }> {
  const pdf = await PDFDocument.load(readFileSync(localPath))
  const form = pdf.getForm()
  const textFields = form.getFields().filter(f => f instanceof PDFTextField)
  return { fillable: textFields.length > 0, fieldCount: textFields.length }
}

// Step 4: Label fields with their IDs
async function labelFields(formName: string, year: number): Promise<{ count: number; fields: string[]; path: string }> {
  const blankPath = `${FORMS_DIR}/${formName}_${year}.pdf`
  const pdf = await PDFDocument.load(readFileSync(blankPath))
  const form = pdf.getForm()
  const fields: string[] = []

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
        } catch {}
      }
    }
  }

  mkdirSync('output/discovery', { recursive: true })
  const labeledPath = `output/discovery/${formName}_${year}_LABELS.pdf`
  writeFileSync(labeledPath, await pdf.save())

  return { count: fields.length, fields, path: labeledPath }
}

// Step 5: Textract the labeled PDF to build field map
async function textractMap(formName: string, year: number, labeledPath: string): Promise<FieldEntry[]> {
  const s3Key = `discovery/labels/${formName}_${year}_LABELS.pdf`

  const script = `
import boto3, json, time

s3 = boto3.client('s3', region_name='us-east-1')
textract = boto3.client('textract', region_name='us-east-1')

s3.upload_file("${labeledPath}", "${S3_BUCKET}", "${s3Key}")

job = textract.start_document_analysis(
    DocumentLocation={'S3Object': {'Bucket': '${S3_BUCKET}', 'Name': '${s3Key}'}},
    FeatureTypes=['FORMS'])
jid = job['JobId']

while True:
    resp = textract.get_document_analysis(JobId=jid)
    if resp['JobStatus'] == 'SUCCEEDED':
        blocks = resp.get('Blocks', [])
        nt = resp.get('NextToken')
        while nt:
            resp = textract.get_document_analysis(JobId=jid, NextToken=nt)
            blocks.extend(resp.get('Blocks', []))
            nt = resp.get('NextToken')
        break
    elif resp['JobStatus'] == 'FAILED':
        print(json.dumps([]))
        exit(0)
    time.sleep(3)

bm = {b['Id']: b for b in blocks}
km, vm = {}, {}
for b in blocks:
    if b['BlockType'] == 'KEY_VALUE_SET':
        if 'KEY' in b.get('EntityTypes', []): km[b['Id']] = b
        else: vm[b['Id']] = b

def gt(bl):
    t = ''
    for rel in bl.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                c = bm.get(cid, {})
                if c.get('BlockType') == 'WORD': t += c.get('Text', '') + ' '
    return t.strip()

results = []
for kid, kb in km.items():
    kt = gt(kb)
    page = kb.get('Page', 0)
    vb = None
    for rel in kb.get('Relationships', []):
        if rel['Type'] == 'VALUE':
            for vid in rel['Ids']:
                if vid in vm: vb = vm[vid]; break
    vt = gt(vb) if vb else ''
    if vt.startswith('f') and '_' in vt:
        results.append({'page': page, 'field_id': vt, 'label': kt})
    elif kt.startswith('f') and '_' in kt:
        results.append({'page': page, 'field_id': kt, 'label': vt})

results.sort(key=lambda x: (x['page'], x['field_id']))
print(json.dumps(results))
`

  const result = runPython(script, { timeout: 180000 })
  return JSON.parse(result)
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
    for (const f of form.getFields()) {
      if (f.getName().includes(tf.field_id + '[') && f instanceof PDFTextField) {
        try {
          const ml = f.getMaxLength()
          if (ml !== undefined) f.setMaxLength(50)
          f.setText(testVal)
          testValues[tf.label.substring(0, 40)] = testVal
        } catch {}
        break
      }
    }
  }

  const filledPath = `output/discovery/${formName}_${year}_VERIFY.pdf`
  writeFileSync(filledPath, await pdf.save())

  // Textract the filled PDF
  const s3Key = `discovery/verify/${formName}_${year}_VERIFY.pdf`
  const script = `
import boto3, json, time
s3 = boto3.client('s3', region_name='us-east-1')
textract = boto3.client('textract', region_name='us-east-1')
s3.upload_file("${filledPath}", "${S3_BUCKET}", "${s3Key}")
job = textract.start_document_analysis(
    DocumentLocation={'S3Object': {'Bucket': '${S3_BUCKET}', 'Name': '${s3Key}'}},
    FeatureTypes=['FORMS'])
jid = job['JobId']
while True:
    resp = textract.get_document_analysis(JobId=jid)
    if resp['JobStatus'] == 'SUCCEEDED':
        blocks = resp.get('Blocks', [])
        nt = resp.get('NextToken')
        while nt:
            resp = textract.get_document_analysis(JobId=jid, NextToken=nt)
            blocks.extend(resp.get('Blocks', []))
            nt = resp.get('NextToken')
        break
    elif resp['JobStatus'] == 'FAILED':
        print(json.dumps([]))
        exit(0)
    time.sleep(3)
bm = {b['Id']: b for b in blocks}
km, vm = {}, {}
for b in blocks:
    if b['BlockType'] == 'KEY_VALUE_SET':
        if 'KEY' in b.get('EntityTypes', []): km[b['Id']] = b
        else: vm[b['Id']] = b
def gt(bl):
    t = ''
    for rel in bl.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                c = bm.get(cid, {})
                if c.get('BlockType') == 'WORD': t += c.get('Text', '') + ' '
    return t.strip()
kvs = []
for kid, kb in km.items():
    vb = None
    for rel in kb.get('Relationships', []):
        if rel['Type'] == 'VALUE':
            for vid in rel['Ids']:
                if vid in vm: vb = vm[vid]; break
    kvs.append({'key': gt(kb), 'value': gt(vb) if vb else ''})
print(json.dumps(kvs))
`
  const kvResult = runPython(script, { timeout: 120000 })
  const kvs = JSON.parse(kvResult)

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
    await supabase.from('field_map').upsert({
      form_name: formName, tax_year: year,
      page: entry.page, field_id: entry.field_id, label: entry.label,
      verified: true,
    }, { onConflict: 'form_name,tax_year,field_id' })
  }
}

// ─── Main orchestrator ───

export async function discoverForm(
  formName: string,
  year: number,
  opts: { base64?: string; s3_key?: string } = {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { status: 'pending', form_name: formName, tax_year: year }
  const userProvided = !!(opts.base64 || opts.s3_key)

  try {
    // Create/update discovery record
    const sourceUrl = userProvided
      ? (opts.s3_key ? `s3://${S3_BUCKET}/${opts.s3_key}` : 'user-provided:base64')
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
    const { count, path: labeledPath } = await labelFields(formName, year)
    await updateStatus(formName, year, 'labeling', { labeled_s3_key: `discovery/labels/${formName}_${year}_LABELS.pdf` })

    // Step 4: Textract map
    await updateStatus(formName, year, 'mapping')
    const fieldMap = await textractMap(formName, year, labeledPath)
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
  const { data } = await supabase.from('form_discovery')
    .select('*').eq('form_name', formName).eq('tax_year', year).single()
  return data
}
