/**
 * NY IT-203 / IT-203-B / IT-2 builders, against the committed 2025 fill-in
 * blanks. Synthetic taxpayer only — no real figures belong in this repo.
 */
import { describe, it, expect } from 'vitest'
import { PDFCheckBox, PDFName, PDFTextField } from 'pdf-lib'
import type { PDFDocument } from 'pdf-lib'
import { buildNyIt203, buildNyIt203b, buildNyIt2 } from './state_ny.js'
import { NY_IT203_2025, NY_IT203B_2025, NY_IT2_2025 } from './state_ny_maps_2025.js'
import type { AttachmentContext } from './types.js'

function ctx(inputData: Record<string, any>, over: Partial<AttachmentContext> = {}): AttachmentContext {
  return {
    formType: '1040', taxYear: 2025, model: {}, computedData: {},
    entity: { name: 'Pat Example & Sam Example', ein: '000-00-0001', address: '1 Main St', city: 'Anytown', state: 'FL', zip: '00000',
      meta: { spouse_ssn: '000-00-0002' } },
    inputData, ...over,
  }
}
const text = (pdf: PDFDocument, name: string) => (pdf.getForm().getField(name) as PDFTextField).getText()
const states = (pdf: PDFDocument, name: string) =>
  (pdf.getForm().getField(name) as PDFCheckBox).acroField.getWidgets().map(w => [String(w.getOnValue()), String(w.getAppearanceState())])

describe('NY state builders', () => {
  it('render nothing when the return carries no NY data', async () => {
    expect(await buildNyIt203(ctx({}))).toBeNull()
    expect(await buildNyIt203b(ctx({}))).toBeNull()
    expect(await buildNyIt2(ctx({}))).toBeNull()
  })

  it('refuse a year the field maps were not verified against', async () => {
    expect(await buildNyIt203(ctx({ state_ny_it203: { L1_federal: 1 } }, { taxYear: 2024 }))).toBeNull()
  })

  it('fills IT-203 lines as whole dollars without separators', async () => {
    const a = await buildNyIt203(ctx({ state_ny_it203: { L1_federal: 123456.4, L1_ny: 7890, L7_federal: -3000, L52d: 12 } }))
    expect(a?.label).toBe('NY IT-203')
    const pdf = a!.pdf
    expect(text(pdf, 'federal 1 dollars')).toBe('123456')
    expect(text(pdf, 'nys 1 dollars')).toBe('7890')
    expect(text(pdf, 'federal 7 dollars')).toBe('-3000')
    // Printed line 52d lives in the field the form designer named "53d dollars".
    expect(NY_IT203_2025.fields.L52d.field).toBe('53d dollars')
    expect(text(pdf, '53d dollars')).toBe('12')
  })

  it('takes SSNs from the federal entity, as bare digits, when the NY data has none', async () => {
    const pdf = (await buildNyIt203(ctx({ state_ny_it203: { L1_federal: 1 } })))!.pdf
    expect(text(pdf, 'Your SSN')).toBe('000000001')
    expect(text(pdf, "Spouse's SSN")).toBe('000000002')
  })

  it('ticks the intended box of a one-name choice group', async () => {
    const pdf = (await buildNyIt203(ctx({ state_ny_it203: { filing_status: 'mfj', B_itemized: 'no', L33_deduction_type: 'Standard' } })))!.pdf
    const fs = states(pdf, 'Filing Status')
    const on = fs.filter(([, as]) => as !== '/Off')
    expect(on).toHaveLength(1)
    expect(on[0][0]).toMatch(/^\/2/)
    const b = states(pdf, 'BoxB')
    expect(b.find(([v]) => v === '/no')?.[1]).toBe('/no')
    expect(b.find(([v]) => v === '/yes')?.[1]).toBe('/Off')
    expect(String((pdf.getForm().getField('BoxB') as PDFCheckBox).acroField.dict.get(PDFName.of('V')))).toBe('/no')
  })

  it('refuses a choice the form does not offer instead of ticking a wrong box', async () => {
    await expect(buildNyIt203(ctx({ state_ny_it203: { filing_status: 'widowed-ish' } }))).rejects.toThrow(/filing_status/)
  })

  it('shrinks a value that would overflow its box', async () => {
    const long = 'A VERY LONG JOINT TAXPAYER NAME AND ANOTHER'
    const pdf = (await buildNyIt203b(ctx({ state_ny_it203b: { name: long, occupation: 'ENGINEER' } })))!.pdf
    const f = pdf.getForm().getField('name(s)') as PDFTextField
    expect(f.getText()).toBe(long)
    const size = parseFloat(/(\d+(?:\.\d+)?)\s+Tf/.exec(f.acroField.getDefaultAppearance() || '')![1])
    expect(size).toBeLessThan(10)
    expect(text(pdf, 'occupation')).toBe('ENGINEER')
  })

  it('puts two W-2s on each IT-2 page', async () => {
    const w2 = (n: number) => ({ box_c1: `EMPLOYER ${n}`, box_1: 1000 * n, box_16a: 500 * n, box_13b: true })
    const pages = await buildNyIt2(ctx({ state_ny_it2: { w2: [w2(1), w2(2), w2(3)] } }))
    expect(pages).toHaveLength(2)
    expect(text(pages![0].pdf, 'Box_1')).toBe('1000')
    expect(text(pages![0].pdf, '2_Box_1')).toBe('2000')
    expect(text(pages![1].pdf, 'Box_1')).toBe('3000')
    expect(text(pages![1].pdf, '2_Box_1')).toBeUndefined()
    expect(states(pages![0].pdf, 'Box_13b')[0][1]).toBe('/Yes')
  })

  it('maps only to fields that exist on the 2025 blanks', async () => {
    const all = [
      [NY_IT203_2025, (await buildNyIt203(ctx({ state_ny_it203: { L1_federal: 1 } })))!.pdf],
      [NY_IT203B_2025, (await buildNyIt203b(ctx({ state_ny_it203b: { L1a: 1 } })))!.pdf],
      [NY_IT2_2025, (await buildNyIt2(ctx({ state_ny_it2: { w2: [{ box_1: 1 }] } })))![0].pdf],
    ] as const
    for (const [map, pdf] of all) {
      const names = new Set(pdf.getForm().getFields().map(f => f.getName()))
      for (const spec of Object.values(map.fields)) expect(names.has(spec.field), spec.field).toBe(true)
      for (const cols of Object.values(map.rows))
        for (const spec of Object.values(cols)) for (const n of spec.fields) expect(names.has(n), n).toBe(true)
    }
  })
})
