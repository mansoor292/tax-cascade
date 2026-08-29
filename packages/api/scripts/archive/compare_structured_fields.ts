/**
 * Filed vs proforma — at the STRUCTURED DATA LEVEL (tax_return model)
 *
 * Raw Textract KVs ≠ structured fields. KVs are loose key-value pairs
 * (1305 of them include every line detail, breakdown, label, etc.).
 * After mapToCanonical(), only the ones that match our canonical schema
 * become structured fields (input_data / field_values keys).
 *
 * This script maps both paths into the same structured-field schema so
 * we can compare apples to apples.
 */
import { mapToCanonical } from '../src/intake/json_model_mapper.js'
import { getFieldMap } from '../src/maps/field_maps.js'
import { getEngineToCanonicalMap, getCanonicalAliases } from '../src/maps/engine_to_pdf.js'
import * as maps2024 from '../src/maps/pdf_field_map_2024.js'
import * as maps2025 from '../src/maps/pdf_field_map_2025.js'

const API = 'http://13.223.50.81:3737'
const KEY = 'txk_999fb6a457964ca0b66d556c'

async function get(path: string) {
  const r = await fetch(`${API}${path}`, { headers: { 'x-api-key': KEY } })
  return r.json()
}

interface Pair {
  name: string
  form_type: '1040' | '1120' | '1120S'
  filed_doc_id: string
  proforma_return_id: string
}

const pairs: Pair[] = [
  { name: 'Mansoor & Ingrid',        form_type: '1040',  filed_doc_id: 'dbc7be0b-c7de-4fad-b87d-dcc97087e923', proforma_return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46' },
  { name: 'Edgewater Investments',   form_type: '1120S', filed_doc_id: 'd85ec574-cf54-491c-9894-184ff3f96c65', proforma_return_id: '27acbe8c-4037-4474-b554-49f47b57227a' },
  { name: 'Edgewater Ventures',      form_type: '1120',  filed_doc_id: '2c79e99d-c78a-4209-b638-60bcf1f9523c', proforma_return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b' },
]

function categorize(keys: string[]): Record<string, number> {
  const cats: Record<string, number> = {}
  for (const k of keys) {
    const prefix = k.split('.')[0]
    cats[prefix] = (cats[prefix] || 0) + 1
  }
  return cats
}

/** Return the canonical PDF field map for a form+year (TS map) and the
 *  raw JSON field map (Textract-discovered labels → PDF IDs). */
function getPdfCapacity(formType: string, year: number) {
  const base = `F${formType.replace('-', '')}`
  let canonMap: Record<string, string> = {}
  for (const y of [year, 2025, 2024]) {
    const m = (maps2025 as any)[`${base}_${y}`] || (maps2024 as any)[`${base}_${y}`]
    if (m && Object.keys(m).length > 0) { canonMap = m; break }
  }
  const formName = formType === '1120S' ? 'f1120s' : `f${formType.toLowerCase()}`
  const jsonEntries = getFieldMap(formName, year)
  return { canonMap, jsonEntries }
}

async function main() {
  for (const p of pairs) {
    const [doc, ret] = await Promise.all([
      get(`/api/documents/${p.filed_doc_id}`),
      get(`/api/returns/${p.proforma_return_id}`),
    ])
    const filedDoc = doc.document || doc
    const proforma = ret.return || ret
    const kvs = filedDoc?.textract_data?.kvs || []
    const inputs = proforma?.input_data || {}
    const computed = proforma?.computed_data?.computed || {}
    const fieldValues = proforma?.field_values || {}

    // Run filed Textract KVs + tables through the SAME canonical mapper used at intake
    const tables = filedDoc?.textract_data?.tables || []
    const mapped = mapToCanonical({
      source: 'textract',
      form_type: p.form_type === '1120S' ? '1120S' : p.form_type,
      tax_year: 2024,
      key_value_pairs: kvs.map((kv: any) => ({ key: kv.key, value: kv.value })),
      tables,
    })

    // Structured-field buckets for the FILED return (what the intake mapper produces)
    const filedCanonical = Object.keys(mapped.model || {})
    const filedMapped = mapped.fields || []
    const filedUnmapped = mapped.unmapped || []

    // Structured-field buckets for the PROFORMA (what we stored)
    const proformaInputKeys = Object.keys(inputs).filter(k => {
      const v = inputs[k]
      return v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && v === 0)
    })
    const proformaComputedKeys = Object.keys(computed).filter(k => computed[k] !== 0 && computed[k] !== null)
    const proformaFvKeys = Object.keys(fieldValues).filter(k => fieldValues[k] !== 0 && fieldValues[k] !== null)

    // IRS PDF capacity
    const { canonMap, jsonEntries } = getPdfCapacity(p.form_type, 2024)
    const pdfCanonKeys = Object.keys(canonMap)
    const pdfRawFillable = jsonEntries.length

    console.log(`\n${'═'.repeat(76)}`)
    console.log(`${p.name}  —  ${p.form_type}  —  2024`)
    console.log(`${'═'.repeat(76)}`)

    console.log(`\n┌─ Filed return (Textract extraction from uploaded PDF) ──`)
    console.log(`│  Raw Textract KVs extracted:        ${kvs.length}`)
    console.log(`│  After canonical mapper:`)
    console.log(`│     canonical keys produced:        ${filedCanonical.length}`)
    console.log(`│     Textract KVs successfully mapped: ${filedMapped.length}`)
    console.log(`│     Textract KVs unmapped (noise):  ${filedUnmapped.length}`)
    console.log(`│  Structured total:                  ${filedCanonical.length}`)

    console.log(`\n┌─ Proforma return (compute + QBO) ───────────────`)
    console.log(`│  input_data keys:                   ${proformaInputKeys.length}`)
    console.log(`│  computed_data.computed keys:       ${proformaComputedKeys.length}`)
    console.log(`│  field_values keys:                 ${proformaFvKeys.length}`)
    const proformaTotal = new Set([...proformaInputKeys, ...proformaComputedKeys, ...proformaFvKeys]).size
    console.log(`│  Unique structured total:           ${proformaTotal}`)

    console.log(`\n┌─ IRS PDF capacity (the output ceiling) ─────────`)
    console.log(`│  Total fillable fields on blank PDF:  ${pdfRawFillable}`)
    console.log(`│  Canonical keys in our TS map:      ${pdfCanonKeys.length}`)
    console.log(`│  (unmapped = form fields we can't fill yet)`)

    // Calculate REAL fill rates — apply engine→canonical map and aliases
    // (same normalizations buildModel applies at PDF-generation time)
    const engineMap = getEngineToCanonicalMap(p.form_type)
    const aliases = getCanonicalAliases(p.form_type)

    const normalize = (keys: string[]): Set<string> => {
      const out = new Set<string>()
      for (const k of keys) {
        out.add(k)                                // original
        if (engineMap[k]) out.add(engineMap[k])   // engine → canonical
        if (aliases[k])   out.add(aliases[k])     // Textract-alias → IRS-line
      }
      return out
    }

    const proformaNormalized = normalize([...proformaInputKeys, ...proformaComputedKeys, ...proformaFvKeys])
    const filedNormalized = normalize(filedCanonical)

    const proformaFills = pdfCanonKeys.filter(k => proformaNormalized.has(k)).length
    const filedFills = pdfCanonKeys.filter(k => filedNormalized.has(k)).length

    console.log(`\n  Of the ${pdfCanonKeys.length} canonical keys on the blank PDF (after alias normalization):`)
    console.log(`    filled by filed return:      ${filedFills}  (${Math.round(filedFills/pdfCanonKeys.length*100)}%)`)
    console.log(`    filled by proforma return:   ${proformaFills}  (${Math.round(proformaFills/pdfCanonKeys.length*100)}%)`)

    // Section breakdown — now with 3 columns
    console.log(`\n  Section breakdown:`)
    const filedCats = categorize(filedCanonical)
    const proformaCats = categorize([...proformaInputKeys, ...proformaComputedKeys, ...proformaFvKeys])
    const pdfCats = categorize(pdfCanonKeys)
    const allCats = new Set([...Object.keys(filedCats), ...Object.keys(proformaCats), ...Object.keys(pdfCats)])
    console.log(`    ${'Section'.padEnd(22)} ${'Filed'.padStart(7)} ${'Proforma'.padStart(9)} ${'IRS PDF'.padStart(9)}`)
    for (const cat of [...allCats].sort()) {
      const f = filedCats[cat] || 0
      const pf = proformaCats[cat] || 0
      const pdf = pdfCats[cat] || 0
      console.log(`    ${cat.padEnd(22)} ${String(f).padStart(7)} ${String(pf).padStart(9)} ${String(pdf).padStart(9)}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
