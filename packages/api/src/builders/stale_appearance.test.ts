import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { PDFDocument, PDFName } from 'pdf-lib'
import { clearStaleAppearances } from './build_return_pdf.js'

// The 2025 Form 1040's spouse IP PIN box (f2_43) ships with a drawn comb
// appearance. Filled and copied into the package, it printed blank.
describe('clearStaleAppearances', () => {
  it('removes the pre-drawn appearance of a filled field so its value renders', async () => {
    const pdf = await PDFDocument.load(readFileSync('data/irs_forms/f1040_2025.pdf'))
    const field = pdf.getForm().getFields().find(f => f.getName().includes('f2_43['))!
    const widget = field.acroField.getWidgets()[0]
    expect(widget.dict.has(PDFName.of('AP'))).toBe(true)
    ;(field as any).setText('123456')
    expect(clearStaleAppearances(pdf)).toBeGreaterThan(0)
    expect(widget.dict.has(PDFName.of('AP'))).toBe(false)
  })

  it('leaves empty fields alone', async () => {
    const pdf = await PDFDocument.load(readFileSync('data/irs_forms/f1040_2025.pdf'))
    const field = pdf.getForm().getFields().find(f => f.getName().includes('f2_43['))!
    clearStaleAppearances(pdf)
    expect(field.acroField.getWidgets()[0].dict.has(PDFName.of('AP'))).toBe(true)
  })
})
