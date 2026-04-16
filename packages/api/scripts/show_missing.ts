/**
 * Show PDF canonical keys that our proforma does NOT fill (per form)
 */
import { getEngineToCanonicalMap, getCanonicalAliases } from '../src/maps/engine_to_pdf.js'
import * as maps2024 from '../src/maps/pdf_field_map_2024.js'
import * as maps2025 from '../src/maps/pdf_field_map_2025.js'

const API = 'http://13.223.50.81:3737'
const KEY = 'txk_999fb6a457964ca0b66d556c'

async function get(path: string) {
  const r = await fetch(`${API}${path}`, { headers: { 'x-api-key': KEY } })
  return r.json()
}

function getPdfMap(formType: string) {
  const base = `F${formType.replace('-', '')}`
  for (const y of [2024, 2025]) {
    const m = (maps2025 as any)[`${base}_${y}`] || (maps2024 as any)[`${base}_${y}`]
    if (m && Object.keys(m).length > 0) return m
  }
  return {}
}

const targets = [
  { name: 'Edgewater Investments', return_id: '27acbe8c-4037-4474-b554-49f47b57227a', form_type: '1120S' },
  { name: 'Edgewater Ventures',    return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b', form_type: '1120'  },
]

async function main() {
  for (const t of targets) {
    const ret = await get(`/api/returns/${t.return_id}`)
    const r = ret.return
    const inputs: any = r.input_data || {}
    const computed: any = r.computed_data?.computed || {}
    const fv: any = r.field_values || {}

    const engineMap = getEngineToCanonicalMap(t.form_type)
    const aliases = getCanonicalAliases(t.form_type)

    const filled = new Set<string>()
    const add = (k: string) => {
      filled.add(k)
      if (engineMap[k]) filled.add(engineMap[k])
      if (aliases[k]) filled.add(aliases[k])
    }
    for (const k of Object.keys(inputs)) if (inputs[k] !== null) add(k)
    for (const k of Object.keys(computed)) if (computed[k] !== null) add(k)
    for (const k of Object.keys(fv)) if (fv[k] !== null) add(k)

    const pdfMap = getPdfMap(t.form_type)
    const missing = Object.keys(pdfMap).filter(k => !filled.has(k))

    console.log(`\n=== ${t.name} (${t.form_type}) — missing ${missing.length} of ${Object.keys(pdfMap).length} canonical keys ===`)
    const bySection: Record<string, string[]> = {}
    for (const k of missing) {
      const s = k.split('.')[0]
      if (!bySection[s]) bySection[s] = []
      bySection[s].push(k)
    }
    for (const [s, ks] of Object.entries(bySection).sort((a,b)=>b[1].length-a[1].length)) {
      console.log(`  [${s}] ${ks.length}:`)
      for (const k of ks) console.log(`    · ${k} → ${pdfMap[k]}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
