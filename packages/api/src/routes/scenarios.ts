/**
 * Scenario routes — Create, compute, and AI-analyze tax scenarios
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { calc1120, calc1120S, calc1040 } from '../engine/tax_engine.js'
import { ordinaryTax, qbiDeduction, niitTax, standardDeduction } from '../engine/tax_tables.js'
import { encryptedFields } from '../lib/row_crypto.js'

const ENCRYPTED_RETURN_FIELDS = { json: ['input_data', 'computed_data', 'field_values', 'verification'] }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const router = Router()
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

// List scenarios
router.get('/', async (req, res) => {
  const userId = (req as any).userId
  const { data, error } = await supabase
    .from('scenario').select('*, tax_entity(name, form_type)')
    .eq('user_id', userId).order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ scenarios: data })
})

// Create scenario
router.post('/', async (req, res) => {
  const userId = (req as any).userId
  const { name, description, entity_id, tax_year, base_return_id, adjustments } = req.body

  const { data, error } = await supabase.from('scenario').insert({
    user_id: userId, name, description, entity_id, tax_year,
    base_return_id, adjustments: adjustments || {},
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ scenario: data })
})

// Compute a scenario
router.post('/:id/compute', async (req, res) => {
  const userId = (req as any).userId
  const { data: scenario, error } = await supabase
    .from('scenario').select('*, tax_entity(form_type)')
    .eq('id', req.params.id).eq('user_id', userId).single()

  if (error || !scenario) return res.status(404).json({ error: 'Scenario not found' })

  try {
    const adj = scenario.adjustments || {}
    const formType = scenario.tax_entity?.form_type || adj.form_type

    // Merge adjustments with base return's input_data (adjustments override)
    let baseInputs: Record<string, any> = {}
    if (scenario.base_return_id) {
      const { data: br } = await supabase.from('tax_return')
        .select('input_data').eq('id', scenario.base_return_id).single()
      if (br?.input_data) baseInputs = br.input_data
    }
    const mergedInputs: Record<string, any> = { ...baseInputs, ...adj }

    let result: any
    const merged: any = { ...mergedInputs, tax_year: mergedInputs.tax_year || scenario.tax_year }
    if (formType === '1120') {
      result = calc1120(merged)
    } else if (formType === '1120S') {
      result = calc1120S(merged)
    } else if (formType === '1040') {
      // Use the full calc1040 which handles SS taxability, SE, NIIT, AMT, etc.
      result = calc1040(merged)
    }

    // Get base return for comparison if available. Build the flat-metric
    // baseline from base_return.field_values via the per-form metric map —
    // computed_data.computed is no longer persisted (golden model = field_values).
    let baseComputed: Record<string, number> | null = null
    if (scenario.base_return_id) {
      const { data: baseReturn } = await supabase.from('tax_return')
        .select('field_values, form_type').eq('id', scenario.base_return_id).single()
      if (baseReturn?.field_values && baseReturn.form_type) {
        const { COMPARE_METRICS, readMetric } = await import('../maps/metric_to_field.js')
        const metrics: Record<string, number> = {}
        for (const m of COMPARE_METRICS) {
          const v = readMetric(baseReturn.field_values as any, baseReturn.form_type, m)
          if (v !== null) metrics[m] = v
        }
        baseComputed = metrics
      }
    }

    // Build field-by-field diff vs base
    const diff: Array<{ field: string; base: number; scenario: number; delta: number; pct_change: number }> = []
    if (baseComputed && result?.computed) {
      const allKeys = new Set([...Object.keys(baseComputed), ...Object.keys(result.computed)])
      for (const key of allKeys) {
        const b = typeof baseComputed[key] === 'number' ? baseComputed[key] : 0
        const s = typeof result.computed[key] === 'number' ? result.computed[key] : 0
        if (b !== s) {
          diff.push({
            field: key, base: b, scenario: s, delta: s - b,
            pct_change: b !== 0 ? Math.round(((s - b) / Math.abs(b)) * 10000) / 100 : 0,
          })
        }
      }
      diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    }

    // Identify which inputs changed vs base
    let inputChanges: Record<string, { from: any; to: any }> = {}
    for (const [k, v] of Object.entries(adj)) {
      if (baseInputs[k] !== v) inputChanges[k] = { from: baseInputs[k] ?? 0, to: v }
    }

    // Check what PDF fields would be missing
    const { getFieldMap } = await import('../maps/field_maps.js')
    const { getEngineToCanonicalMap } = await import('../maps/engine_to_pdf.js')
    const engineMap = getEngineToCanonicalMap(formType)
    const fieldMapEntries = getFieldMap(
      formType === '1120S' ? 'f1120s' : `f${formType.toLowerCase()}`,
      scenario.tax_year
    )
    const filledCanonKeys = new Set<string>()
    for (const [engineKey, value] of Object.entries({ ...mergedInputs, ...(result?.computed || {}) })) {
      const canon = engineMap[engineKey]
      if (canon && value !== undefined && value !== null) filledCanonKeys.add(canon)
    }
    const totalMapFields = fieldMapEntries.length
    const filledCount = filledCanonKeys.size
    const coveragePct = totalMapFields > 0 ? Math.round((filledCount / totalMapFields) * 100) : 0

    // Save result
    await supabase.from('scenario').update({
      computed_result: result, status: 'computed', updated_at: new Date().toISOString()
    }).eq('id', req.params.id)

    res.json({
      scenario_id: req.params.id,
      scenario_name: scenario.name,
      entity: scenario.tax_entity?.name || scenario.entity_id,
      form_type: formType,
      tax_year: scenario.tax_year,
      result,
      // What changed in this scenario
      input_changes: inputChanges,
      // How the computed output differs from the base return
      diff: diff.length > 0 ? diff : undefined,
      diff_summary: diff.length > 0 ? {
        tax_delta: diff.find(d => d.field === 'total_tax')?.delta || diff.find(d => d.field === 'income_tax')?.delta,
        balance_due_delta: diff.find(d => d.field === 'balance_due')?.delta,
        fields_changed: diff.length,
      } : undefined,
      // PDF readiness
      pdf_coverage: {
        filled: filledCount,
        total: totalMapFields,
        pct: coveragePct,
        note: coveragePct < 50 ? 'Many PDF fields will be blank — consider adding more inputs' : undefined,
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// AI analysis of a scenario
router.post('/:id/analyze', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const userId = (req as any).userId
  const { data: scenario } = await supabase
    .from('scenario').select('*, tax_entity(name, form_type, ein)')
    .eq('id', req.params.id).eq('user_id', userId).single()

  if (!scenario) return res.status(404).json({ error: 'Scenario not found' })

  // Get base return for comparison if available
  let baseReturn = null
  if (scenario.base_return_id) {
    const { data } = await supabase.from('tax_return')
      .select('*').eq('id', scenario.base_return_id).single()
    baseReturn = data
  }

  const genAI = new GoogleGenerativeAI(GEMINI_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview' })

  const prompt = `You are a tax advisor analyzing a tax scenario for ${scenario.tax_entity?.name || 'a taxpayer'} (${scenario.tax_entity?.form_type || 'unknown form'}).

Scenario: "${scenario.name}"
Description: ${scenario.description || 'No description'}
Tax Year: ${scenario.tax_year}

Adjustments from baseline:
${JSON.stringify(scenario.adjustments, null, 2)}

Computed result:
${JSON.stringify(scenario.computed_result, null, 2)}

${baseReturn ? `Base return (as-filed):
${JSON.stringify(baseReturn.computed_data, null, 2)}` : ''}

Provide a concise analysis covering:
1. Tax impact summary (how much saved or owed vs baseline)
2. Key risks or issues to flag
3. Alternative approaches worth considering
4. Compliance considerations

Keep it under 500 words. Use specific dollar amounts.`

  try {
    const result = await model.generateContent(prompt)
    const analysis = result.response.text()

    // Save analysis
    await supabase.from('scenario').update({
      ai_analysis: analysis, updated_at: new Date().toISOString()
    }).eq('id', req.params.id)

    res.json({ scenario_id: req.params.id, analysis })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Compare scenarios (1+) with optional AI analysis.
// Single-scenario mode folds in the old /:id/analyze tool.
router.post('/compare', async (req, res) => {
  const userId = (req as any).userId
  const { scenario_ids, include_analysis } = req.body

  if (!Array.isArray(scenario_ids) || scenario_ids.length < 1) {
    return res.status(400).json({ error: 'scenario_ids must be a non-empty array' })
  }

  const { data: scenarios } = await supabase
    .from('scenario').select('*, tax_entity(name, form_type)')
    .in('id', scenario_ids).eq('user_id', userId)

  if (!scenarios || scenarios.length === 0) {
    return res.status(404).json({ error: 'No scenarios found' })
  }

  // Build structured side-by-side — always available (no AI call needed)
  const summary = scenarios.map((s: any) => {
    const c = s.computed_result?.computed || {}
    return {
      id: s.id,
      name: s.name,
      entity: s.tax_entity?.name,
      tax_year: s.tax_year,
      adjustments: s.adjustments,
      total_tax: c.total_tax ?? c.income_tax ?? null,
      balance_due: c.balance_due ?? null,
      refund: c.refund ?? null,
      agi: c.agi ?? null,
      taxable_income: c.taxable_income ?? null,
    }
  })

  if (!include_analysis) {
    return res.json({
      scenarios: summary,
      note: 'Structured comparison only. Pass include_analysis=true to add AI recommendation.',
    })
  }

  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const genAI = new GoogleGenerativeAI(GEMINI_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview' })

  const prompt = scenarios.length === 1
    ? `You are a tax advisor analyzing a single tax scenario for ${scenarios[0].tax_entity?.name || 'a taxpayer'} (${scenarios[0].tax_entity?.form_type || 'unknown form'}).

Scenario: "${scenarios[0].name}"
Tax Year: ${scenarios[0].tax_year}
Adjustments: ${JSON.stringify(scenarios[0].adjustments, null, 2)}
Computed result: ${JSON.stringify(scenarios[0].computed_result, null, 2)}

Provide a concise analysis covering:
1. Tax impact summary
2. Key risks or issues to flag
3. Alternative approaches worth considering
4. Compliance considerations

Keep it under 500 words. Use specific dollar amounts.`
    : `Compare these ${scenarios.length} tax scenarios and recommend the best approach:

${scenarios.map((s: any, i: number) => `
--- Scenario ${i + 1}: "${s.name}" ---
Entity: ${s.tax_entity?.name || 'unknown'}
Year: ${s.tax_year}
Adjustments: ${JSON.stringify(s.adjustments)}
Result: ${JSON.stringify(s.computed_result)}
`).join('\n')}

Provide:
1. Side-by-side comparison table of key metrics
2. Recommended scenario and why
3. Combined household tax impact
4. Implementation steps for the recommended approach

Keep it under 600 words.`

  try {
    const result = await model.generateContent(prompt)
    const analysis = result.response.text()

    // Persist on single-scenario analyses (preserves the old /analyze behavior)
    if (scenarios.length === 1) {
      await supabase.from('scenario').update({
        ai_analysis: analysis, updated_at: new Date().toISOString(),
      }).eq('id', scenarios[0].id)
    }

    res.json({ scenarios: summary, analysis })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Promote scenario to a tax return
router.post('/:id/promote', async (req, res) => {
  const userId = (req as any).userId
  const { data: scenario } = await supabase
    .from('scenario').select('*, tax_entity(form_type)')
    .eq('id', req.params.id).eq('user_id', userId).single()

  if (!scenario) return res.status(404).json({ error: 'Scenario not found' })
  if (!scenario.computed_result) return res.status(400).json({ error: 'Scenario must be computed before promoting' })

  const formType = scenario.tax_entity?.form_type || scenario.adjustments?.form_type
  if (!formType) return res.status(400).json({ error: 'Cannot determine form_type for this scenario' })

  // supabase is the module-level client

  // Create tax_return from scenario
  const scRaw = { input_data: scenario.adjustments, computed_data: scenario.computed_result }
  const scEnc = await encryptedFields(supabase, userId, scRaw, ENCRYPTED_RETURN_FIELDS)
  const c = scenario.computed_result?.computed || {}
  const { data: taxReturn, error } = await supabase.from('tax_return').upsert({
    entity_id: scenario.entity_id,
    tax_year: scenario.tax_year,
    form_type: formType,
    status: 'computed',
    source: 'proforma',
    scenario_id: req.params.id,
    is_amended: false,
    ...scRaw,
    ...scEnc,
    agg_total_income:   c.total_income   ?? null,
    agg_taxable_income: c.taxable_income ?? null,
    agg_total_tax:      c.total_tax      ?? null,
    agg_agi:            c.agi            ?? null,
    computed_at: new Date().toISOString(),
    pdf_s3_path: null,
  }, { onConflict: 'entity_id,tax_year,form_type,is_amended' }).select().single()

  if (error) return res.status(500).json({ error: error.message })

  // Mark scenario as promoted
  await supabase.from('scenario').update({
    status: 'promoted', updated_at: new Date().toISOString(),
  }).eq('id', req.params.id)

  res.json({ scenario_id: req.params.id, return_id: taxReturn?.id, status: 'promoted' })
})

// Generate PDF preview for a scenario (without promoting)
router.get('/:id/pdf', async (req, res) => {
  const userId = (req as any).userId
  const { data: scenario } = await supabase
    .from('scenario').select('*, tax_entity(name, ein, address, city, state, zip, date_incorporated, meta, form_type)')
    .eq('id', req.params.id).eq('user_id', userId).single()

  if (!scenario) return res.status(404).json({ error: 'Scenario not found' })
  if (!scenario.computed_result) return res.status(400).json({ error: 'Scenario must be computed first' })

  const formType = scenario.tax_entity?.form_type || scenario.adjustments?.form_type
  if (!formType) return res.status(400).json({ error: 'Cannot determine form_type' })

  try {
    const { buildReturnPdf } = await import('../builders/build_return_pdf.js')
    const S3_BUCKET = process.env.S3_BUCKET || 'tax-api-storage-2026'

    const { pdf, filled, pages, forms } = await buildReturnPdf({
      formType,
      taxYear: scenario.tax_year,
      entity: scenario.tax_entity,
      inputData: scenario.adjustments,
      computedData: scenario.computed_result?.computed,
    })

    const pdfBytes = await pdf.save()
    const s3Key = `scenarios/${userId}/${scenario.id}.pdf`

    const { runPython } = await import('../lib/run_python.js')
    const { writeFileSync } = await import('fs')
    const tmpPath = `/tmp/scenario_${scenario.id}.pdf`
    writeFileSync(tmpPath, Buffer.from(pdfBytes))

    const uploadScript = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
s3.upload_file('${tmpPath}', '${S3_BUCKET}', '${s3Key}', ExtraArgs={'ContentType': 'application/pdf'})
url = s3.generate_presigned_url('get_object', Params={
    'Bucket': '${S3_BUCKET}', 'Key': '${s3Key}'
}, ExpiresIn=3600)
print(json.dumps({'url': url}))
`
    const result = runPython(uploadScript, { timeout: 30000 })
    const { url } = JSON.parse(result.trim())

    res.json({ url, filled, pages, forms, scenario_id: scenario.id, scenario_name: scenario.name })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
