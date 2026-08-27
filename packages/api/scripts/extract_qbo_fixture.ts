/**
 * Capture a real QuickBooks report from the qbo_report cache and write it
 * out as an anonymised test fixture.
 *
 * WHY the structure and not the numbers:
 *
 * What breaks the mapper is report SHAPE — nested sections, Header rows that
 * carry a direct posting at a parent account, Summary rows, sub-sections
 * without a `group`, odd chart-of-accounts nesting. None of that depends on
 * the amounts. So this preserves the tree exactly and replaces every amount
 * with a deterministic synthetic value, which means fixtures can live in the
 * repo without carrying anyone's real revenue, payroll or profit.
 *
 * Account NAMES are preserved: the mapper classifies on them ("Advertising",
 * "Payroll Expenses", "Interest Earned"), so anonymising them would destroy
 * the thing being tested. Review a fixture before committing it if a company
 * uses counterparty names as account names.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/extract_qbo_fixture.ts \
 *       --type profit-and-loss --out src/maps/__fixtures__/pnl_1120s.json
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

/**
 * Deterministic synthetic amount derived from the account name, so the same
 * fixture regenerates identically and expected values stay stable.
 * Values land in a plausible range and keep two decimal places.
 */
function syntheticAmount(key: string, index: number): number {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const base = 1000 + (h % 90_000) + index * 7
  return Math.round(base * 100) / 100
}

let counter = 0

/** Walk the report tree, replacing only the numeric column values. */
function scrub(node: any): any {
  if (Array.isArray(node)) return node.map(scrub)
  if (node && typeof node === 'object') {
    const out: any = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === 'ColData' && Array.isArray(v)) {
        // ColData[0] is the account label, [1..] are amounts.
        const label = (v[0] as any)?.value ?? ''
        out[k] = (v as any[]).map((cell, i) => {
          if (i === 0) return cell
          if (cell?.value === undefined || cell.value === '') return cell
          const n = parseFloat(cell.value)
          if (Number.isNaN(n)) return cell
          return { ...cell, value: String(syntheticAmount(label || `col${i}`, counter++)) }
        })
      } else {
        out[k] = scrub(v)
      }
    }
    return out
  }
  return node
}

const main = async () => {
  if (!SERVICE) { console.error('SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1) }
  const type = arg('type', 'profit-and-loss')
  const out = arg('out')
  if (!out) { console.error('--out <path> required'); process.exit(1) }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/qbo_report?report_type=eq.${encodeURIComponent(type)}` +
    `&select=report_type,period_start,period_end,accounting_method,raw_data&order=fetched_at.desc&limit=1`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  )
  const rows: any[] = await res.json()
  if (!rows?.length) { console.error(`no cached ${type} report found`); process.exit(1) }

  const row = rows[0]
  const scrubbed = scrub(row.raw_data)

  // Strip company identity from the report header.
  if (scrubbed?.Header) {
    scrubbed.Header.ReportName = type
    delete scrubbed.Header.Option
    for (const k of ['Customer', 'Vendor', 'Employee', 'Class', 'Department']) delete scrubbed.Header[k]
  }

  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname } = await import('path')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({
    _note: 'Structure captured from a real QBO report; all amounts replaced with deterministic synthetic values. See scripts/extract_qbo_fixture.ts.',
    report_type: row.report_type,
    accounting_method: row.accounting_method,
    raw_data: scrubbed,
  }, null, 2))

  console.log(`wrote ${out} (${counter} amounts replaced)`)
}

main().catch(e => { console.error(e); process.exit(1) })
