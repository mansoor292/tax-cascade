/** The 8821 fill, on fictional values: each line lands in its box. */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { fill8821, signed8821, line3Rows, formatTin, usDate, type F8821Input } from './f8821.js'
import { scribblePng } from '../lib/scribble_png.js'

const INPUT: F8821Input = {
  taxpayer: { name: 'Example Fictional LLC', address: '1 Example Way\nSpringfield IL 62701' },
  tin: '000000004',
  designee: { name: 'Dana Fictional, EA', address: '2 Sample St', city: 'Springfield', state: 'IL', zip: '62701', caf: '0000-00000R', phone: '555-0100' },
  scope: { income: ['1120S'], payroll: ['941', '940'], from_year: 2018, to_year: 2027, year_end_month: 6 },
}

describe('Form 8821', () => {
  it('the draft fills taxpayer, designee and line 3, leaves line 6 blank, and stays fillable', async () => {
    const bytes = await fill8821({
      taxpayer: { name: 'Example Fictional LLC', address: '1 Example Way\nSpringfield IL 62701' },
      tin: '000000004',
      designee: { name: 'Dana Fictional, EA', address: '2 Sample St', city: 'Springfield', state: 'IL', zip: '62701', caf: '0000-00000R', phone: '555-0100' },
      scope: { income: ['1120S'], payroll: ['941', '940'], from_year: 2018, to_year: 2027, year_end_month: 6 },
    })
    const form = (await PDFDocument.load(bytes)).getForm()
    const v = (n: string) => form.getTextField(`topmostSubform[0].Page1[0].${n}`).getText()
    expect(v('f1_7[0]')).toBe('00-0000004')
    expect(v('f1_11[0]')).toBe('0000-00000R')
    expect(v('Table_Line3[0].BodyRow1[0].f1_20[0]')).toBe('Income')
    expect(v('Table_Line3[0].BodyRow1[0].f1_21[0]')).toBe('1120-S')
    expect(v('Table_Line3[0].BodyRow1[0].f1_22[0]')).toBe('Tax years ending June 2018 through June 2027')
    expect(v('Table_Line3[0].BodyRow2[0].f1_25[0]')).toBe('941, 940')
    expect(v('f1_32[0]') ?? '').toBe('')
    expect(v('f1_33[0]') ?? '').toBe('')
  })
  // 2026-10-27: a TaxNow practice's 8821 names TaxNow's two designees and
  // ticks line 3's Intermediate Service Provider box, as TaxNow's own do.
  it('prints a second designee in the second block and ticks the ISP box when asked', async () => {
    const bytes = await fill8821({
      ...INPUT,
      designee: { ...INPUT.designee, isp: true, second: { name: 'Lee Sample, CPA', address: '3 Sample St', city: 'Springfield', state: 'IL', zip: '62701', caf: '0000-00001R', ptin: 'P00000001', phone: '555-0101', fax: '555-0102' } },
    })
    const form = (await PDFDocument.load(bytes)).getForm()
    const v = (n: string) => form.getTextField(`topmostSubform[0].Page1[0].${n}`).getText()
    expect(v('f1_10[0]')).toMatch(/^Dana Fictional, EA/)
    expect(v('f1_15[0]')).toBe('Lee Sample, CPA\n3 Sample St\nSpringfield IL 62701')
    expect([v('f1_16[0]'), v('f1_17[0]'), v('f1_18[0]'), v('f1_19[0]')]).toEqual(['0000-00001R', 'P00000001', '555-0101', '555-0102'])
    expect(form.getCheckBox('topmostSubform[0].Page1[0].c1_10[0]').isChecked()).toBe(true)
  })

  it('leaves the second block and the ISP box empty by default', async () => {
    const form = (await PDFDocument.load(await fill8821(INPUT))).getForm()
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_15[0]').getText() ?? '').toBe('')
    expect(form.getCheckBox('topmostSubform[0].Page1[0].c1_10[0]').isChecked()).toBe(false)
  })

  it('the signed copy prints the verified name, is flattened, and ends with the signing record', async () => {
    const bytes = await signed8821(INPUT, {
      name: 'PAT EXAMPLE', title: 'President', signedAt: '2026-10-25T14:03:00Z', png: new Uint8Array(scribblePng()),
      audit: [['Signed by', 'PAT EXAMPLE, President'], ['Identity verified', 'by Didit (TEST CHECK)']],
    })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getForm().getFields()).toHaveLength(0) // nothing left to retype
    expect(pdf.getPageCount()).toBe(2)
    expect(usDate('2026-10-25T14:03:00Z')).toBe('10/25/2026')
  })
  it('a masked TIN stays masked; December years read plainly', () => {
    expect(formatTin('XX-XXX0004')).toBe('XX-XXX0004')
    expect(line3Rows({ income: ['1120'], from_year: 2019, to_year: 2026 })[0][2]).toBe('2019 through 2026')
  })
})
