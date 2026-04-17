/**
 * Document routes — Presigned upload, Gemini categorization, Textract extraction
 *
 * Flow:
 *   1. GET /presign — get presigned S3 PUT URL
 *   2. Browser uploads directly to S3
 *   3. POST /register — tell API about the file, triggers Gemini categorization
 *   4. POST /:id/extract — run Textract
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { v4 as uuidv4 } from 'uuid'
import { runPython } from '../lib/run_python.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const S3_BUCKET = process.env.S3_BUCKET || 'tax-api-storage-2026'
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

// Anon client for queries — RLS is open, API handles auth
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

// Get user ID from either Bearer token or API key middleware
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
    const script = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
url = s3.generate_presigned_url('put_object', Params={
    'Bucket': '${S3_BUCKET}',
    'Key': '${s3Key}',
    'ContentType': '${contentTypes[ext] || 'application/octet-stream'}',
}, ExpiresIn=300)
print(json.dumps({'url': url, 'key': '${s3Key}'}))
`
    const result = runPython(script, { timeout: 10000 })
    const { url, key } = JSON.parse(result.trim())

    res.json({
      upload_url: url,
      s3_key: key,
      content_type: contentTypes[ext] || 'application/octet-stream',
      expires_in: 300,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
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
    const script = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
url = s3.generate_presigned_url('get_object', Params={
    'Bucket': '${S3_BUCKET}', 'Key': '${doc.s3_path}'
}, ExpiresIn=3600)
print(json.dumps({'url': url}))
`
    const result = runPython(script, { timeout: 10000 })
    res.json(JSON.parse(result.trim()))
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Ingest document from inline base64 (e.g. image pasted by user into chat)
// Uploads to S3 then delegates to the same classify+extract pipeline as /register
router.post('/ingest', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { filename, base64, entity_id } = req.body
  if (!filename || !base64) return res.status(400).json({ error: 'filename and base64 required' })

  const ext = filename.split('.').pop()?.toLowerCase() || 'pdf'
  const s3Key = `documents/${userId}/${uuidv4()}.${ext}`
  const contentType = ({
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    heic: 'image/heic', webp: 'image/webp',
  } as any)[ext] || 'application/octet-stream'

  // Upload to S3 via boto3 (base64 decoded Python-side to avoid JS buffer bloat)
  try {
    const uploadScript = `
import boto3, base64
s3 = boto3.client('s3', region_name='us-east-1')
data = base64.b64decode('${base64}')
s3.put_object(Bucket='${S3_BUCKET}', Key='${s3Key}', Body=data, ContentType='${contentType}')
print(len(data))
`
    const size = parseInt(runPython(uploadScript, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).trim()) || 0

    // Forward to /register by calling the same handler logic
    req.body = { s3_key: s3Key, filename, file_size: size, entity_id }
    // Continue to /register — we're now on the same code path
    return registerHandler(req, res)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Factored so /ingest can reuse it
const registerHandler = async (req: any, res: any) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { s3_key, filename, file_size, entity_id } = req.body
  if (!s3_key || !filename) return res.status(400).json({ error: 's3_key and filename required' })

  const ext = filename.split('.').pop()?.toLowerCase() || ''

  // Categorize with Gemini
  let classification: any = { doc_type: 'other' }

  if (GEMINI_KEY && ['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    try {
      // Download from S3 for Gemini
      const dlScript = `
import boto3, base64, json
s3 = boto3.client('s3', region_name='us-east-1')
obj = s3.get_object(Bucket='${S3_BUCKET}', Key='${s3_key}')
data = obj['Body'].read()
print(base64.b64encode(data).decode())
`
      const base64 = runPython(dlScript, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 })

      const genAI = new GoogleGenerativeAI(GEMINI_KEY)
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })
      const mimeType = ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`

      const result = await model.generateContent([
        { inlineData: { data: base64, mimeType } },
        { text: `Analyze this tax document. Respond ONLY with valid JSON (no markdown):
{
  "doc_type": one of
    "w2" | "1099_int" | "1099_div" | "1099_b" | "1099_r" | "1099_misc" | "1099_nec" | "1099_k" | "1099_g" | "1099_sa" | "1099_oid" | "1099"
    | "k1" | "prior_return_1040" | "prior_return_1120" | "prior_return_1120s"
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

  // Run Textract (for PDFs/images)
  let textractData: any = null
  if (['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    try {
      const txScript = `
import boto3, json, time
textract = boto3.client('textract', region_name='us-east-1')
job = textract.start_document_analysis(
    DocumentLocation={'S3Object': {'Bucket': '${S3_BUCKET}', 'Name': '${s3_key}'}},
    FeatureTypes=['FORMS', 'TABLES'])
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
        print(json.dumps({'error': 'failed'}))
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
    kt = gt(kb); vb = None
    for rel in kb.get('Relationships', []):
        if rel['Type'] == 'VALUE':
            for vid in rel['Ids']:
                if vid in vm: vb = vm[vid]; break
    vt = gt(vb) if vb else ''
    if kt or vt: kvs.append({'key': kt, 'value': vt})
tables = []
for b in blocks:
    if b['BlockType'] != 'TABLE': continue
    cells = {}
    for rel in b.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                cb = bm.get(cid, {})
                if cb.get('BlockType') == 'CELL':
                    r = cb.get('RowIndex', 0); c = cb.get('ColumnIndex', 0)
                    cells[(r, c)] = gt(cb)
    if not cells: continue
    max_r = max(r for r, _ in cells)
    max_c = max(c for _, c in cells)
    rows = [[cells.get((r, c), '') for c in range(1, max_c + 1)] for r in range(1, max_r + 1)]
    tables.append({'page': b.get('Page', 1), 'rows': rows, 'row_count': max_r, 'col_count': max_c})
np = sum(1 for b in blocks if b['BlockType'] == 'PAGE')
print(json.dumps({'kvs': kvs, 'tables': tables, 'num_pages': np, 'num_blocks': len(blocks)}))
`
      const txResult = runPython(txScript, { timeout: 180000 })
      textractData = JSON.parse(txResult.trim())
    } catch (e: any) {
      console.error('Textract failed:', e.message)
    }
  }

  // Save to DB
  const { data: doc, error } = await supabase.from('document').insert({
    user_id: userId,
    entity_id: entity_id || null,
    filename,
    file_type: ext,
    s3_path: s3_key,
    doc_type: classification.doc_type || 'other',
    tax_year: classification.tax_year || null,
    textract_data: textractData,
    extracted_at: textractData ? new Date().toISOString() : null,
    meta: {
      size: file_size,
      entity_name: classification.entity_name || '',
      ein_or_ssn: classification.ein_or_ssn || '',
      summary: classification.summary || '',
      key_values: classification.key_values || {},
    }
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })

  // Auto-process if it's a recognized tax return with textract data
  let processedReturn = null
  const isReturn = ['prior_return_1040', 'prior_return_1120', 'prior_return_1120s'].includes(classification.doc_type || '')
  if (isReturn && textractData?.kvs?.length && doc) {
    try {
      const { mapToCanonical } = await import('../intake/json_model_mapper.js')
      const { calc1120, calc1120S, calc1040 } = await import('../engine/tax_engine.js')

      const formTypeMap: Record<string, string> = {
        prior_return_1040: '1040', prior_return_1120: '1120', prior_return_1120s: '1120S',
      }
      const formType = formTypeMap[classification.doc_type] || '1120'
      const txYear = classification.tax_year

      const mapped = mapToCanonical({
        source: 'textract', form_type: formType === '1120S' ? '1120S' : formType,
        tax_year: txYear, key_value_pairs: textractData.kvs,
      })

      const getNum = (key: string): number => {
        const v = mapped.model[key]; return typeof v === 'number' ? v : 0
      }

      let engineResult: any = null
      if (formType === '1120') {
        engineResult = calc1120({
          gross_receipts: getNum('income.L1a_gross_receipts') || getNum('income.gross_receipts'),
          returns_allowances: 0, cost_of_goods_sold: getNum('income.L2_cogs') || getNum('income.cost_of_goods_sold'),
          dividends: 0, interest_income: getNum('income.L5_interest'), gross_rents: 0, gross_royalties: 0,
          capital_gains: 0, net_gain_4797: 0, other_income: 0,
          officer_compensation: getNum('deductions.L12_officer_comp'),
          salaries_wages: getNum('deductions.L13_salaries') || getNum('deductions.salaries_wages'),
          repairs_maintenance: 0, bad_debts: 0, rents: 0,
          taxes_licenses: getNum('deductions.L17_taxes_licenses') || getNum('deductions.taxes_licenses'),
          interest_expense: 0, charitable_contrib: getNum('deductions.L19_charitable'),
          depreciation: getNum('deductions.L20_depreciation'), depletion: 0,
          advertising: getNum('deductions.L22_advertising'), pension_plans: 0, employee_benefits: 0,
          other_deductions: getNum('deductions.L26_other_deductions') || getNum('deductions.other_deductions'),
          nol_deduction: getNum('tax.L29a_nol'), special_deductions: 0,
          estimated_tax_paid: getNum('schedJ.J13_prior_overpayment') + getNum('schedJ.J14_estimated_payments'),
          tax_year: txYear,
        })
      } else if (formType === '1120S') {
        engineResult = calc1120S({
          gross_receipts: getNum('income.L1a_gross_receipts') || getNum('income.gross_receipts'),
          returns_allowances: 0, cost_of_goods_sold: getNum('income.L2_cogs') || getNum('income.cost_of_goods_sold'),
          net_gain_4797: 0, other_income: getNum('income.L5_other_income'),
          officer_compensation: getNum('deductions.L7_officer_comp') || getNum('deductions.officer_compensation'),
          salaries_wages: getNum('deductions.L8_salaries') || getNum('deductions.salaries_wages'),
          repairs_maintenance: 0, bad_debts: 0, rents: 0,
          taxes_licenses: getNum('deductions.L12_taxes') || getNum('deductions.taxes_licenses'),
          interest: 0, depreciation: 0, depletion: 0, advertising: 0, pension_plans: 0, employee_benefits: 0,
          other_deductions: getNum('deductions.L20_other') || getNum('deductions.other_deductions'),
          charitable_contrib: 0, section_179: 0,
          shareholders: [{ name: classification.entity_name || 'Shareholder', pct: 100 }],
        })
      }

      if (engineResult) {
        // Find entity
        let entityId = null
        if (classification.entity_name) {
          const { data: existing } = await supabase.from('tax_entity')
            .select('id').ilike('name', `%${classification.entity_name.split(' ')[0]}%`).single()
          entityId = existing?.id || null
        }

        const { data: taxReturn } = await supabase.from('tax_return').upsert({
          entity_id: entityId, tax_year: txYear, form_type: formType,
          status: 'computed', is_amended: false,
          input_data: {}, computed_data: engineResult,
          field_values: Object.fromEntries(mapped.fields.map(f => [f.canonical_key, f.value])),
          verification: { mapper_stats: mapped.stats, extracted_count: mapped.fields.length },
          computed_at: new Date().toISOString(),
        }, { onConflict: 'entity_id,tax_year,form_type,is_amended' }).select().single()

        processedReturn = {
          id: taxReturn?.id,
          form_type: formType, tax_year: txYear,
          computed: engineResult?.computed,
          mapped_fields: mapped.fields.length,
        }
      }
    } catch (e: any) {
      console.error('Auto-process failed:', e.message)
    }
  }

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

  res.json({
    document: doc, classification,
    textract: textractData ? { num_pages: textractData.num_pages, num_fields: textractData.kvs?.length } : null,
    processed_return: processedReturn,
    discovery_started: discoveryStarted,
  })
}

// Expose the register handler as a route
router.post('/register', registerHandler)

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

  const { data, error } = await supabase.from('document').insert({
    user_id: userId,
    entity_id,
    filename: `manual: ${category}${source_note ? ` — ${source_note.slice(0, 50)}` : ''}`,
    file_type: 'fact',
    s3_path: null,
    doc_type: category,
    tax_year,
    textract_data: null,
    extracted_at: new Date().toISOString(),
    meta: {
      source: 'manual',
      source_note: source_note || '',
      summary: summary || `Recorded ${category} fact`,
      key_values: values,
    },
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({
    document_id: data.id,
    category,
    values,
    note: 'Recorded as a virtual document. Will auto-merge into compute_return for this entity+year.',
  })
})

// Re-categorize an existing document with Gemini
router.post('/:id/categorize', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: doc } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId!).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })

  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const ext = doc.file_type || doc.filename?.split('.').pop()?.toLowerCase() || ''
  if (!['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    return res.status(400).json({ error: 'Only PDF and image files can be categorized' })
  }

  try {
    const dlScript = `
import boto3, base64
s3 = boto3.client('s3', region_name='us-east-1')
obj = s3.get_object(Bucket='${S3_BUCKET}', Key='${doc.s3_path}')
print(base64.b64encode(obj['Body'].read()).decode())
`
    const base64 = runPython(dlScript, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 })

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

    await supabase.from('document').update({
      doc_type: classification.doc_type || doc.doc_type,
      tax_year: classification.tax_year || doc.tax_year,
      meta: {
        ...doc.meta,
        entity_name: classification.entity_name || '',
        ein_or_ssn: classification.ein_or_ssn || '',
        summary: classification.summary || '',
        key_values: classification.key_values || {},
      }
    }).eq('id', req.params.id)

    res.json({ document_id: req.params.id, classification })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// List documents
router.get('/', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data, error } = await supabase.from('document')
    .select('*, tax_entity(name)')
    .eq('user_id', userId!)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ documents: data })
})

// Get single document
router.get('/:id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data, error } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId!).single()
  if (error || !data) return res.status(404).json({ error: 'Not found' })
  res.json({ document: data })
})

// Delete document
router.delete('/:id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  await supabase.from('document').delete().eq('id', req.params.id).eq('user_id', userId!)
  res.json({ success: true })
})

// Run Textract
router.post('/:id/extract', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: doc } = await supabase.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', userId!).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })

  try {
    const script = `
import boto3, json, time
textract = boto3.client('textract', region_name='us-east-1')
job = textract.start_document_analysis(
    DocumentLocation={'S3Object': {'Bucket': '${S3_BUCKET}', 'Name': '${doc.s3_path}'}},
    FeatureTypes=['FORMS', 'TABLES'])
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
        print(json.dumps({'error': 'failed'}))
        exit(0)
    time.sleep(3)
block_map = {b['Id']: b for b in blocks}
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
                c = block_map.get(cid, {})
                if c.get('BlockType') == 'WORD': t += c.get('Text', '') + ' '
    return t.strip()
kvs = []
for kid, kb in km.items():
    kt = gt(kb); vb = None
    for rel in kb.get('Relationships', []):
        if rel['Type'] == 'VALUE':
            for vid in rel['Ids']:
                if vid in vm: vb = vm[vid]; break
    vt = gt(vb) if vb else ''
    if kt or vt: kvs.append({'key': kt, 'value': vt})
tables = []
for b in blocks:
    if b['BlockType'] != 'TABLE': continue
    cells = {}
    for rel in b.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                cb = block_map.get(cid, {})
                if cb.get('BlockType') == 'CELL':
                    r = cb.get('RowIndex', 0); c = cb.get('ColumnIndex', 0)
                    cells[(r, c)] = gt(cb)
    if not cells: continue
    max_r = max(r for r, _ in cells)
    max_c = max(c for _, c in cells)
    rows = [[cells.get((r, c), '') for c in range(1, max_c + 1)] for r in range(1, max_r + 1)]
    tables.append({'page': b.get('Page', 1), 'rows': rows, 'row_count': max_r, 'col_count': max_c})
np = sum(1 for b in blocks if b['BlockType'] == 'PAGE')
print(json.dumps({'kvs': kvs, 'tables': tables, 'num_pages': np, 'num_blocks': len(blocks)}))
`
    const result = runPython(script, { timeout: 120000 })
    const textractData = JSON.parse(result)

    await supabase.from('document').update({
      textract_data: textractData,
      extracted_at: new Date().toISOString(),
    }).eq('id', req.params.id)

    res.json({ document_id: req.params.id, extraction: textractData })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
