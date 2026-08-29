/**
 * Compare filed 2024 returns (Textract-extracted from uploaded PDFs) vs proforma 2024 returns (our engine)
 *
 * For each, show:
 *  - total fields present on filed (Textract KVs)
 *  - total fields present on proforma (inputs + computed + field_values)
 *  - line-item agreement on key figures (total income, taxable income, total tax)
 */
import { mapToCanonical } from '../src/intake/json_model_mapper.js'

const API = 'http://13.223.50.81:3737'
const KEY = 'txk_999fb6a457964ca0b66d556c'

async function get(path: string) {
  const r = await fetch(`${API}${path}`, { headers: { 'x-api-key': KEY } })
  return r.json()
}

interface Pair {
  entity_name: string
  form_type: '1040' | '1120' | '1120S'
  filed_doc_id: string
  proforma_return_id: string
}

const pairs: Pair[] = [
  { entity_name: 'Mansoor & Ingrid Razzaq',   form_type: '1040',  filed_doc_id: 'dbc7be0b-c7de-4fad-b87d-dcc97087e923', proforma_return_id: 'd188a94c-d459-4535-9400-ab45db5e8a46' },
  { entity_name: 'Edgewater Investments Inc', form_type: '1120S', filed_doc_id: 'd85ec574-cf54-491c-9894-184ff3f96c65', proforma_return_id: '27acbe8c-4037-4474-b554-49f47b57227a' },
  { entity_name: 'Edgewater Ventures Inc',    form_type: '1120',  filed_doc_id: '2c79e99d-c78a-4209-b638-60bcf1f9523c', proforma_return_id: 'eab4606e-8f81-4a90-b00e-e85faf6d6a9b' },
]

// Line-by-line values we care about for each form
const comparisons = {
  '1040': [
    { label: 'L1z  Total wages',           proforma_key: 'income.wages',         regex: /^1z\s+add\s+lines/i },
    { label: 'L2b  Taxable interest',      proforma_key: 'income.taxable_interest', regex: /^2b\s+taxable\s+interest/i },
    { label: 'L3b  Ordinary dividends',    proforma_key: 'income.ordinary_dividends', regex: /^3b\s+ordinary\s+dividends/i },
    { label: 'L7   Capital gain/(loss)',   proforma_key: 'income.capital_gains', regex: /^7\s+capital\s+gain/i },
    { label: 'L9   Total income',          proforma_key: 'total_income',         regex: /^9\s+add\s+lines\s+1z/i },
    { label: 'L11  AGI',                   proforma_key: 'agi',                   regex: /^11\s+subtract\s+line\s+10/i },
    { label: 'L15  Taxable income',        proforma_key: 'taxable_income',       regex: /^15\s+subtract\s+line\s+14/i },
    { label: 'L16  Tax',                   proforma_key: 'income_tax',           regex: /^16\s+tax/i },
    { label: 'L24  Total tax',             proforma_key: 'total_tax',            regex: /^24\s+add\s+lines\s+22/i },
    { label: 'L25a W-2 withholding',       proforma_key: 'withholding',          regex: /^25a\s+form\(s\)\s+w-2/i },
    { label: 'L26  Estimated payments',    proforma_key: 'estimated_payments',   regex: /^26\s+2024\s+estimated/i },
    { label: 'L33  Total payments',        proforma_key: 'total_payments',       regex: /^33\s+add\s+lines\s+25d/i },
    { label: 'L34  Refund',                proforma_key: 'refund',               regex: /^34\s+if\s+line\s+33/i },
  ],
  '1120': [
    { label: 'L1a  Gross receipts',         proforma_key: 'gross_receipts',     regex: /^1a\s+gross\s+receipts/i },
    { label: 'L2   Cost of goods sold',     proforma_key: 'cost_of_goods_sold', regex: /^2\s+cost\s+of\s+goods/i },
    { label: 'L3   Gross profit',           proforma_key: 'gross_profit',       regex: /^3\s+gross\s+profit/i },
    { label: 'L11  Total income',           proforma_key: 'total_income',       regex: /^11\s+total\s+income/i },
    { label: 'L12  Officer comp',           proforma_key: 'officer_compensation', regex: /^12\s+compensation/i },
    { label: 'L13  Salaries/wages',         proforma_key: 'salaries_wages',     regex: /^13\s+salaries/i },
    { label: 'L17  Taxes and licenses',     proforma_key: 'taxes_licenses',     regex: /^17\s+taxes/i },
    { label: 'L27  Total deductions',       proforma_key: 'total_deductions',   regex: /^27\s+total\s+deductions/i },
    { label: 'L30  Taxable income',         proforma_key: 'taxable_income',     regex: /^30\s+taxable\s+income/i },
    { label: 'L31  Total tax',              proforma_key: 'total_tax',          regex: /^31\s+total\s+tax/i },
    { label: 'L33  Total payments',         proforma_key: 'total_payments',     regex: /^33\s+total\s+payments/i },
    { label: 'L35  Amount owed',            proforma_key: 'balance_due',        regex: /^35\s+amount\s+owed/i },
    { label: 'L36  Overpayment',            proforma_key: 'overpayment',        regex: /^36\s+overpayment/i },
  ],
  '1120S': [
    { label: 'L1a  Gross receipts',         proforma_key: 'gross_receipts',     regex: /^1a\s+gross\s+receipts/i },
    { label: 'L2   Cost of goods sold',     proforma_key: 'cost_of_goods_sold', regex: /^2\s+cost\s+of\s+goods/i },
    { label: 'L3   Gross profit',           proforma_key: 'gross_profit',       regex: /^3\s+gross\s+profit/i },
    { label: 'L6   Total income',           proforma_key: 'total_income',       regex: /^6\s+total\s+income/i },
    { label: 'L7   Officer comp',           proforma_key: 'officer_compensation', regex: /^7\s+compensation/i },
    { label: 'L8   Salaries/wages',         proforma_key: 'salaries_wages',     regex: /^8\s+salaries/i },
    { label: 'L12  Taxes and licenses',     proforma_key: 'taxes_licenses',     regex: /^12\s+taxes/i },
    { label: 'L21  Total deductions',       proforma_key: 'total_deductions',   regex: /^21\s+total\s+deductions/i },
    { label: 'L22  Ordinary inc/(loss)',    proforma_key: 'ordinary_income_loss', regex: /^22\s+.*ordinary|^21.*excess/i },
  ],
}

function parseDollar(s: string): number | null {
  if (!s) return null
  const c = s.replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1').replace(/\.$/, '')
  const n = parseFloat(c)
  return isNaN(n) ? null : Math.round(n)
}

function findKV(kvs: Array<{ key: string; value: string }>, regex: RegExp): number | null {
  for (const kv of kvs) {
    if (regex.test(kv.key || '')) {
      return parseDollar(kv.value)
    }
  }
  return null
}

function fmt(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString()
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

    console.log(`\n${'═'.repeat(80)}`)
    console.log(`${p.entity_name}  —  ${p.form_type}  —  2024`)
    console.log(`${'═'.repeat(80)}`)
    console.log(`Filed:    ${kvs.length} Textract KVs extracted from PDF`)
    console.log(`Proforma: ${Object.keys(inputs).length} inputs + ${Object.keys(computed).length} computed + ${Object.keys(fieldValues).length} field_values`)
    console.log('')

    const cmp = (comparisons as any)[p.form_type] || []
    console.log(`${'Line'.padEnd(26)} ${'Filed'.padStart(15)} ${'Proforma'.padStart(15)} ${'Δ'.padStart(14)}`)
    console.log('─'.repeat(80))

    let agreements = 0, differences = 0, missing = 0
    for (const c of cmp) {
      const filedVal = findKV(kvs, c.regex)
      // Proforma value: check inputs, computed, field_values in that order
      let proformaVal: number | null = null
      if (typeof inputs[c.proforma_key] === 'number') proformaVal = inputs[c.proforma_key]
      else if (typeof computed[c.proforma_key] === 'number') proformaVal = computed[c.proforma_key]
      else if (typeof fieldValues[c.proforma_key] === 'number') proformaVal = fieldValues[c.proforma_key]

      let status = ''
      let delta: number | null = null
      if (filedVal !== null && proformaVal !== null) {
        delta = proformaVal - filedVal
        if (Math.abs(delta) < 2) { status = ''; agreements++ }
        else { status = '  ⚠'; differences++ }
      } else if (filedVal === null || proformaVal === null) {
        status = '  ?'
        missing++
      }

      const deltaStr = delta === null ? '' :
        (Math.abs(delta) < 2 ? 'ok' : (delta > 0 ? '+' : '') + delta.toLocaleString())

      console.log(`${c.label.padEnd(26)} ${fmt(filedVal).padStart(15)} ${fmt(proformaVal).padStart(15)} ${deltaStr.padStart(14)}${status}`)
    }

    console.log('─'.repeat(80))
    console.log(`Match: ${agreements}  Differ: ${differences}  Missing: ${missing}  (of ${cmp.length})`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
