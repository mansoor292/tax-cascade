/**
 * Regenerate f1040se_{year}_fields.json with semantic labels for every field.
 *
 * Run: npx tsx packages/api/scripts/regen_sche_fieldmap.ts 2025
 */
import { PDFDocument } from 'pdf-lib'
import { readFileSync, writeFileSync } from 'fs'

// Derived from the table structure in the PDF internal names
// (Table_Line1a/RowA, Table_Expenses/Line5/RowA, etc.)
const LINE_LABELS: Record<string, (col: 'A' | 'B' | 'C') => string> = {
  Line1a: (c) => `1a Physical address (Property ${c})`,
  Line1b: (c) => `1b Type of property (code 1-8, Property ${c})`,
  Line2:  (c) => `2 Fair rental / personal use days (Property ${c})`,
  Line3:  (c) => `3 Rents received (Property ${c})`,
  Line4:  (c) => `4 Royalties received (Property ${c})`,
  Line5:  (c) => `5 Advertising (Property ${c})`,
  Line6:  (c) => `6 Auto and travel (Property ${c})`,
  Line7:  (c) => `7 Cleaning and maintenance (Property ${c})`,
  Line8:  (c) => `8 Commissions (Property ${c})`,
  Line9:  (c) => `9 Insurance (Property ${c})`,
  Line10: (c) => `10 Legal and other professional fees (Property ${c})`,
  Line11: (c) => `11 Management fees (Property ${c})`,
  Line12: (c) => `12 Mortgage interest paid to banks (Property ${c})`,
  Line13: (c) => `13 Other interest (Property ${c})`,
  Line14: (c) => `14 Repairs (Property ${c})`,
  Line15: (c) => `15 Supplies (Property ${c})`,
  Line16: (c) => `16 Taxes (Property ${c})`,
  Line17: (c) => `17 Utilities (Property ${c})`,
  Line18: (c) => `18 Depreciation or depletion (Property ${c})`,
  Line19: (c) => `19 Other expenses (Property ${c})`,
  Line20: (c) => `20 Total expenses (Property ${c})`,
  Line21: (c) => `21 Income or (loss) (Property ${c})`,
  Line22: (c) => `22 Deductible rental real estate loss after limitation (Property ${c})`,
  'Line28a-f': (c) => `28 Partnership/S-corp entry (Row ${c})`,
}

// Top-level fields that aren't inside a table — hand-labelled
const SUMMARY_LABELS: Record<string, string> = {
  f1_1:  'Name(s) shown on return',
  f1_2:  'Your social security number',
  f1_15: 'Other (describe) Properties — shared description',
  f1_64: 'Line 19 Other (list) — shared description',
  f1_77: '23a Total of all amounts reported on line 3 for all rental properties',
  f1_78: '23b Total of all amounts reported on line 4 for all royalty properties',
  f1_79: '23c Total of all amounts reported on line 12 for all properties',
  f1_80: '23d Total of all amounts reported on line 18 for all properties',
  f1_81: '23e Total of all amounts reported on line 20 for all properties',
  f1_82: '24 Income. Add positive amounts from line 21 — do not include losses',
  f1_83: '25 Losses. Add amounts from lines 21 and 22 that are losses',
  f1_84: '26 Total rental real estate and royalty income or loss (L24 - L25)',
  f2_1:  'Name(s) shown on return (page 2)',
  f2_2:  'Your social security number (page 2)',
  f2_45: '30 Add columns (h) and (k) of line 29a',
  f2_47: '32 Total partnership and S corporation income or loss',
  f2_68: '35 Add columns (d) and (f) of line 34a',
  f2_70: '37 Total estate and trust income or loss',
  f2_76: '39 Combine columns (d) and (e) only',
  f2_77: '40 Net farm rental income or loss from Form 4835',
  f2_78: '41 Total income or loss (combine 26, 32, 37, 39, 40)',
  f2_79: '42 Reconciliation of farming and fishing income',
  f2_80: '43 Reconciliation for real estate professionals',
}

async function main() {
  const year = process.argv[2] || '2025'
  const pdf = await PDFDocument.load(readFileSync(`data/irs_forms/f1040se_${year}.pdf`))
  const form = pdf.getForm()
  const fields = form.getFields()
  const out: Array<{page: number; field_id: string; label: string}> = []

  for (const f of fields) {
    const name = f.getName()
    const short = name.match(/(f\d+_\d+)\[/)?.[1] || name.match(/(c\d+_\d+)\[/)?.[1] || name
    const page = name.startsWith('topmostSubform[0].Page1') ? 1 : 2
    let label = SUMMARY_LABELS[short]
    if (!label) {
      // Parse Table_X[0].RowA[0] structure
      const tableMatch = name.match(/Table_([^[]+)\[/)
      const rowMatch = name.match(/Row([ABC])\[/)
      const lineInsideExpenses = name.match(/Table_Expenses\[0\]\.Line(\d+)\[/)
      const lineInsideIncome   = name.match(/Table_Income\[0\]\.Line(\d+)\[/)
      if (lineInsideExpenses && rowMatch) {
        const n = lineInsideExpenses[1]
        const col = rowMatch[1] as 'A' | 'B' | 'C'
        label = LINE_LABELS[`Line${n}`]?.(col) || `Expense line ${n} (Property ${col})`
      } else if (lineInsideIncome && rowMatch) {
        const n = lineInsideIncome[1]
        const col = rowMatch[1] as 'A' | 'B' | 'C'
        label = LINE_LABELS[`Line${n}`]?.(col) || `Income line ${n} (Property ${col})`
      } else if (tableMatch && rowMatch) {
        const tag = tableMatch[1].replace(/\[0\]$/, '')
        const col = rowMatch[1] as 'A' | 'B' | 'C'
        label = LINE_LABELS[tag]?.(col) || `${tag} (Row ${col})`
      } else {
        label = `Unlabelled ${f.constructor.name} ${short}`
      }
    }
    out.push({ page, field_id: short, label })
  }

  out.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    const [pa1, pa2] = a.field_id.match(/^[fc](\d+)_(\d+)$/)?.slice(1).map(Number) || [99, 999]
    const [pb1, pb2] = b.field_id.match(/^[fc](\d+)_(\d+)$/)?.slice(1).map(Number) || [99, 999]
    if (pa1 !== pb1) return pa1 - pb1
    return pa2 - pb2
  })

  const outPath = `data/field_maps/f1040se_${year}_fields.json`
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`Wrote ${out.length} fields → ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
