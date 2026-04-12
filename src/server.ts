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
import { calc1120, calc1120S, calc1040, calcCascade } from './engine/tax_engine.js'
import {
  ordinaryTax, ltcgTax, niitTax, qbiDeduction, standardDeduction, TAX_TABLES
} from './engine/tax_tables.js'
import { FORM_INVENTORY } from './maps/field_maps.js'

const app = express()
app.use(express.json({ limit: '10mb' }))

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
    const { readFileSync } = require('fs')
    const path = `data/field_maps/${req.params.form}_${req.params.year}_fields.json`
    const map = JSON.parse(readFileSync(path, 'utf-8'))
    res.json({ form: req.params.form, year: req.params.year, fields: map })
  } catch {
    res.status(404).json({ error: 'Field map not found' })
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
