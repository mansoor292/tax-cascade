/**
 * Full-field audit for 2024 returns: input → output → missing
 *
 * For each return, shows:
 *   [IN]   every input field with a value
 *   [OUT]  every computed field
 *   [FV]   field_values (schedule data passed through to PDF)
 *   [MISS] PDF canonical keys that have no data
 */
import { calc1120, calc1120S, calc1040 } from '../src/engine/tax_engine.js'
import { getEngineToCanonicalMap } from '../src/maps/engine_to_pdf.js'
import * as maps2024 from '../src/maps/pdf_field_map_2024.js'
import * as maps2025 from '../src/maps/pdf_field_map_2025.js'

const API_BASE = 'http://13.223.50.81:3737'
const API_KEY = 'txk_999fb6a457964ca0b66d556c'

async function fetchReturn(id: string) {
  const r = await fetch(`${API_BASE}/api/returns/${id}`, { headers: { 'x-api-key': API_KEY } })
  return (await r.json()).return
}

interface Target {
  name: string
  return_id: string
  form_type: '1120' | '1120S' | '1040'
}

const targets: Target[] = [
  { name: 'Edgewater AI, Inc',         return_id: '85f9ad1b-d705-44db-9da5-fed092ef8d4e', form_type: '1120' },
  { name: 'Edgewater Investments Inc', return_id: '27acbe8c-4037-4474-b554-49f47b57227a', form_type: '1120S' },
  { name: 'Edgewater Ventures Inc',    return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b', form_type: '1120' },
  { name: 'Mansoor & Ingrid Razzaq',   return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46', form_type: '1040' },
]

function runEngine(formType: string, inputs: any) {
  if (formType === '1120')  return calc1120({ ...inputs, tax_year: inputs.tax_year || 2024 })
  if (formType === '1120S') return calc1120S(inputs)
  if (formType === '1040')  return calc1040({ ...inputs, tax_year: inputs.tax_year || 2024 })
  throw new Error(`unsupported: ${formType}`)
}

function getPdfMap(formType: string, year: number): Record<string, string> {
  const base = `F${formType.replace('-', '')}`
  for (const y of [year, 2025, 2024]) {
    const map = (maps2025 as any)[`${base}_${y}`] || (maps2024 as any)[`${base}_${y}`]
    if (map && Object.keys(map).length > 0) return map
  }
  return {}
}

function fmt(v: any): string {
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'boolean') return v.toString()
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60)
  return String(v)
}

function classifySection(canonKey: string): string {
  const prefix = canonKey.split('.')[0]
  return prefix
}

async function main() {
  for (const t of targets) {
    const ret = await fetchReturn(t.return_id)
    const inputs: Record<string, any> = ret.input_data || {}
    const savedComputed: Record<string, any> = ret.computed_data?.computed || {}
    const fieldValues: Record<string, any> = ret.field_values || {}

    // Run the current engine to see what it would produce now
    const freshResult = runEngine(t.form_type, inputs)
    const freshComputed = freshResult.computed || {}

    // Build the canonical model (engine outputs mapped to PDF canonical keys)
    const engineMap = getEngineToCanonicalMap(t.form_type)
    const modelKeys = new Set<string>()
    for (const [k, v] of Object.entries({ ...inputs, ...freshComputed })) {
      if (v === undefined || v === null) continue
      const canon = engineMap[k]
      if (canon) modelKeys.add(canon)
    }
    // Schedule field_values are already canonical-keyed
    for (const k of Object.keys(fieldValues)) {
      if (fieldValues[k] !== undefined && fieldValues[k] !== null && fieldValues[k] !== 0) {
        modelKeys.add(k)
      }
    }

    // PDF field map (canonical → field_id)
    const pdfMap = getPdfMap(t.form_type, ret.tax_year)
    const pdfCanonKeys = new Set(Object.keys(pdfMap))

    // Missing = PDF has the field but we don't have data for it
    const missing = [...pdfCanonKeys].filter(k => !modelKeys.has(k))
    const filled = [...modelKeys].filter(k => pdfCanonKeys.has(k))
    const orphans = [...modelKeys].filter(k => !pdfCanonKeys.has(k))

    console.log(`\n${'═'.repeat(78)}`)
    console.log(`${t.name}  —  Form ${t.form_type}  —  TY ${ret.tax_year}`)
    console.log(`${'═'.repeat(78)}`)

    // ── INPUTS ────────────────────────────────────────────────
    console.log(`\n[IN]  Inputs provided (${Object.keys(inputs).length} fields):`)
    const inputKeys = Object.keys(inputs).filter(k => {
      const v = inputs[k]
      return v !== undefined && v !== null && v !== 0 && v !== '' &&
             !(Array.isArray(v) && v.length === 0)
    }).sort()
    if (inputKeys.length === 0) {
      console.log(`  (none — this return has no input data)`)
    } else {
      const maxLen = Math.max(...inputKeys.map(k => k.length))
      for (const k of inputKeys) {
        console.log(`  ${k.padEnd(maxLen)}  ${fmt(inputs[k])}`)
      }
    }

    // ── OUTPUTS ───────────────────────────────────────────────
    console.log(`\n[OUT] Computed by current engine (${Object.keys(freshComputed).length} fields):`)
    const outKeys = Object.keys(freshComputed).sort()
    if (outKeys.length > 0) {
      const maxLen = Math.max(...outKeys.map(k => k.length))
      for (const k of outKeys) {
        const v = freshComputed[k]
        if (typeof v === 'number' && v === 0) continue  // skip zeros for clarity
        const savedVal = savedComputed[k]
        const drift = (typeof v === 'number' && typeof savedVal === 'number' && v !== savedVal)
          ? `  (DB: ${fmt(savedVal)})` : ''
        console.log(`  ${k.padEnd(maxLen)}  ${fmt(v).padStart(14)}${drift}`)
      }
    }

    // ── FIELD_VALUES (schedules) ──────────────────────────────
    const fvKeys = Object.keys(fieldValues).filter(k => fieldValues[k] !== 0)
    console.log(`\n[FV]  Schedule field_values (${fvKeys.length} canonical keys):`)
    if (fvKeys.length === 0) {
      console.log(`  (none — schedule L/M-1/M-2 not populated)`)
    } else {
      const bySection: Record<string, string[]> = {}
      for (const k of fvKeys) {
        const sec = classifySection(k)
        if (!bySection[sec]) bySection[sec] = []
        bySection[sec].push(k)
      }
      for (const [sec, keys] of Object.entries(bySection)) {
        console.log(`  ${sec}: ${keys.length} fields`)
      }
    }

    // ── COVERAGE ──────────────────────────────────────────────
    const coveragePct = pdfCanonKeys.size > 0
      ? Math.round((filled.length / pdfCanonKeys.size) * 100) : 0
    console.log(`\n[COV] PDF coverage: ${filled.length} / ${pdfCanonKeys.size} canonical keys filled (${coveragePct}%)`)

    // ── MISSING (what the PDF wants but we don't produce) ─────
    console.log(`\n[MISS] PDF fields with no data (${missing.length}):`)
    const missBySection: Record<string, string[]> = {}
    for (const k of missing) {
      const sec = classifySection(k)
      if (!missBySection[sec]) missBySection[sec] = []
      missBySection[sec].push(k)
    }
    for (const [sec, keys] of Object.entries(missBySection).sort()) {
      console.log(`  ${sec} (${keys.length}):`)
      // Show first 5 per section to avoid overwhelming
      const shown = keys.slice(0, 5)
      for (const k of shown) console.log(`    · ${k}`)
      if (keys.length > 5) console.log(`    … and ${keys.length - 5} more`)
    }

    // ── ORPHANS (engine outputs we don't map to PDF) ──────────
    if (orphans.length > 0) {
      console.log(`\n[ORPHAN] Engine outputs with no PDF mapping (${orphans.length}):`)
      for (const k of orphans.slice(0, 10)) console.log(`  · ${k}`)
    }
  }

  console.log(`\n${'═'.repeat(78)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
