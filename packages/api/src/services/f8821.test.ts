/** The 8821 fill, on fictional values: each line lands in its box. */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { fill8821, line3Rows, formatTin } from './f8821.js'

describe('Form 8821', () => {
  it('fills taxpayer, designee, line 3 and the signer', async () => {
    const bytes = await fill8821({
      taxpayer: { name: 'Example Fictional LLC', address: '1 Example Way\nSpringfield IL 62701' },
      tin: '000000004',
      designee: { name: 'Dana Fictional, EA', address: '2 Sample St', city: 'Springfield', state: 'IL', zip: '62701', caf: '0000-00000R', phone: '555-0100' },
      scope: { income: ['1120S'], payroll: ['941', '940'], from_year: 2018, to_year: 2027, year_end_month: 6 },
      signer: { name: 'Pat Example', title: 'President', signedAt: '2026-10-24T12:00:00Z', electronic: true },
    })
    const form = (await PDFDocument.load(bytes)).getForm()
    const v = (n: string) => form.getTextField(`topmostSubform[0].Page1[0].${n}`).getText()
    expect(v('f1_7[0]')).toBe('00-0000004')
    expect(v('f1_11[0]')).toBe('0000-00000R')
    expect(v('Table_Line3[0].BodyRow1[0].f1_20[0]')).toBe('Income')
    expect(v('Table_Line3[0].BodyRow1[0].f1_21[0]')).toBe('1120-S')
    expect(v('Table_Line3[0].BodyRow1[0].f1_22[0]')).toBe('Tax years ending June 2018 through June 2027')
    expect(v('Table_Line3[0].BodyRow2[0].f1_25[0]')).toBe('941, 940')
    expect(v('f1_32[0]')).toBe('/s/ Pat Example 2026-10-24')
    expect(v('f1_33[0]')).toBe('President')
  })
  it('a masked TIN stays masked; December years read plainly', () => {
    expect(formatTin('XX-XXX0004')).toBe('XX-XXX0004')
    expect(line3Rows({ income: ['1120'], from_year: 2019, to_year: 2026 })[0][2]).toBe('2019 through 2026')
  })
})
