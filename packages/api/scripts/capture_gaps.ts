/**
 * Show which PDF canonical keys are NOT being captured by the Textract mapper.
 * Helps target new regex patterns.
 */
import { mapToCanonical } from '../src/intake/json_model_mapper.js'
import { getCanonicalAliases } from '../src/maps/engine_to_pdf.js'
import * as maps2024 from '../src/maps/pdf_field_map_2024.js'
import * as maps2025 from '../src/maps/pdf_field_map_2025.js'

const API = 'http://13.223.50.81:3737'
const KEY = 'txk_999fb6a457964ca0b66d556c'

async function get(path: string) {
  const r = await fetch(`${API}${path}`, { headers: { 'x-api-key': KEY } })
  return r.json()
}

function getPdfMap(formType: string): Record<string, string> {
  const base = `F${formType.replace('-', '')}`
  return {
    ...((maps2024 as any)[`${base}_2024`] || {}),
    ...((maps2024 as any)[`PDF_FIELD_MAP_${formType.replace('-', '')}`] || {}),
    ...((maps2025 as any)[`${base}_2025`] || {}),
  }
}

const targets = [
  { name: '1120 (Edgewater Ventures)',   doc: '2c79e99d-c78a-4209-b638-60bcf1f9523c', form: '1120'  },
  { name: '1120S (Edgewater Investments)', doc: 'd85ec574-cf54-491c-9894-184ff3f96c65', form: '1120S' },
]

async function main() {
  for (const t of targets) {
    const doc = (await get(`/api/documents/${t.doc}`)).document
    const kvs = doc.textract_data?.kvs || []

    const mapped = mapToCanonical({
      source: 'textract', form_type: t.form as any, tax_year: 2024,
      key_value_pairs: kvs.map((kv: any) => ({ key: kv.key, value: kv.value })),
      tables: doc.textract_data?.tables || [],
    })
    const aliases = getCanonicalAliases(t.form)
    const captured = new Set<string>()
    for (const k of Object.keys(mapped.model)) {
      captured.add(k)
      if (aliases[k]) captured.add(aliases[k])
    }

    const pdfMap = getPdfMap(t.form)
    const missing = Object.keys(pdfMap).filter(k => !captured.has(k))

    console.log(`\n=== ${t.name} — capturing ${captured.size} canonical keys, missing ${missing.length} of ${Object.keys(pdfMap).length} ===`)

    // Look for Textract KVs that might match the missing keys — show first
    const bySection: Record<string, string[]> = {}
    for (const k of missing) {
      const s = k.split('.')[0]
      if (!bySection[s]) bySection[s] = []
      bySection[s].push(k)
    }
    for (const [s, ks] of Object.entries(bySection).sort((a,b) => b[1].length - a[1].length)) {
      console.log(`  [${s}] ${ks.length}`)
      for (const k of ks.slice(0, 8)) console.log(`    · ${k}`)
      if (ks.length > 8) console.log(`    … +${ks.length - 8} more`)
    }

    // Also show KVs that look IRS-line-flavored but weren't matched
    console.log(`\n  Sample unmapped KVs (lines that have values but no rule matches):`)
    const unmapped = (mapped.unmapped || []) as any[]
    const lineFlavored = unmapped.filter(u => /^[0-9]+[a-z]?\s/.test(u.key || ''))
    for (const u of lineFlavored.slice(0, 15)) {
      console.log(`    "${u.key.slice(0, 70)}" = ${u.value}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
