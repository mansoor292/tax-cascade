/**
 * Generates fixtures/sample-1065.pdf — a synthetic one-page document that
 * classifies as a 2023 Form 1065 with all-zero money lines.
 *
 * Same idea as sample-1040.pdf: tiny (one Textract page ≈ $0.065 per suite
 * run), no real taxpayer data, reproducible. Run once and commit the output:
 *
 *   npx tsx e2e/fixtures/make-1065.ts
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const doc = await PDFDocument.create()
const page = doc.addPage([612, 792])
const helv = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)

const draw = (text: string, x: number, y: number, size = 10, font = helv) =>
  page.drawText(text, { x, y, size, font })

draw('Form 1065', 40, 750, 16, bold)
draw('U.S. Return of Partnership Income', 40, 730, 12, bold)
draw('Department of the Treasury — Internal Revenue Service', 40, 714, 8)
draw('For calendar year 2023', 40, 698, 10)

draw('Name of partnership:  E2E SAMPLE PARTNERS LLC', 40, 668)
draw('D  Employer identification number:  00-0000000', 40, 650)
draw('E  Date business started:  01-01-2020', 40, 634)
draw('C  Business code number:  541990', 40, 618)

const LINES: Array<[string, string]> = [
  ['1a  Gross receipts or sales', '0'],
  ['1c  Balance', '0'],
  ['2   Cost of goods sold', '0'],
  ['3   Gross profit', '0'],
  ['8   Total income (loss)', '0'],
  ['9   Salaries and wages', '0'],
  ['10  Guaranteed payments to partners', '0'],
  ['15  Interest', '0'],
  ['21  Total deductions', '0'],
  ['23  Ordinary business income (loss)', '0'],
]
let y = 580
for (const [label, value] of LINES) {
  draw(label, 40, y)
  draw(value, 480, y)
  y -= 22
}
draw('This is a synthetic test fixture. Not a real tax return.', 40, 80, 8)

const out = join(dirname(fileURLToPath(import.meta.url)), 'sample-1065.pdf')
writeFileSync(out, await doc.save())
console.log(`wrote ${out}`)
