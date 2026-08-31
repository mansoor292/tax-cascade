/**
 * Generates the amendment-flow pair:
 *   fixtures/sample-1040-2023.pdf   — a plain 2023 Form 1040
 *   fixtures/sample-1040x-2023.pdf  — the 1040-X amending it
 *
 * Synthetic, tiny (one Textract page each), reproducible:
 *   npx tsx e2e/fixtures/make-1040x.ts
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))

async function makeDoc(lines: Array<[string, number, number, number?, boolean?]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (const [text, x, y, size = 10, isBold = false] of lines) {
    page.drawText(text, { x, y, size, font: isBold ? bold : helv })
  }
  return doc.save()
}

const plain1040 = await makeDoc([
  ['Form 1040', 40, 750, 16, true],
  ['U.S. Individual Income Tax Return', 40, 730, 12, true],
  ['Department of the Treasury — Internal Revenue Service', 40, 714, 8],
  ['For the year Jan. 1 - Dec. 31, 2023', 40, 698, 10],
  ['Name:  E2E AMENDMENT SAMPLE', 40, 668, 10],
  ["Your social security number:  000-00-0000", 40, 650, 10],
  ['Filing status:  Single', 40, 634, 10],
  ['1a  Wages, salaries, tips (W-2 box 1)', 40, 596, 10], ['50000', 480, 596, 10],
  ['9   Total income', 40, 574, 10], ['50000', 480, 574, 10],
  ['11  Adjusted gross income', 40, 552, 10], ['50000', 480, 552, 10],
  ['12  Standard deduction', 40, 530, 10], ['13850', 480, 530, 10],
  ['15  Taxable income', 40, 508, 10], ['36150', 480, 508, 10],
  ['22  Total tax', 40, 486, 10], ['4118', 480, 486, 10],
  ['25  Federal income tax withheld', 40, 464, 10], ['5000', 480, 464, 10],
  ['This is a synthetic test fixture. Not a real tax return.', 40, 80, 8],
])
writeFileSync(join(here, 'sample-1040-2023.pdf'), plain1040)

const x1040 = await makeDoc([
  ['Form 1040-X', 40, 750, 16, true],
  ['Amended U.S. Individual Income Tax Return', 40, 730, 12, true],
  ['Department of the Treasury — Internal Revenue Service', 40, 714, 8],
  ['This return is for calendar year 2023', 40, 698, 10],
  ['Name:  E2E AMENDMENT SAMPLE', 40, 668, 10],
  ["Your social security number:  000-00-0000", 40, 650, 10],
  ['                              A. Original      B. Net change      C. Correct amount', 40, 620, 9, true],
  ['1   Adjusted gross income', 40, 598, 10], ['50000', 300, 598, 10], ['2000', 390, 598, 10], ['52000', 490, 598, 10],
  ['5   Taxable income', 40, 576, 10], ['36150', 300, 576, 10], ['2000', 390, 576, 10], ['38150', 490, 576, 10],
  ['11  Total tax', 40, 554, 10], ['4118', 300, 554, 10], ['440', 390, 554, 10], ['4558', 490, 554, 10],
  ['Part III — Explanation of changes:', 40, 500, 10, true],
  ['Reporting additional interest income omitted from the original return.', 40, 484, 10],
  ['This is a synthetic test fixture. Not a real tax return.', 40, 80, 8],
])
writeFileSync(join(here, 'sample-1040x-2023.pdf'), x1040)

console.log('wrote sample-1040-2023.pdf and sample-1040x-2023.pdf')
