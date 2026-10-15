/**
 * render_fixture.ts — render a return package locally from a saved {return, entity} fixture.
 *
 * The parity loop (scripts/parity/pdf_parity.py) needs OUR package for a real
 * return, built by the code in this checkout — not by whatever prod last
 * deployed. GET /api/returns/:id and GET /api/entities/:id already hand back
 * the decrypted row; saved as one JSON file, that is everything the PDF route
 * feeds the builder, so this does exactly what GET /api/returns/:id/pdf does
 * minus S3 and the QBO Schedule L fallback (a return with saved Schedule L
 * values never uses it).
 *
 * Fixtures hold real taxpayer data. They live OUTSIDE the repo; never commit one.
 *
 *   npx tsx scripts/parity/render_fixture.ts FIXTURE.json OUT.pdf
 *   npx tsx scripts/parity/render_fixture.ts FIXTURE.json OUT.pdf --k1   # K-1s too, as the K-1 route would
 */
import { readFileSync, writeFileSync } from 'fs'
import { buildReturnPdf } from '../../src/builders/build_return_pdf.js'
import { fieldValuesForPdf } from '../../src/maps/qbo_to_schedule_l.js'

async function main() {
  const [fixturePath, outPath] = process.argv.slice(2)
  if (!fixturePath || !outPath) {
    console.error('usage: render_fixture.ts FIXTURE.json OUT.pdf')
    process.exit(2)
  }
  const { return: r, entity } = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const result = await buildReturnPdf({
    formType: r.form_type,
    taxYear: r.tax_year,
    entity,
    inputData: r.input_data,
    computedData: r.computed_data,
    fieldValues: fieldValuesForPdf(r.field_values, {}),
  })
  writeFileSync(outPath, await result.pdf.save())
  console.log(JSON.stringify({ pages: result.pages, filled: result.filled, forms: result.forms, formYear: result.formYear }))
}

main().catch(e => { console.error(e); process.exit(1) })
