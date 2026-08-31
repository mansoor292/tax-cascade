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
 *
 * MCP tools:
 *   compute_1120, compute_1120s, compute_1040, compute_cascade
 *   fill_pdf, list_forms, get_field_map
 */

// MUST stay the first import. ESM hoists and fully evaluates every import
// below before any statement in this file's body runs, so env loading cannot
// live inline here — the route modules would already have captured their
// fallbacks. See bootstrap_env.ts for the full explanation.
import './bootstrap_env.js'

import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { execSync, spawn } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { PDFDocument, PDFTextField } from 'pdf-lib'
import { calc1120, calc1120S, calc1040, calcCascade } from './engine/tax_engine.js'
import {
  ordinaryTax, niitTax, qbiDeduction, standardDeduction, TAX_TABLES
} from './engine/tax_tables.js'
import { FORM_INVENTORY, seedCacheFromSupabase } from './maps/field_maps.js'
import authRoutes, { supabase } from './routes/auth.js'
import { anonKeyConfigured } from './lib/supabase.js'
import scenarioRoutes from './routes/scenarios.js'
import documentRoutes from './routes/documents.js'
import returnRoutes from './routes/returns.js'
import entityRoutes from './routes/entities.js'
import schemaRoutes from './routes/schema.js'
import qboRoutes from './routes/qbo.js'
import stripeRoutes from './routes/stripe.js'
import scratchRoutes from './routes/scratch.js'
import intakeRoutes from './routes/intake.js'
import calendarRoutes from './routes/calendar.js'
import discoveryRoutes from './discovery/discovery_routes.js'
import { mountMCP } from './mcp/tax-mcp.js'

const STARTED_AT = new Date().toISOString()

const app = express()
app.set('trust proxy', true)
// A browser can only read response headers a server explicitly exposes, and
// cors() exposes none by default. An MCP client running in a browser needs
// WWW-Authenticate off the 401 to discover where to authenticate, and
// Mcp-Session-Id / Mcp-Protocol-Version to talk Streamable HTTP. Without
// these the headers are sent but invisible to the client, which surfaces as
// an opaque connection failure rather than an auth challenge.
app.use(cors({
  exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
}))

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

  // ESM imports in route files run before server.ts's in-process SSM loader
  // (import hoisting), so any secret only in SSM (e.g. SUPABASE_SERVICE_ROLE_KEY)
  // is undefined at module-load time. Shelling SSM → shell env → pm2 --update-env
  // → node's process.env fixes the ordering. Helper script committed alongside.
  //
  // Fetch and install synchronously — neither step touches this process.
  // fetch + reset rather than pull: `git pull` needs a merge strategy and
  // fails outright once history is rewritten upstream, which silently stopped
  // every deploy after one force-push. The server should always match
  // origin/main exactly, so say that directly.
  const fetchCmd = [
    'cd /opt/tax-api',
    'git checkout -- package-lock.json',
    'git fetch origin main',
    'git reset --hard origin/main',
    'cd packages/api',
    'npm install --include=dev',
    'chmod +x scripts/load-ssm-env.sh',
  ].join(' && ')

  // The reload CANNOT run here, and `detached: true` alone is not enough.
  //
  // This handler runs inside a pm2 cluster worker. pm2 cycles workers one at
  // a time and takes down the one handling this request first — and its
  // treekill (on by default) walks that worker's child tree by ppid, which
  // reaches a detached child despite setsid giving it a new session. So the
  // reload died after cycling this worker and never reached the other one,
  // leaving half the fleet on the old build with requests round-robining
  // between them: measured 10 of 20 identical requests answered by new code
  // and 10 by old, stable across repeated polls.
  //
  // That has been true of every deploy, which means fixes were landing for
  // roughly half of all traffic — bugs looked intermittent and verification
  // looked flaky, on both counts wrongly.
  //
  // Double-fork so the reload is reparented to init before the killing
  // starts. The script sleeps first to let that settle, reads everything it
  // needs from disk, uses `reload` (workers cycle one at a time, so the API
  // keeps answering), and then CONFIRMS every worker reports the same commit
  // rather than assuming it.
  const detach =
    'setsid nohup bash /opt/tax-api/packages/api/scripts/deploy-reload.sh ' +
    '>> /tmp/tax-api-reload.log 2>&1 &'

  try {
    execSync(fetchCmd, { timeout: 120000 })
    execSync('chmod +x scripts/deploy-reload.sh', { cwd: '/opt/tax-api/packages/api' })
    const child = spawn('bash', ['-lc', detach], { detached: true, stdio: 'ignore' })
    child.unref()
    console.log('Deploy: fetched, reload handed off:', payload.head_commit?.message)
  } catch (e: any) {
    console.error('Deploy failed:', e.message)
  }
})

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static('public'))

// ─── MCP (public — clients authenticate via OAuth on fin.catipult.ai) ───
// There is deliberately NO OAuth implementation on this origin any more.
// The Express one that lived in mcp/oauth.ts was dead in production —
// every endpoint shadowed by netlify.toml's redirects — and broken by
// design under pm2 cluster (in-memory auth codes don't survive worker
// round-robin). The stateless-JWT Netlify Functions in
// packages/web/netlify/functions are THE implementation, and the static
// JSON in packages/web/public/.well-known is THE discovery metadata.
// tax-mcp.ts's WWW-Authenticate challenge already points clients there.
// Direct callers of this EC2 origin's /oauth/* (none known) get 404s.
mountMCP(app)

// ─── Auth routes (public — no API key needed) ───
app.use('/auth', authRoutes)

// ─── API Key Auth (supports both static keys and Supabase-provisioned keys) ───
// Static keys come ONLY from TAX_API_KEYS (comma-separated). There is
// deliberately no default: a well-known fallback key mapped every anonymous
// caller onto the all-zeros user until it was removed. With the var unset,
// only Supabase JWTs and provisioned api_key rows authenticate.
const STATIC_KEYS = new Set(
  (process.env.TAX_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
)

app.use('/api', async (req, res, next) => {
  // Public routes — no API key needed
  if (req.path === '/health') return next()
  if (req.path === '/qbo/callback') return next()
  // Auth routes are separate
  // Extract key from x-api-key header, query param, or Bearer token
  const key = req.headers['x-api-key'] as string
    || req.query.api_key as string
    || req.headers.authorization?.replace('Bearer ', '')
  if (!key) {
    res.status(401).json({ error: 'Missing API key or Bearer token' })
    return
  }
  // Check static keys
  if (STATIC_KEYS.has(key)) {
    (req as any).userId = '00000000-0000-0000-0000-000000000000'
    return next()
  }
  // Everything below needs the anon client. Answer 503 rather than let the
  // missing-key throw reject this async middleware, which Express 4 has no
  // error path for — the request would hang with no response.
  if (!anonKeyConfigured()) {
    res.status(503).json({ error: 'Auth is unavailable: SUPABASE_ANON_KEY is not configured on this server.' })
    return
  }
  // Check Supabase JWT
  const { data: { user } } = await supabase.auth.getUser(key)
  if (user) { (req as any).userId = user.id; return next() }
  // Check Supabase-provisioned API keys. Prefer argon2 hash verification
  // (constant-time; no plaintext key exposure in the DB). Falls back to the
  // plaintext column during dual-storage transition.
  const prefix = key.slice(0, 8)
  const { data: candidates } = await supabase.from('api_key')
    .select('id, user_id, key_value, key_value_hash')
    .eq('is_active', true)
    .eq('key_prefix', prefix)
  if (candidates?.length) {
    const argon2 = await import('argon2')
    for (const row of candidates) {
      const match = row.key_value_hash
        ? await argon2.verify(row.key_value_hash, key).catch(() => false)
        : row.key_value === key
      if (match) {
        (req as any).userId = row.user_id
        supabase.from('api_key').update({ last_used_at: new Date().toISOString() }).eq('id', row.id).then()
        return next()
      }
    }
  }
  // Legacy fallback for rows without key_prefix set yet
  const { data } = await supabase.from('api_key')
    .select('id, user_id').eq('key_value', key).eq('is_active', true).single()
  if (data) {
    (req as any).userId = data.user_id
    supabase.from('api_key').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then()
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
app.use('/api/stripe', stripeRoutes)
app.use('/api/scratch', scratchRoutes)
app.use('/api/intake', intakeRoutes)
app.use('/api/calendar', calendarRoutes)
app.use('/api/discover', discoveryRoutes)

// ─── Health ───
// Resolved once at boot, so it reports the commit THIS worker actually loaded
// rather than whatever is on disk now.
const BUILD_COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: '/opt/tax-api', encoding: 'utf8', timeout: 5000,
    }).trim()
  } catch {
    return 'unknown'
  }
})()

app.get('/api/health', (_req, res) => {
  // commit and pid are here because a half-deployed fleet is otherwise
  // invisible: pm2 runs one worker per core and a deploy could leave some on
  // the old build, with requests round-robining between them. Poll this a few
  // times — more than one distinct commit means the deploy did not finish.
  res.json({
    status: 'ok',
    version: '0.1.0',
    forms: Object.keys(FORM_INVENTORY).length,
    commit: BUILD_COMMIT,
    pid: process.pid,
    started_at: STARTED_AT,
  })
})

// ─── List available forms ───
app.get('/api/forms', (_req, res) => {
  res.json(FORM_INVENTORY)
})

// ─── Compute 1120 ───
app.post('/api/compute/1120', (req, res) => {
  try {
    // The engine only carries tables for the supported range. A year outside
    // it must be refused: the C-corp flat rate is year-independent, so an
    // unsupported year used to "compute" plausibly instead of failing.
    if (req.body?.tax_year && !TAX_TABLES[req.body.tax_year]) {
      return res.status(400).json({ success: false, error: `No tax tables for year ${req.body.tax_year}` })
    }
    const result = calc1120(req.body)
    res.json({ success: true, result })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── Compute 1120-S ───
app.post('/api/compute/1120s', (req, res) => {
  try {
    // The engine only carries tables for the supported range. A year outside
    // it must be refused: the C-corp flat rate is year-independent, so an
    // unsupported year used to "compute" plausibly instead of failing.
    if (req.body?.tax_year && !TAX_TABLES[req.body.tax_year]) {
      return res.status(400).json({ success: false, error: `No tax tables for year ${req.body.tax_year}` })
    }
    const result = calc1120S(req.body)
    res.json({ success: true, result })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── Compute 1040 ───
app.post('/api/compute/1040', (req, res) => {
  try {
    // The engine only carries tables for the supported range. A year outside
    // it must be refused: the C-corp flat rate is year-independent, so an
    // unsupported year used to "compute" plausibly instead of failing.
    if (req.body?.tax_year && !TAX_TABLES[req.body.tax_year]) {
      return res.status(400).json({ success: false, error: `No tax tables for year ${req.body.tax_year}` })
    }
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
    // Validate the two halves before the engine dereferences them — a flat
    // body (the shape an LLM plausibly sends) used to surface as
    // "Cannot read properties of undefined (reading 'is_sstb')".
    if (!s_corp_inputs || typeof s_corp_inputs !== 'object' || !individual_base || typeof individual_base !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'cascade requires { s_corp_inputs: {...}, individual_base: {...} } — two objects, not a flat body',
      })
    }
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
    const map: Record<string, string> = fieldMap || {}
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

// ─── /api/verify was removed ───
// It took a LOCAL SERVER FILESYSTEM PATH from the request body (usable only
// from a dev box, and an injection surface via the inline Python it ran),
// had no callers in the MCP tools or the web app, and wrote to a bucket
// nothing else used. The field-map verification workflow lives in
// scripts/verify_pipeline.ts.

// ─── Start server ───
const PORT = parseInt(process.env.PORT || '3737')
app.listen(PORT, async () => {
  console.log(`Tax API running on http://localhost:${PORT}`)
  // Seed field maps from Supabase for forms discovered at runtime (not in git)
  await seedCacheFromSupabase()
  console.log(`  POST /api/compute/1120    — C-Corp return`)
  console.log(`  POST /api/compute/1120s   — S-Corp return`)
  console.log(`  POST /api/compute/1040    — Individual return`)
  console.log(`  POST /api/compute/cascade — S-Corp → K-1 → 1040`)
  console.log(`  GET  /api/forms           — Available forms`)
  console.log(`  GET  /api/tax-tables/:year`)
  console.log(`  GET  /api/field-map/:form/:year`)
})

export default app
