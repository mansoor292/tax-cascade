/**
 * Tax API Server — Express + MCP
 *
 * Express endpoints:
 *   POST /api/compute/1120    — compute C-Corp return
 *   POST /api/compute/1120s   — compute S-Corp return
 *   POST /api/compute/1040    — compute individual return
 *   POST /api/compute/cascade — S-Corp → K-1 → 1040 cascade
 *   POST /api/fill/:form/:year — fill a PDF from canonical model
 *   GET  /api/forms           — list available forms
 *   GET  /api/field-map/:form/:year — get field map for a form
 *   POST /api/verify/:form/:year — verify filled PDF via Textract
 *
 * MCP tools:
 *   compute_1120, compute_1120s, compute_1040, compute_cascade
 *   fill_pdf, list_forms, get_field_map
 */

import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { runPython } from './lib/run_python.js'
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib'
import { calc1120, calc1120S, calc1040, calcCascade } from './engine/tax_engine.js'
import {
  ordinaryTax, ltcgTax, niitTax, qbiDeduction, standardDeduction, TAX_TABLES
} from './engine/tax_tables.js'
import { FORM_INVENTORY } from './maps/field_maps.js'
import authRoutes, { supabase } from './routes/auth.js'
import scenarioRoutes from './routes/scenarios.js'
import documentRoutes from './routes/documents.js'
import returnRoutes from './routes/returns.js'
import entityRoutes from './routes/entities.js'
import schemaRoutes from './routes/schema.js'
import qboRoutes from './routes/qbo.js'
import discoveryRoutes from './discovery/discovery_routes.js'

const app = express()
app.use(cors())

// ─── Deploy webhook — must be before express.json() so we get the raw body for HMAC ───
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || ''

app.post('/deploy', express.raw({ type: 'application/json' }), (req, res) => {
  if (!WEBHOOK_SECRET) return res.status(500).json({ error: 'Webhook secret not configured' })

  const sig = req.headers['x-hub-signature-256'] as string
  if (!sig) return res.status(401).json({ error: 'Missing signature' })

  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const payload = JSON.parse(req.body.toString())
  if (payload.ref !== 'refs/heads/main') {
    return res.json({ skipped: true, reason: `Push to ${payload.ref}, not main` })
  }

  // Pull and restart in background
  res.json({ deploying: true, commit: payload.head_commit?.id?.slice(0, 7) })

  const cmd = 'cd /opt/tax-api && git pull && cd packages/api && npm install --include=dev && export $(cat .env | xargs) && pm2 restart tax-api --update-env'
  try {
    execSync(cmd, { timeout: 120000 })
    console.log('Deploy succeeded:', payload.head_commit?.message)
  } catch (e: any) {
    console.error('Deploy failed:', e.message)
  }
})

app.use(express.json({ limit: '10mb' }))
app.use(express.static('public'))

// ─── Auth routes (public — no API key needed) ───
app.use('/auth', authRoutes)

// ─── API Key Auth (supports both static keys and Supabase-provisioned keys) ───
const STATIC_KEYS = new Set((process.env.TAX_API_KEYS || 'test-key-2026').split(','))

app.use('/api', async (req, res, next) => {
  // Public routes — no API key needed
  if (req.path === '/health') return next()
  if (req.path === '/qbo/callback') return next()
  // Auth routes are separate
  const key = req.headers['x-api-key'] || req.query.api_key as string
  if (!key) {
    // Try Bearer token (Supabase JWT)
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token)
      if (user) { (req as any).userId = user.id; return next() }
    }
    res.status(401).json({ error: 'Missing API key or Bearer token' })
    return
  }
  // Check static keys
  if (STATIC_KEYS.has(key as string)) return next()
  // Check Supabase-provisioned keys
  const { data } = await supabase.from('api_key')
    .select('user_id').eq('key_value', key).eq('is_active', true).single()
  if (data) {
    (req as any).userId = data.user_id
    // Update last_used
    supabase.from('api_key').update({ last_used_at: new Date().toISOString() }).eq('key_value', key).then()
    return next()
  }
  res.status(401).json({ error: 'Invalid API key' })
})

// ─── Scenario routes ───
app.use('/api/scenarios', scenarioRoutes)
app.use('/api/documents', documentRoutes)
app.use('/api/returns', returnRoutes)
app.use('/api/entities', entityRoutes)
app.use('/api/schema', schemaRoutes)
app.use('/api/qbo', qboRoutes)
app.use('/api/discover', discoveryRoutes)

// ─── Health ───
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0', forms: Object.keys(FORM_INVENTORY).length })
})

// ─── List available forms ───
app.get('/api/forms', (_req, res) => {
  res.json(FORM_INVENTORY)
})

// ─── Compute 1120 ───
app.post('/api/compute/1120', (req, res) => {
  try {
    const result = calc1120(req.body)
    res.json({ success: true, result })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── Compute 1120-S ───
app.post('/api/compute/1120s', (req, res) => {
  try {
    const result = calc1120S(req.body)
    res.json({ success: true, result })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── Compute 1040 ───
app.post('/api/compute/1040', (req, res) => {
  try {
    const result = calc1040(req.body)
    res.json({ success: true, result })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── Compute cascade (1120-S → K-1 → 1040) ───
app.post('/api/compute/cascade', (req, res) => {
  try {
    const { s_corp_inputs, individual_base } = req.body
    const result = calcCascade(s_corp_inputs, individual_base)
    res.json({ success: true, result })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── Tax table lookup ───
app.get('/api/tax-tables/:year', (req, res) => {
  const year = parseInt(req.params.year)
  const tables = TAX_TABLES[year]
  if (!tables) {
    res.status(404).json({ error: `No tax tables for year ${year}` })
    return
  }
  res.json(tables)
})

// ─── Compute individual tax items ───
app.post('/api/compute/ordinary-tax', (req, res) => {
  const { taxable, status, year } = req.body
  res.json({ tax: ordinaryTax(taxable, status, year) })
})

app.post('/api/compute/qbi', (req, res) => {
  const { qbi_income, w2_wages, ubia, taxable_income, status, year } = req.body
  res.json({ deduction: qbiDeduction(qbi_income, w2_wages, ubia, taxable_income, status, year) })
})

app.post('/api/compute/niit', (req, res) => {
  const { net_investment_income, magi, status, year } = req.body
  res.json({ tax: niitTax(net_investment_income, magi, status, year) })
})

app.post('/api/compute/standard-deduction', (req, res) => {
  const { status, year } = req.body
  res.json({ deduction: standardDeduction(status, year) })
})

// ─── Get field map ───
app.get('/api/field-map/:form/:year', (req, res) => {
  try {
    const mapPath = `data/field_maps/${req.params.form}_${req.params.year}_fields.json`
    const map = JSON.parse(readFileSync(mapPath, 'utf-8'))
    res.json({ form: req.params.form, year: req.params.year, fields: map })
  } catch (e: any) {
    res.status(404).json({ error: 'Field map not found', detail: e.message })
  }
})

// ─── Fill a PDF ───
app.post('/api/fill/:form/:year', async (req, res) => {
  try {
    const { form: formName, year } = req.params
    const { data, fieldMap } = req.body  // data = canonical values, fieldMap = optional override

    // Load blank form
    const blankPath = `data/irs_forms/${formName}_${year}.pdf`
    if (!existsSync(blankPath)) {
      res.status(404).json({ error: `Blank form not found: ${blankPath}` })
      return
    }

    // Load field map
    let map: Record<string, string> = fieldMap || {}
    if (!fieldMap) {
      // Try to load from canonical map files
      try {
        const mapPath = `data/field_maps/${formName}_${year}_fields.json`
        const fields: Array<{field_id: string; label: string}> = JSON.parse(readFileSync(mapPath, 'utf-8'))
        // Build a simple label → field_id lookup (caller provides canonical keys matching labels)
        for (const f of fields) {
          map[f.field_id] = f.field_id  // identity map — caller uses field_ids directly
        }
      } catch {}
    }

    const pdf = await PDFDocument.load(readFileSync(blankPath))
    const form = pdf.getForm()

    let filled = 0
    const missed: string[] = []
    for (const [key, value] of Object.entries(data)) {
      // key can be a field_id (f1_47) or canonical key that maps to a field_id
      const fieldId = fieldMap ? (fieldMap[key] || key) : key
      let found = false
      for (const f of form.getFields()) {
        if (f.getName().includes(fieldId + '[') && f instanceof PDFTextField) {
          const str = typeof value === 'number'
            ? (value as number).toLocaleString()
            : String(value)
          if (str) {
            const ml = f.getMaxLength()
            if (ml !== undefined && str.length > ml) f.setMaxLength(str.length)
            f.setText(str)
            filled++
          }
          found = true
          break
        }
      }
      if (!found) missed.push(key)
    }

    // Save
    const outDir = 'output/api'
    mkdirSync(outDir, { recursive: true })
    const outPath = `${outDir}/${formName}_${year}_filled.pdf`
    writeFileSync(outPath, await pdf.save())

    res.json({
      success: true,
      filled,
      missed,
      path: outPath,
      totalFields: form.getFields().length,
    })
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Label a PDF (for Textract verification) ───
app.post('/api/label/:form/:year', async (req, res) => {
  try {
    const { form: formName, year } = req.params

    const blankPath = `data/irs_forms/${formName}_${year}.pdf`
    if (!existsSync(blankPath)) {
      res.status(404).json({ error: `Blank form not found: ${blankPath}` })
      return
    }

    const pdf = await PDFDocument.load(readFileSync(blankPath))
    const form = pdf.getForm()
    let count = 0
    const allFields: string[] = []
    for (const f of form.getFields()) {
      if (f instanceof PDFTextField) {
        const short = f.getName().match(/\.(f\d+_\d+)\[/)?.[1] || ''
        if (short) {
          try {
            const ml = f.getMaxLength()
            if (ml !== undefined) f.setMaxLength(50)
            f.setText(short)
            count++
            allFields.push(short)
          } catch {}
        }
      }
    }

    const outDir = 'output/api/labels'
    mkdirSync(outDir, { recursive: true })
    const outPath = `${outDir}/${formName}_${year}_LABELS.pdf`
    writeFileSync(outPath, await pdf.save())

    res.json({ success: true, labeled: count, fields: allFields, path: outPath })
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Verify via Textract (sends PDF to Textract, extracts values) ───
app.post('/api/verify', async (req, res) => {
  try {
    const { pdfPath, expected } = req.body  // pdfPath = local path, expected = {label: value}

    const s3Key = `verify/${Date.now()}_${pdfPath.split('/').pop()}`
    const script = `
import boto3, json, time, re
s3 = boto3.client("s3", region_name="us-east-1")
textract = boto3.client("textract", region_name="us-east-1")
BUCKET = "edgewater-textract-staging-2026"
s3.upload_file("${pdfPath}", BUCKET, "${s3Key}")
job = textract.start_document_analysis(DocumentLocation={"S3Object": {"Bucket": BUCKET, "Name": "${s3Key}"}}, FeatureTypes=["FORMS"])
jid = job["JobId"]
while True:
    resp = textract.get_document_analysis(JobId=jid)
    if resp["JobStatus"] == "SUCCEEDED":
        blocks = resp.get("Blocks", []); nt = resp.get("NextToken")
        while nt: resp = textract.get_document_analysis(JobId=jid, NextToken=nt); blocks.extend(resp.get("Blocks", [])); nt = resp.get("NextToken")
        break
    elif resp["JobStatus"] == "FAILED": print(json.dumps({"error":"FAILED"})); exit(0)
    time.sleep(3)
block_map = {b["Id"]: b for b in blocks}; key_map = {}; value_map = {}
for b in blocks:
    if b["BlockType"] == "KEY_VALUE_SET":
        if "KEY" in b.get("EntityTypes", []): key_map[b["Id"]] = b
        else: value_map[b["Id"]] = b
def gt(block):
    t = ""
    for rel in block.get("Relationships", []):
        if rel["Type"] == "CHILD":
            for cid in rel["Ids"]:
                c = block_map.get(cid, {})
                if c.get("BlockType") == "WORD": t += c.get("Text","") + " "
    return t.strip()
kvs = []
for kid, kb in key_map.items():
    kt = gt(kb); vb = None
    for rel in kb.get("Relationships", []):
        if rel["Type"] == "VALUE":
            for vid in rel["Ids"]:
                if vid in value_map: vb = value_map[vid]; break
    vt = gt(vb) if vb else ""
    if kt or vt: kvs.append({"key": kt, "value": vt})
print(json.dumps(kvs))
`
    const result = runPython(script, { timeout: 120000 })
    const kvs = JSON.parse(result.trim())

    // Compare against expected if provided
    let comparison = null
    if (expected) {
      comparison = { matches: 0, mismatches: 0, missing: 0, details: [] as any[] }
      const parseDollar = (s: string) => {
        const c = s.replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1').replace(/\.$/, '')
        const n = parseFloat(c)
        return isNaN(n) ? null : Math.round(n)
      }
      for (const [label, expVal] of Object.entries(expected)) {
        const found = kvs.find((kv: any) => kv.key.includes(label))
        if (found) {
          const actual = parseDollar(found.value)
          const exp = typeof expVal === 'number' ? expVal : parseDollar(String(expVal))
          if (actual === exp) {
            comparison.matches++
            comparison.details.push({ label, expected: exp, actual, status: 'match' })
          } else {
            comparison.mismatches++
            comparison.details.push({ label, expected: exp, actual, status: 'mismatch' })
          }
        } else {
          comparison.missing++
          comparison.details.push({ label, expected: expVal, actual: null, status: 'missing' })
        }
      }
    }

    res.json({ success: true, extracted: kvs.length, kvs, comparison })
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Start server ───
const PORT = parseInt(process.env.PORT || '3737')
app.listen(PORT, () => {
  console.log(`Tax API running on http://localhost:${PORT}`)
  console.log(`  POST /api/compute/1120    — C-Corp return`)
  console.log(`  POST /api/compute/1120s   — S-Corp return`)
  console.log(`  POST /api/compute/1040    — Individual return`)
  console.log(`  POST /api/compute/cascade — S-Corp → K-1 → 1040`)
  console.log(`  GET  /api/forms           — Available forms`)
  console.log(`  GET  /api/tax-tables/:year`)
  console.log(`  GET  /api/field-map/:form/:year`)
})

export default app
