/**
 * Scenario routes — Create, compute, and AI-analyze tax scenarios
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { calc1120, calc1120S, calc1040 } from '../engine/tax_engine.js'
import { ordinaryTax, qbiDeduction, niitTax, standardDeduction } from '../engine/tax_tables.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'

function sb(req: Request) {
  const token = req.headers.authorization?.replace('Bearer ', '') || ''
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  })
}

const router = Router()
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

// List scenarios
router.get('/', async (req, res) => {
  const userId = (req as any).userId
  const { data, error } = await sb(req)
    .from('scenario').select('*, tax_entity(name, form_type)')
    .eq('user_id', userId).order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ scenarios: data })
})

// Create scenario
router.post('/', async (req, res) => {
  const userId = (req as any).userId
  const { name, description, entity_id, tax_year, base_return_id, adjustments } = req.body

  const { data, error } = await sb(req).from('scenario').insert({
    user_id: userId, name, description, entity_id, tax_year,
    base_return_id, adjustments: adjustments || {},
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ scenario: data })
})

// Compute a scenario
router.post('/:id/compute', async (req, res) => {
  const userId = (req as any).userId
  const { data: scenario, error } = await sb(req)
    .from('scenario').select('*, tax_entity(form_type)')
    .eq('id', req.params.id).eq('user_id', userId).single()

  if (error || !scenario) return res.status(404).json({ error: 'Scenario not found' })

  try {
    const adj = scenario.adjustments
    const formType = scenario.tax_entity?.form_type || adj.form_type

    let result: any
    if (formType === '1120') {
      result = calc1120(adj)
    } else if (formType === '1120S') {
      result = calc1120S(adj)
    } else if (formType === '1040') {
      // Build 1040 computation from adjustments
      const wages = adj.wages || 0
      const k1 = adj.k1_ordinary || 0
      const interest = adj.interest || 0
      const dividends = adj.dividends || 0
      const capGains = adj.capital_gains || 0
      const totalIncome = wages + k1 + interest + dividends + capGains
      const agi = totalIncome
      const stdDed = standardDeduction(adj.filing_status || 'mfj', adj.tax_year || scenario.tax_year)
      const qbi = qbiDeduction(k1, adj.k1_w2_wages || 0, 0, Math.max(0, agi - stdDed), adj.filing_status || 'mfj', adj.tax_year || scenario.tax_year)
      const taxable = Math.max(0, agi - stdDed - qbi)
      const incomeTax = ordinaryTax(taxable, adj.filing_status || 'mfj', adj.tax_year || scenario.tax_year)
      const addlMedicare = Math.round(Math.max(0, wages - 250000) * 0.009)
      const niit = niitTax(interest + dividends, agi, adj.filing_status || 'mfj', adj.tax_year || scenario.tax_year)
      const totalTax = incomeTax + addlMedicare + niit
      const payments = (adj.withholding || 0) + (adj.estimated_payments || 0)

      result = {
        computed: {
          total_income: totalIncome, agi, standard_deduction: stdDed,
          qbi_deduction: qbi, taxable_income: taxable,
          income_tax: incomeTax, additional_medicare: addlMedicare, niit,
          total_tax: totalTax, total_payments: payments,
          balance_due: Math.max(0, totalTax - payments),
          refund: Math.max(0, payments - totalTax),
        }
      }
    }

    // Save result
    await sb(req).from('scenario').update({
      computed_result: result, status: 'computed', updated_at: new Date().toISOString()
    }).eq('id', req.params.id)

    res.json({ scenario_id: req.params.id, result })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// AI analysis of a scenario
router.post('/:id/analyze', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const userId = (req as any).userId
  const { data: scenario } = await sb(req)
    .from('scenario').select('*, tax_entity(name, form_type, ein)')
    .eq('id', req.params.id).eq('user_id', userId).single()

  if (!scenario) return res.status(404).json({ error: 'Scenario not found' })

  // Get base return for comparison if available
  let baseReturn = null
  if (scenario.base_return_id) {
    const { data } = await sb(req).from('tax_return')
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
    await sb(req).from('scenario').update({
      ai_analysis: analysis, updated_at: new Date().toISOString()
    }).eq('id', req.params.id)

    res.json({ scenario_id: req.params.id, analysis })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Compare two scenarios
router.post('/compare', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const userId = (req as any).userId
  const { scenario_ids } = req.body

  const { data: scenarios } = await sb(req)
    .from('scenario').select('*, tax_entity(name)')
    .in('id', scenario_ids).eq('user_id', userId)

  if (!scenarios || scenarios.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 scenarios to compare' })
  }

  const genAI = new GoogleGenerativeAI(GEMINI_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview' })

  const prompt = `Compare these ${scenarios.length} tax scenarios and recommend the best approach:

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
    res.json({ comparison: result.response.text(), scenarios: scenarios.map((s: any) => ({ id: s.id, name: s.name })) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
