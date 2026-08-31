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
  ['Form 1040-X', 40, 756, 18, true],
  ['(Rev. February 2024)', 40, 740, 8],
  ['Amended U.S. Individual Income Tax Return', 40, 724, 13, true],
  ['Department of the Treasury - Internal Revenue Service', 40, 708, 8],
  ['OMB No. 1545-0074', 480, 756, 8],
  ['This return is for calendar year:  [X] 2023   [ ] 2022   [ ] 2021   [ ] 2020', 40, 688, 10],
  ['Your first name and middle initial:  E2E', 40, 664, 10],
  ['Last name:  AMENDMENT SAMPLE', 300, 664, 10],
  ['Your social security number:  000-00-0000', 40, 648, 10],
  ['Amended return filing status:  [X] Single', 40, 630, 10],
  ['Income and Deductions', 40, 604, 11, true],
  ['                                             A. Original amount    B. Net change    C. Correct amount', 40, 588, 8, true],
  ['1   Adjusted gross income . . . . . 1', 40, 568, 10], ['50,000', 320, 568, 10], ['2,000', 410, 568, 10], ['52,000', 500, 568, 10],
  ['2   Itemized deductions or standard deduction . 2', 40, 546, 10], ['13,850', 320, 546, 10], ['0', 410, 546, 10], ['13,850', 500, 546, 10],
  ['5   Taxable income . . . . . . 5', 40, 524, 10], ['36,150', 320, 524, 10], ['2,000', 410, 524, 10], ['38,150', 500, 524, 10],
  ['6   Tax . . . . . . . . 6', 40, 502, 10], ['4,118', 320, 502, 10], ['440', 410, 502, 10], ['4,558', 500, 502, 10],
  ['11  Total tax . . . . . . . 11', 40, 480, 10], ['4,118', 320, 480, 10], ['440', 410, 480, 10], ['4,558', 500, 480, 10],
  ['12  Federal income tax withheld . . . 12', 40, 458, 10], ['5,000', 320, 458, 10], ['0', 410, 458, 10], ['5,000', 500, 458, 10],
  ['20  Amount you owe . . . . . . 20', 40, 436, 10], ['0', 500, 436, 10],
  ['Part III  Explanation of Changes', 40, 396, 11, true],
  ['Reporting additional interest income omitted from the original return.', 40, 380, 10],
  ['Sign Here    Under penalties of perjury, I declare that I have filed an original return.', 40, 340, 8],
  ['Form 1040-X (Rev. 2-2024)', 40, 60, 8],
])
writeFileSync(join(here, 'sample-1040x-2023.pdf'), x1040)

console.log('wrote sample-1040-2023.pdf and sample-1040x-2023.pdf')
