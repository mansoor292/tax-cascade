/**
 * Dump every form field on f8582_{year}.pdf for field-map generation.
 *
 * Run: npx tsx packages/api/scripts/enum_f8582.ts [year]
 */
import { PDFDocument } from 'pdf-lib'
import { readFileSync } from 'fs'

async function main() {
  const year = process.argv[2] || '2025'
  const pdf = await PDFDocument.load(readFileSync(`data/irs_forms/f8582_${year}.pdf`))
  const form = pdf.getForm()
  const fields = form.getFields()
  console.log(`Total fields: ${fields.length}`)
  const rows: Array<{short: string; type: string; full: string}> = []
  for (const f of fields) {
    const name = f.getName()
    const short = name.match(/(f\d+_\d+)\[/)?.[1] || name.match(/(c\d+_\d+)\[/)?.[1] || name
    rows.push({ short, type: f.constructor.name, full: name })
  }
  rows.sort((a, b) => {
    const parseShort = (s: string): [number, number] => {
      const m = s.match(/^[fc](\d+)_(\d+)$/)
      return m ? [parseInt(m[1]), parseInt(m[2])] : [99, 999]
    }
    const [pa1, pa2] = parseShort(a.short)
    const [pb1, pb2] = parseShort(b.short)
    if (pa1 !== pb1) return pa1 - pb1
    return pa2 - pb2
  })
  for (const r of rows) console.log(`  ${r.short.padEnd(10)} ${r.type.padEnd(14)} ${r.full}`)
}
main().catch(e => { console.error(e); process.exit(1) })
