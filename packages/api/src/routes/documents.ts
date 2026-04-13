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
import { execSync } from 'child_process'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { v4 as uuidv4 } from 'uuid'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const S3_BUCKET = process.env.S3_BUCKET || 'tax-api-storage-2026'
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

function sb(req: Request) {
  const token = req.headers.authorization?.replace('Bearer ', '') || ''
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  })
}

const router = Router()

// Get presigned upload URL
router.get('/presign', async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const filename = req.query.filename as string
  if (!filename) return res.status(400).json({ error: 'filename required' })

  const ext = filename.split('.').pop()?.toLowerCase() || 'pdf'
  const s3Key = `documents/${user.id}/${uuidv4()}.${ext}`

  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }

  try {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
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
    const result = execSync(`${pythonBin} -c "${script}"`, { timeout: 10000, encoding: 'utf-8' })
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
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { data: doc } = await client.from('document')
    .select('s3_path').eq('id', req.params.id).eq('user_id', user.id).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })

  try {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const script = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
url = s3.generate_presigned_url('get_object', Params={
    'Bucket': '${S3_BUCKET}', 'Key': '${doc.s3_path}'
}, ExpiresIn=3600)
print(json.dumps({'url': url}))
`
    const result = execSync(`${pythonBin} -c "${script}"`, { timeout: 10000, encoding: 'utf-8' })
    res.json(JSON.parse(result.trim()))
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Register uploaded file + Gemini categorization
router.post('/register', async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { s3_key, filename, file_size } = req.body
  if (!s3_key || !filename) return res.status(400).json({ error: 's3_key and filename required' })

  const ext = filename.split('.').pop()?.toLowerCase() || ''

  // Categorize with Gemini
  let classification: any = { doc_type: 'other' }

  if (GEMINI_KEY && ['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    try {
      // Download from S3 for Gemini
      const pythonBin = process.env.PYTHON_BIN || 'python3'
      const dlScript = `
import boto3, base64, json
s3 = boto3.client('s3', region_name='us-east-1')
obj = s3.get_object(Bucket='${S3_BUCKET}', Key='${s3_key}')
data = obj['Body'].read()
print(base64.b64encode(data).decode())
`
      const base64 = execSync(`${pythonBin} -c "${dlScript}"`, { timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).trim()

      const genAI = new GoogleGenerativeAI(GEMINI_KEY)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' })
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
      classification = JSON.parse(text)
    } catch (e: any) {
      console.error('Gemini classification failed:', e.message)
    }
  }

  // Run Textract (for PDFs/images)
  let textractData: any = null
  if (['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    try {
      const pythonBin = process.env.PYTHON_BIN || 'python3'
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
np = sum(1 for b in blocks if b['BlockType'] == 'PAGE')
print(json.dumps({'kvs': kvs, 'num_pages': np, 'num_blocks': len(blocks)}))
`
      const txResult = execSync(`${pythonBin} -c '${txScript.replace(/'/g, "\\'")}'`, {
        timeout: 180000, encoding: 'utf-8'
      })
      textractData = JSON.parse(txResult.trim())
    } catch (e: any) {
      console.error('Textract failed:', e.message)
    }
  }

  // Save to DB
  const { data: doc, error } = await client.from('document').insert({
    user_id: user.id,
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
  res.json({ document: doc, classification, textract: textractData ? { num_pages: textractData.num_pages, num_fields: textractData.kvs?.length } : null })
})

// Re-categorize an existing document with Gemini
router.post('/:id/categorize', async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { data: doc } = await client.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', user.id).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })

  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const ext = doc.file_type || doc.filename?.split('.').pop()?.toLowerCase() || ''
  if (!['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
    return res.status(400).json({ error: 'Only PDF and image files can be categorized' })
  }

  try {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const dlScript = `
import boto3, base64
s3 = boto3.client('s3', region_name='us-east-1')
obj = s3.get_object(Bucket='${S3_BUCKET}', Key='${doc.s3_path}')
print(base64.b64encode(obj['Body'].read()).decode())
`
    const base64 = execSync(`${pythonBin} -c "${dlScript}"`, { timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).trim()

    const genAI = new GoogleGenerativeAI(GEMINI_KEY)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' })
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

    await client.from('document').update({
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
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { data, error } = await client.from('document')
    .select('*, tax_entity(name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ documents: data })
})

// Get single document
router.get('/:id', async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { data, error } = await client.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', user.id).single()
  if (error || !data) return res.status(404).json({ error: 'Not found' })
  res.json({ document: data })
})

// Delete document
router.delete('/:id', async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  await client.from('document').delete().eq('id', req.params.id).eq('user_id', user.id)
  res.json({ success: true })
})

// Run Textract
router.post('/:id/extract', async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { data: doc } = await client.from('document')
    .select('*').eq('id', req.params.id).eq('user_id', user.id).single()
  if (!doc) return res.status(404).json({ error: 'Not found' })

  try {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
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
np = sum(1 for b in blocks if b['BlockType'] == 'PAGE')
print(json.dumps({'kvs': kvs, 'num_pages': np, 'num_blocks': len(blocks)}))
`
    const result = execSync(`${pythonBin} -c '${script.replace(/'/g, "\\'")}'`, {
      timeout: 120000, encoding: 'utf-8'
    })
    const textractData = JSON.parse(result.trim())

    await client.from('document').update({
      textract_data: textractData,
      extracted_at: new Date().toISOString(),
    }).eq('id', req.params.id)

    res.json({ document_id: req.params.id, extraction: textractData })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
