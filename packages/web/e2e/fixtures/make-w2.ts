// Generates fixtures/sample-w2.pdf — a synthetic one-page W-2 with fake
// values, used by document-automerge.spec.ts to exercise the real
// ingest → classify → extract → compute auto-merge path on prod.
// Run once from packages/web: npx tsx e2e/fixtures/make-w2.ts
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
const page = pdf.addPage([612, 792])
let y = 720
const line = (text: string, size = 12, f = font) => {
  page.drawText(text, { x: 72, y, size, font: f })
  y -= size + 10
}
line('Form W-2 Wage and Tax Statement', 18, bold)
line('Tax Year 2024', 14, bold)
line('')
line('Employer: E2E FIXTURE EMPLOYER INC  (EIN 00-0000000)')
line('Employee: TEST E2E EMPLOYEE')
line('')
line('Box 1  Wages, tips, other compensation:        12345.67', 12, bold)
line('Box 2  Federal income tax withheld:             2345.10', 12, bold)
line('Box 3  Social security wages:                  12345.67')
line('Box 4  Social security tax withheld:             765.43')
line('Box 5  Medicare wages and tips:                12345.67')
line('Box 6  Medicare tax withheld:                    179.01')
line('')
line('SYNTHETIC TEST DOCUMENT — NOT A REAL W-2', 10)

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample-w2.pdf')
writeFileSync(out, await pdf.save())
console.log('wrote', out)
