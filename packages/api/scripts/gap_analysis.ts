/**
 * Generate a per-form gap analysis: which canonical keys in the PDF map
 * are NOT filled by either filed return or proforma return?
 *
 * Output: plan.md-style checklist grouped by section, with priority.
 */
import { mapToCanonical } from '../src/intake/json_model_mapper.js'
import { getEngineToCanonicalMap, getCanonicalAliases } from '../src/maps/engine_to_pdf.js'
import * as maps2024 from '../src/maps/pdf_field_map_2024.js'
import * as maps2025 from '../src/maps/pdf_field_map_2025.js'

const API = 'http://13.223.50.81:3737'
const KEY = 'txk_999fb6a457964ca0b66d556c'

async function get(path: string) {
  const r = await fetch(`${API}${path}`, { headers: { 'x-api-key': KEY } })
  return r.json()
}

const pairs = [
  { name: '1040 (Mansoor & Ingrid)',     form_type: '1040',  filed_doc_id: 'dbc7be0b-c7de-4fad-b87d-dcc97087e923', proforma_return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46' },
  { name: '1120S (Edgewater Investments)', form_type: '1120S', filed_doc_id: 'd85ec574-cf54-491c-9894-184ff3f96c65', proforma_return_id: '27acbe8c-4037-4474-b554-49f47b57227a' },
  { name: '1120 (Edgewater Ventures)',   form_type: '1120',  filed_doc_id: '2c79e99d-c78a-4209-b638-60bcf1f9523c', proforma_return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b' },
]

function getPdfMap(formType: string) {
  const base = `F${formType.replace('-', '')}`
  for (const y of [2024, 2025]) {
    const m = (maps2025 as any)[`${base}_${y}`] || (maps2024 as any)[`${base}_${y}`]
    if (m && Object.keys(m).length > 0) return m
  }
  return {}
}

async function main() {
  for (const p of pairs) {
    const [doc, ret] = await Promise.all([
      get(`/api/documents/${p.filed_doc_id}`),
      get(`/api/returns/${p.proforma_return_id}`),
    ])
    const kvs = (doc.document || doc)?.textract_data?.kvs || []
    const proforma = ret.return || ret
    const inputs = proforma.input_data || {}
    const computed = proforma.computed_data?.computed || {}
    const fieldValues = proforma.field_values || {}

    const mapped = mapToCanonical({
      source: 'textract',
      form_type: p.form_type === '1120S' ? '1120S' : p.form_type,
      tax_year: 2024,
      key_value_pairs: kvs.map((kv: any) => ({ key: kv.key, value: kv.value })),
      tables: (doc.document || doc)?.textract_data?.tables || [],
    })

    const engineMap = getEngineToCanonicalMap(p.form_type)
    const aliases = getCanonicalAliases(p.form_type)
    const normalize = (keys: string[]): Set<string> => {
      const out = new Set<string>()
      for (const k of keys) {
        out.add(k)
        if (engineMap[k]) out.add(engineMap[k])
        if (aliases[k]) out.add(aliases[k])
      }
      return out
    }

    // Zero is a valid value — "no capital gains" still means the line is filled with 0
    const proformaFilled = normalize([
      ...Object.keys(inputs).filter(k => inputs[k] !== null && inputs[k] !== undefined && inputs[k] !== ''),
      ...Object.keys(computed).filter(k => computed[k] !== null && computed[k] !== undefined),
      ...Object.keys(fieldValues).filter(k => fieldValues[k] !== null && fieldValues[k] !== undefined),
    ])
    const filedFilled = normalize(Object.keys(mapped.model || {}))

    const pdfMap = getPdfMap(p.form_type)
    const pdfKeys = Object.keys(pdfMap)

    // Categorize missing
    const gaps: Record<string, { both: string[]; filedOnly: string[]; proformaOnly: string[] }> = {}
    for (const k of pdfKeys) {
      const section = k.split('.')[0]
      if (!gaps[section]) gaps[section] = { both: [], filedOnly: [], proformaOnly: [] }
      const inFiled = filedFilled.has(k)
      const inProforma = proformaFilled.has(k)
      if (!inFiled && !inProforma) gaps[section].both.push(k)
      else if (!inFiled) gaps[section].filedOnly.push(k)  // missing from filed capture
      else if (!inProforma) gaps[section].proformaOnly.push(k)  // missing from compute
    }

    console.log(`\n${'═'.repeat(70)}`)
    console.log(`${p.name}`)
    console.log(`${'═'.repeat(70)}`)
    let bothCount = 0, filedOnlyCount = 0, proformaOnlyCount = 0
    for (const [sec, g] of Object.entries(gaps)) {
      bothCount += g.both.length
      filedOnlyCount += g.filedOnly.length
      proformaOnlyCount += g.proformaOnly.length
    }
    console.log(`Total PDF canonical keys: ${pdfKeys.length}`)
    console.log(`  Missing from BOTH capture & compute: ${bothCount}`)
    console.log(`  Missing from capture only:           ${filedOnlyCount}`)
    console.log(`  Missing from compute only:           ${proformaOnlyCount}`)

    // Show sections with gaps, sorted by # missing from both
    const sortedSections = Object.entries(gaps)
      .filter(([_, g]) => g.both.length + g.filedOnly.length + g.proformaOnly.length > 0)
      .sort((a, b) => (b[1].both.length + b[1].proformaOnly.length) - (a[1].both.length + a[1].proformaOnly.length))

    for (const [sec, g] of sortedSections) {
      const total = g.both.length + g.filedOnly.length + g.proformaOnly.length
      if (total === 0) continue
      console.log(`\n  [${sec}] ${total} gaps:`)
      if (g.both.length > 0) {
        console.log(`    ▾ missing everywhere (${g.both.length}):`)
        for (const k of g.both.slice(0, 10)) console.log(`        · ${k}`)
        if (g.both.length > 10) console.log(`        … +${g.both.length - 10} more`)
      }
      if (g.proformaOnly.length > 0) {
        console.log(`    ▾ filed has, proforma missing (${g.proformaOnly.length}):`)
        for (const k of g.proformaOnly.slice(0, 5)) console.log(`        · ${k}`)
        if (g.proformaOnly.length > 5) console.log(`        … +${g.proformaOnly.length - 5} more`)
      }
      if (g.filedOnly.length > 0) {
        console.log(`    ▾ proforma has, filed missing (${g.filedOnly.length}):`)
        for (const k of g.filedOnly.slice(0, 3)) console.log(`        · ${k}`)
        if (g.filedOnly.length > 3) console.log(`        … +${g.filedOnly.length - 3} more`)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
