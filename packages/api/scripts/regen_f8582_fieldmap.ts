/**
 * Regenerate f8582_{year}_fields.json with semantic labels.
 * Run: npx tsx packages/api/scripts/regen_f8582_fieldmap.ts 2025
 */
import { PDFDocument } from 'pdf-lib'
import { readFileSync, writeFileSync } from 'fs'

const MAIN: Record<string, string> = {
  f1_01: 'Name(s) shown on return',
  f1_02: 'Identifying number',
  f1_03: '1a Activities with net income — rental real estate',
  f1_04: '1b Activities with net loss — rental real estate (enter as negative)',
  f1_05: '1c Prior year unallowed losses — rental real estate (enter as negative)',
  f1_06: '1d Combine lines 1a, 1b, 1c',
  f1_07: '2a Activities with net income — other passive',
  f1_08: '2b Activities with net loss — other passive (enter as negative)',
  f1_09: '2c Prior year unallowed losses — other passive (enter as negative)',
  f1_10: '2d Combine lines 2a, 2b, 2c',
  f1_11: '3 Combine lines 1d and 2d',
  f1_12: '4 Smaller of loss on 1d or loss on 3 (absolute value)',
  f1_13: '5 Enter $150,000 (or $75,000 if MFS)',
  f1_14: '6 Modified adjusted gross income',
  f1_15: '7 Subtract line 6 from line 5',
  f1_16: '8 Multiply line 7 by 50% (capped at $25,000 / $12,500 MFS)',
  f1_17: '9 Smaller of line 4 or line 8 — special allowance',
  f1_18: '10 Add income on lines 1a and 2a',
  f1_19: '11 Total losses allowed from all passive activities (L9 + L10)',
}

async function main() {
  const year = process.argv[2] || '2025'
  const pdf = await PDFDocument.load(readFileSync(`data/irs_forms/f8582_${year}.pdf`))
  const form = pdf.getForm()
  const fields = form.getFields()
  const out: Array<{ page: number; field_id: string; label: string }> = []

  for (const f of fields) {
    const name = f.getName()
    const short = name.match(/(f\d+_\d+)\[/)?.[1] || name.match(/(c\d+_\d+)\[/)?.[1] || name
    const page = name.startsWith('topmostSubform[0].Page1') ? 1 :
                 name.startsWith('topmostSubform[0].Page2') ? 2 : 3
    let label = MAIN[short]
    if (!label) {
      const part = name.match(/Table_(Part\d+)\[0\]/)?.[1]
      const row = name.match(/Row(\d+)\[/)?.[1]
      if (part && row) label = `${part} worksheet row ${row} cell ${short}`
      else label = `Unlabelled ${f.constructor.name} ${short}`
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

  const outPath = `data/field_maps/f8582_${year}_fields.json`
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`Wrote ${out.length} fields → ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
