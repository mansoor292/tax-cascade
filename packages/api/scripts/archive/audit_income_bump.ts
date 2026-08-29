/**
 * Audit: bump income by $50000 on each 2024 return and compare output
 *
 * Fetches live returns from prod API, runs the UPDATED engine locally
 * (with the scenario merge bug fixed), and prints a clean diff.
 */
import { calc1120, calc1120S, calc1040 } from '../src/engine/tax_engine.js'

const API_BASE = 'http://13.223.50.81:3737'
const API_KEY = 'txk_999fb6a457964ca0b66d556c'

async function fetchReturn(id: string) {
  const r = await fetch(`${API_BASE}/api/returns/${id}`, {
    headers: { 'x-api-key': API_KEY },
  })
  return (await r.json()).return
}

interface AuditTarget {
  name: string
  return_id: string
  form_type: '1120' | '1120S' | '1040'
  bump_field: string
}

const targets: AuditTarget[] = [
  { name: 'Edgewater AI, Inc',         return_id: '85f9ad1b-d705-44db-9da5-fed092ef8d4e', form_type: '1120',  bump_field: 'gross_receipts' },
  { name: 'Edgewater Investments Inc', return_id: '27acbe8c-4037-4474-b554-49f47b57227a', form_type: '1120S', bump_field: 'gross_receipts' },
  { name: 'Edgewater Ventures Inc',    return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b', form_type: '1120',  bump_field: 'gross_receipts' },
  { name: 'Mansoor & Ingrid Razzaq',   return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46', form_type: '1040',  bump_field: 'wages' },
]

function runEngine(formType: string, inputs: any) {
  if (formType === '1120')  return calc1120({ ...inputs, tax_year: inputs.tax_year || 2024 })
  if (formType === '1120S') return calc1120S(inputs)
  if (formType === '1040')  return calc1040({ ...inputs, tax_year: inputs.tax_year || 2024 })
  throw new Error(`unsupported form_type ${formType}`)
}

function delta(a: any, b: any) {
  if (typeof a !== 'number' || typeof b !== 'number') return null
  return b - a
}

async function main() {
  for (const t of targets) {
    const ret = await fetchReturn(t.return_id)
    const inputs = ret.input_data || {}
    const baseValue = inputs[t.bump_field] || 0
    const bumpedInputs = { ...inputs, [t.bump_field]: baseValue + 50000 }

    const baseResult = runEngine(t.form_type, inputs)
    const bumpedResult = runEngine(t.form_type, bumpedInputs)

    const base = baseResult.computed || {}
    const bumped = bumpedResult.computed || {}

    console.log(`\n${'═'.repeat(70)}`)
    console.log(`${t.name} — ${t.form_type} (TY 2024)`)
    console.log(`${'═'.repeat(70)}`)
    console.log(`Input bump: ${t.bump_field}  ${baseValue.toLocaleString()} → ${(baseValue + 50000).toLocaleString()}  (+$50000)`)
    console.log(``)
    console.log(`Computed changes:`)

    const allKeys = new Set([...Object.keys(base), ...Object.keys(bumped)])
    const rows: Array<[string, number, number, number]> = []
    for (const k of allKeys) {
      const d = delta(base[k], bumped[k])
      if (d !== null && d !== 0) {
        rows.push([k, base[k], bumped[k], d])
      }
    }
    rows.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]))

    if (rows.length === 0) {
      console.log(`  (no change — return has zero income or the bumped field isn't used)`)
    } else {
      const maxKey = Math.max(...rows.map(r => r[0].length))
      for (const [k, b, s, d] of rows) {
        const bStr = typeof b === 'number' ? b.toLocaleString() : '—'
        const sStr = typeof s === 'number' ? s.toLocaleString() : '—'
        const dStr = (d > 0 ? '+' : '') + d.toLocaleString()
        console.log(`  ${k.padEnd(maxKey)}  ${bStr.padStart(14)} → ${sStr.padStart(14)}  (Δ ${dStr})`)
      }
    }

    // Sanity check
    const totalTaxDelta = delta(base.total_tax, bumped.total_tax) ?? 0
    const expectedRate = t.form_type === '1120' ? 0.21 : null  // C-corp flat 21%
    if (expectedRate !== null) {
      const expected = Math.round(50000 * expectedRate)
      const match = totalTaxDelta === expected
      console.log(``)
      console.log(`  SANITY: +$50000 income × 21% = +$${expected} tax. Got +$${totalTaxDelta} → ${match ? 'PASS' : 'MISMATCH'}`)
    }
  }

  console.log(`\n${'═'.repeat(70)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
