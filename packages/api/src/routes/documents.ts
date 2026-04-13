/**
 * Document routes — Upload, categorize (Gemini), extract (Textract)
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import multer from 'multer'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
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

const upload = multer({ dest: '/tmp/tax-uploads/', limits: { fileSize: 50 * 1024 * 1024 } })
const router = Router()

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

// Upload + categorize
router.post('/upload', upload.single('file'), async (req, res) => {
  const client = sb(req)
  const { data: { user } } = await client.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const file = req.file
  if (!file) return res.status(400).json({ error: 'No file uploaded' })

  try {
    const fileBuffer = readFileSync(file.path)
    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'pdf'
    const s3Key = `documents/${user.id}/${uuidv4()}.${ext}`

    // Upload to S3
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const uploadScript = `
import boto3
s3 = boto3.client('s3', region_name='us-east-1')
s3.upload_file('${file.path}', '${S3_BUCKET}', '${s3Key}')
print('ok')
`
    execSync(`${pythonBin} -c "${uploadScript}"`, { timeout: 30000 })

    // Categorize with Gemini Flash Lite
    let docType = 'other'
    let taxYear: number | null = null
    let entityName = ''
    let summary = ''

    if (GEMINI_KEY && (ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg')) {
      try {
        const genAI = new GoogleGenerativeAI(GEMINI_KEY)
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' })

        const base64 = fileBuffer.toString('base64')
        const mimeType = ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`

        const result = await model.generateContent([
          {
            inlineData: { data: base64, mimeType }
          },
          {
            text: `Analyze this tax document and respond ONLY with valid JSON (no markdown, no code fences):
{
  "doc_type": one of "w2" | "1099" | "k1" | "prior_return_1040" | "prior_return_1120" | "prior_return_1120s" | "bank_statement" | "invoice" | "receipt" | "tax_transcript" | "other",
  "tax_year": the tax year as integer or null,
  "entity_name": the entity/person name or "",
  "ein_or_ssn": EIN or SSN found or "",
  "summary": one-line description of what this document is,
  "key_values": { up to 10 key financial values found, e.g. "total_income": 123456 }
}`
          }
        ])

        const text = result.response.text().trim()
        // Strip any markdown fences
        const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
        const parsed = JSON.parse(jsonStr)

        docType = parsed.doc_type || 'other'
        taxYear = parsed.tax_year || null
        entityName = parsed.entity_name || ''
        summary = parsed.summary || ''

        // Save to DB
        const { data: doc, error } = await client.from('document').insert({
          user_id: user.id,
          filename: file.originalname,
          file_type: ext,
          s3_path: s3Key,
          doc_type: docType,
          tax_year: taxYear,
          meta: {
            size: file.size,
            entity_name: entityName,
            ein_or_ssn: parsed.ein_or_ssn || '',
            summary,
            key_values: parsed.key_values || {},
            gemini_raw: parsed,
          }
        }).select().single()

        // Cleanup temp file
        try { unlinkSync(file.path) } catch {}

        if (error) return res.status(500).json({ error: error.message })

        res.json({
          document: doc,
          classification: { doc_type: docType, tax_year: taxYear, entity_name: entityName, summary },
        })
        return
      } catch (geminiErr: any) {
        console.error('Gemini classification failed:', geminiErr.message)
        // Fall through to basic insert
      }
    }

    // Basic insert without Gemini
    const { data: doc, error } = await client.from('document').insert({
      user_id: user.id,
      filename: file.originalname,
      file_type: ext,
      s3_path: s3Key,
      doc_type: docType,
      meta: { size: file.size }
    }).select().single()

    try { unlinkSync(file.path) } catch {}

    if (error) return res.status(500).json({ error: error.message })
    res.json({ document: doc, classification: { doc_type: docType } })

  } catch (e: any) {
    try { if (file?.path) unlinkSync(file.path) } catch {}
    res.status(500).json({ error: e.message })
  }
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

// Run Textract on a document
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
s3 = boto3.client('s3', region_name='us-east-1')
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
        print(json.dumps({'error': 'Textract failed'}))
        exit(0)
    time.sleep(3)

block_map = {b['Id']: b for b in blocks}
key_map, value_map = {}, {}
for b in blocks:
    if b['BlockType'] == 'KEY_VALUE_SET':
        if 'KEY' in b.get('EntityTypes', []): key_map[b['Id']] = b
        else: value_map[b['Id']] = b

def gt(block):
    t = ''
    for rel in block.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                c = block_map.get(cid, {})
                if c.get('BlockType') == 'WORD': t += c.get('Text', '') + ' '
    return t.strip()

kvs = []
for kid, kb in key_map.items():
    kt = gt(kb)
    vb = None
    for rel in kb.get('Relationships', []):
        if rel['Type'] == 'VALUE':
            for vid in rel['Ids']:
                if vid in value_map: vb = value_map[vid]; break
    vt = gt(vb) if vb else ''
    if kt or vt: kvs.append({'key': kt, 'value': vt})

num_pages = sum(1 for b in blocks if b['BlockType'] == 'PAGE')
print(json.dumps({'kvs': kvs, 'num_pages': num_pages, 'num_blocks': len(blocks)}))
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
