/**
 * Real coverage: % of PDF canonical keys we actually fill (zeros count)
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
  { name: 'Edgewater AI',         return_id: '85f9ad1b-d705-44db-9da5-fed092ef8d4e', form_type: '1120'  },
  { name: 'Edgewater Investments', return_id: '27acbe8c-4037-4474-b554-49f47b57227a', form_type: '1120S' },
  { name: 'Edgewater Ventures',   return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b', form_type: '1120'  },
  { name: 'Mansoor & Ingrid',     return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46', form_type: '1040'  },
]

async function main() {
  console.log(`\n${'═'.repeat(72)}`)
  console.log('REAL COVERAGE — zeros counted, aliases applied')
  console.log(`${'═'.repeat(72)}`)
  console.log(`${'Entity'.padEnd(28)}${'Form'.padEnd(8)}${'Filled'.padStart(12)}${'Total'.padStart(8)}${'%'.padStart(8)}`)
  console.log('─'.repeat(72))

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

    for (const k of Object.keys(inputs)) if (inputs[k] !== null && inputs[k] !== undefined && inputs[k] !== '') add(k)
    for (const k of Object.keys(computed)) if (computed[k] !== null && computed[k] !== undefined) add(k)
    for (const k of Object.keys(fv)) if (fv[k] !== null && fv[k] !== undefined) add(k)

    const pdfMap = getPdfMap(t.form_type)
    const pdfKeys = Object.keys(pdfMap)
    const hits = pdfKeys.filter(k => filled.has(k)).length
    const pct = Math.round(hits / pdfKeys.length * 100)

    console.log(`${t.name.padEnd(28)}${t.form_type.padEnd(8)}${String(hits).padStart(12)}${String(pdfKeys.length).padStart(8)}${(pct+'%').padStart(8)}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
