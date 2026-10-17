/**
 * Catalogue a return PDF from disk.
 *
 *   npx tsx scripts/catalog/catalog_file.ts RETURN.pdf OUT.json [--year 2024]
 *
 * Writes the full catalog (real values — keep OUT outside the repo, mode 600)
 * and prints ONLY a coverage summary: page kinds, forms, counts and problems.
 * No value, label or identifier from the return is printed.
 */
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { basename } from 'node:path'
import { catalogPdf } from '../../src/catalog/extract.js'

async function main() {
  const [file, out] = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const yi = process.argv.indexOf('--year')
  const year = yi > 0 ? Number(process.argv[yi + 1]) : undefined
  if (!file || !out) {
    console.error('usage: catalog_file.ts RETURN.pdf OUT.json [--year YYYY]')
    process.exit(2)
  }
  const bytes = new Uint8Array(readFileSync(file))
  const t0 = Date.now()
  const cat = await catalogPdf(bytes, { filename: basename(file), taxYear: year })
  writeFileSync(out, JSON.stringify(cat))
  chmodSync(out, 0o600)
  const c = cat.coverage
  console.log(`${basename(file)}: ${c.pages} pages — ${c.form_pages} form, ${c.duplicate_pages} duplicate, ${c.statement_pages} statement, ${c.blank_pages} unreadable; ${c.entries} entries; residue ${c.residue_tokens}; copy conflicts ${c.copy_conflicts}; ${c.complete ? 'COMPLETE' : 'INCOMPLETE'} (${Date.now() - t0} ms)`)
  for (const p of cat.pages) {
    const what = p.kind === "statement" ? "statement" : p.kind === "transcript" ? (p.heading ?? "transcript") : p.kind === "blank" ? "UNREADABLE" : `${p.title} ${p.rev} p${p.blank_page}${p.instance ? ' [' + p.instance + ']' : ''} score ${p.score}`
    const res = p.residue.length ? ` residue ${p.residue.length}` : ''
    console.log(`  p${p.page}: ${what} — ${p.entries} entries${res}`)
  }
  for (const pr of c.problems) console.log(`  ! ${pr}`)
  for (const w of c.warnings) console.log(`  ~ ${w}`)
}

main().catch(e => { console.error(e); process.exit(1) })
