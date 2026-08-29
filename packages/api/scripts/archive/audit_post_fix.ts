/**
 * Post-fix audit: simulates the full buildModel pipeline locally with all fixes applied:
 *   - Canonical key aliases (field_values → PDF keys)
 *   - New calc1040/calc1120 engine outputs
 *   - Entity metadata injection
 *
 * Shows before → after coverage for each return.
 */
import { calc1120, calc1120S, calc1040 } from '../src/engine/tax_engine.js'
import { getEngineToCanonicalMap, getCanonicalAliases } from '../src/maps/engine_to_pdf.js'
import * as maps2024 from '../src/maps/pdf_field_map_2024.js'
import * as maps2025 from '../src/maps/pdf_field_map_2025.js'

const API_BASE = 'http://13.223.50.81:3737'
const API_KEY = 'txk_999fb6a457964ca0b66d556c'

async function fetchReturn(id: string) {
  const r = await fetch(`${API_BASE}/api/returns/${id}`, { headers: { 'x-api-key': API_KEY } })
  return (await r.json()).return
}
async function fetchEntity(id: string) {
  const r = await fetch(`${API_BASE}/api/entities/${id}`, { headers: { 'x-api-key': API_KEY } })
  return (await r.json()).entity
}

const targets = [
  { name: 'Edgewater AI, Inc',         return_id: '85f9ad1b-d705-44db-9da5-fed092ef8d4e', form_type: '1120',  entity_id: '7182b3e4-1b24-4756-8a6b-20d2cc54f59f' },
  { name: 'Edgewater Investments Inc', return_id: '27acbe8c-4037-4474-b554-49f47b57227a', form_type: '1120S', entity_id: 'fc3589ea-8b79-4c4b-b843-79dc241a007a' },
  { name: 'Edgewater Ventures Inc',    return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b', form_type: '1120',  entity_id: '463be538-88c1-4a1d-8ddb-60d5201a0315' },
  { name: 'Mansoor & Ingrid Razzaq',   return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46', form_type: '1040',  entity_id: 'c256eac9-bb9b-4cf3-af6c-f88fa6cc08f6' },
]

function getPdfMap(formType: string, year: number): Record<string, string> {
  const base = `F${formType.replace('-', '')}`
  for (const y of [year, 2025, 2024]) {
    const map = (maps2025 as any)[`${base}_${y}`] || (maps2024 as any)[`${base}_${y}`]
    if (map && Object.keys(map).length > 0) return map
  }
  return {}
}

function runEngine(formType: string, inputs: any) {
  if (formType === '1120')  return calc1120({ ...inputs, tax_year: inputs.tax_year || 2024 })
  if (formType === '1120S') return calc1120S(inputs)
  if (formType === '1040')  return calc1040({ ...inputs, tax_year: inputs.tax_year || 2024 })
  throw new Error(`unsupported: ${formType}`)
}

/** Mirrors buildModel() exactly so we can measure coverage locally */
function buildModel(formType: string, entity: any, inputs: any, computed: any, fieldValues: Record<string, any>): Record<string, any> {
  const model: Record<string, any> = {}
  const engineMap = getEngineToCanonicalMap(formType)
  const aliases = getCanonicalAliases(formType)

  // 1+2. Engine inputs/computed → canonical keys
  for (const [k, v] of Object.entries({ ...inputs, ...computed })) {
    if (v === undefined || v === null) continue
    const canon = engineMap[k]
    if (canon) model[canon] = v
  }

  // 3. Field_values with alias normalization
  for (const [k, v] of Object.entries(fieldValues || {})) {
    if (v === undefined || v === null) continue
    model[k] = v  // original key
    const aliased = aliases[k]
    if (aliased) model[aliased] = v
  }

  // 4. Entity metadata
  if (formType === '1040') {
    if (entity.meta?.first_name) model['meta.first_name'] = entity.meta.first_name
    if (entity.meta?.last_name) model['meta.last_name'] = entity.meta.last_name
    if (entity.ein) model['meta.ssn'] = entity.ein
    if (entity.meta?.spouse_first) model['meta.spouse_first'] = entity.meta.spouse_first
    if (entity.meta?.spouse_last) model['meta.spouse_last'] = entity.meta.spouse_last
    if (entity.meta?.spouse_ssn) model['meta.spouse_ssn'] = entity.meta.spouse_ssn
    if (entity.address) model['meta.address'] = entity.address
    if (entity.city) model['meta.city'] = entity.city
    if (entity.state) model['meta.state'] = entity.state
    if (entity.zip) model['meta.zip'] = entity.zip
  } else {
    model['meta.entity_name'] = entity.name || ''
    model['meta.ein'] = entity.ein || ''
    model['meta.address'] = entity.address || ''
    if (entity.city) model['meta.city'] = entity.city
    if (entity.state) model['meta.state'] = entity.state
    if (entity.zip) model['meta.zip'] = entity.zip
    if (entity.city || entity.state || entity.zip)
      model['meta.city_state_zip'] = [entity.city, entity.state, entity.zip].filter(Boolean).join(', ')
    if (entity.date_incorporated) model['meta.date_incorporated'] = entity.date_incorporated
  }
  if (entity.meta?.business_activity) model['meta.business_activity'] = entity.meta.business_activity
  if (entity.meta?.business_code) model['meta.business_activity_code'] = entity.meta.business_code
  if (entity.meta?.s_election_date) model['meta.s_election_date'] = entity.meta.s_election_date
  if (entity.meta?.total_assets) model['meta.total_assets'] = entity.meta.total_assets
  if (entity.meta?.num_shareholders) model['meta.num_shareholders'] = entity.meta.num_shareholders

  return model
}

async function main() {
  console.log('\n' + '═'.repeat(78))
  console.log('COVERAGE AUDIT — Before vs After Fixes')
  console.log('═'.repeat(78))

  const rows: Array<[string, string, number, number, number, number]> = []

  for (const t of targets) {
    const [ret, entity] = await Promise.all([fetchReturn(t.return_id), fetchEntity(t.entity_id)])
    const inputs = ret.input_data || {}
    const savedComputed = ret.computed_data?.computed || {}
    const fieldValues = ret.field_values || {}

    // BEFORE: just the saved data + engine map (no aliases, no entity metadata mirrored)
    const beforeModel = new Set<string>()
    const engineMap = getEngineToCanonicalMap(t.form_type)
    for (const [k, v] of Object.entries({ ...inputs, ...savedComputed })) {
      if (v !== undefined && v !== null) {
        const canon = engineMap[k]
        if (canon) beforeModel.add(canon)
      }
    }
    for (const k of Object.keys(fieldValues)) {
      if (fieldValues[k] !== undefined && fieldValues[k] !== null && fieldValues[k] !== 0) {
        beforeModel.add(k)
      }
    }

    // AFTER: run new engine + apply aliases + inject entity metadata
    const freshResult = runEngine(t.form_type, inputs)
    const freshComputed = freshResult.computed || {}
    const afterModel = buildModel(t.form_type, entity, inputs, freshComputed, fieldValues)

    const pdfMap = getPdfMap(t.form_type, ret.tax_year)
    const pdfKeys = new Set(Object.keys(pdfMap))

    const beforeFilled = [...beforeModel].filter(k => pdfKeys.has(k)).length
    const afterFilled = Object.keys(afterModel).filter(k => pdfKeys.has(k)).length
    const total = pdfKeys.size
    const beforePct = Math.round(beforeFilled / total * 100)
    const afterPct = Math.round(afterFilled / total * 100)

    rows.push([t.name, t.form_type, beforeFilled, afterFilled, total, afterPct - beforePct])
  }

  // Print summary table
  console.log('')
  const nameW = 36, typeW = 6
  console.log(
    'Entity'.padEnd(nameW) + '  ' +
    'Form'.padEnd(typeW) + '  ' +
    'Before'.padStart(8) + '  ' +
    'After'.padStart(8) + '  ' +
    'Total'.padStart(6) + '  ' +
    'Delta'.padStart(8)
  )
  console.log('─'.repeat(78))
  for (const [name, form, before, after, total, delta] of rows) {
    const beforePct = Math.round(before / total * 100)
    const afterPct = Math.round(after / total * 100)
    console.log(
      name.padEnd(nameW) + '  ' +
      form.padEnd(typeW) + '  ' +
      `${before}/${total} (${beforePct}%)`.padStart(8) + '  ' +
      `${after}/${total} (${afterPct}%)`.padStart(8) + '  ' +
      '        ' +
      `${delta > 0 ? '+' : ''}${afterPct - beforePct}pp`.padStart(8)
    )
  }

  console.log('\n' + '─'.repeat(78))
  console.log('Fixes applied in this run:')
  console.log('  ✓ canonical alias map (field_values: descriptive → IRS-line keys)')
  console.log('  ✓ new calc1040 (SS taxability, SE, AMT, NIIT, CTC, Additional Medicare)')
  console.log('  ✓ new calc1120 (DRD, credits)')
  console.log('  ✓ entity metadata injection (name, EIN, address for all form types)')
  console.log('  ✗ NOT YET: QBO Schedule L auto-pull (requires recompute with QBO connection)')
  console.log('  ✗ NOT YET: Schedule K population for 1120-S')
  console.log('  ✗ NOT YET: Preparer info on entities')
}

main().catch(e => { console.error(e); process.exit(1) })
