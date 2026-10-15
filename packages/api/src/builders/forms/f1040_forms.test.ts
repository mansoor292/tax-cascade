/**
 * The 2025 Form 1040 attachments and face fixes (src/builders/forms/f1040_*,
 * f7203, f8812, f8959, f8960, f8995a). Synthetic figures and names only.
 *
 * The box assignments themselves were verified against a filed 2025 return
 * with scripts/parity/; these tests pin them so a renumbering is caught, and
 * pin the behaviours the parity run found missing: no schedule ever rendered,
 * filing status never ticked on 2025, dashed SSNs in comb boxes, line 31
 * printing 0, schedule lines fuzzy-matched onto the 1040 face.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString, type PDFRef } from 'pdf-lib'
import { buildReturnPdf } from '../build_return_pdf.js'
import { calc1040 } from '../../engine/tax_engine.js'
import type { AttachmentContext } from './types.js'
import { buildSchedule1 } from './f1040_sched1.js'
import { buildScheduleB } from './f1040_schedB.js'
import { buildScheduleD } from './f1040_schedD.js'
import { buildScheduleEK1 } from './f1040_schedE_k1.js'
import { buildForm7203 } from './f7203.js'
import { buildForm8960 } from './f8960.js'

const entity = {
  name: 'Pat Example & Sam Example', ein: '000-00-0001', address: '1 Main St', city: 'Springfield', state: 'FL', zip: '33100',
  meta: { first_name: 'Pat', last_name: 'Example', spouse_first: 'Sam', spouse_last: 'Example', spouse_ssn: '000-00-0002', filing_status: 'mfj' },
}
const inputs = {
  filing_status: 'mfj', tax_year: 2025, is_sstb: false,
  wages: 300_000, withholding: 60_000,
  k1_ordinary_income: 500_000, k1_w2_wages: 80_000,
  k1_portfolio: { entity_name: 'EXAMPLE CO', ein: '00-0000003', interest: 10_000, ordinary_dividends: 200, st_gain: 50 },
  taxable_interest_detail: [{ label: 'Bank', amount: 300 }],
  capital_transactions_detail: [{ label: 'Broker', proceeds: 5_000, basis: 6_000, term: 'short' }],
  capital_loss_carryover: { long_term: 4_000 },
  other_income_detail: [{ label: 'Misc', amount: 50 }],
  extension_payment: 100_000, prior_year_tax: 90_000, prior_year_agi: 400_000,
  num_dependents: 1,
  dependents_detail: [{ first_name: 'Kid', last_name: 'Example', ssn: '000-00-0004', relationship: 'SON', lived_with_you: true, lived_in_us: true, ctc: true }],
  form7203: { shareholder: 'spouse', distributions: 300_000, nondeductible_expenses: 100 },
  main_home_in_us: true, digital_assets: false, third_party_designee: false,
  signature_detail: { taxpayer_occupation: 'TEACHER', spouse_occupation: 'ENGINEER' },
} as any

function ctx(): AttachmentContext {
  const fv = calc1040(inputs).field_values as Record<string, number>
  return { formType: '1040', taxYear: 2025, entity: entity as any, model: fv, inputData: inputs, computedData: {} }
}

/** Every widget on every page: full name → value (text) or appearance state (checkbox). */
function widgetValues(pdf: PDFDocument): Array<Record<string, string>> {
  const text = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o ? String(o) : '')
  return pdf.getPages().map(page => {
    const out: Record<string, string> = {}
    const annots = page.node.Annots()
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const a = page.doc.context.lookup(annots!.get(i) as PDFRef, PDFDict)
      const parts: string[] = []
      let v: unknown, node: PDFDict | undefined = a
      while (node) {
        const t = node.lookup(PDFName.of('T'))
        if (t) parts.unshift(text(t))
        v ??= node.lookup(PDFName.of('V'))
        const parent: unknown = node.lookup(PDFName.of('Parent'))
        node = parent instanceof PDFDict ? parent : undefined
      }
      const as = a.lookup(PDFName.of('AS'))
      out[parts.join('.')] = as ? text(as).replace(/^\//, '') : text(v)
    }
    return out
  })
}
const box = (pages: Array<Record<string, string>>, page: number, suffix: string) =>
  Object.entries(pages[page]).find(([k]) => k.endsWith(`.${suffix}`))?.[1]

describe('2025 Form 1040 attachments', () => {
  it('fills Schedule 1 line 5 and the 8z statement reference', async () => {
    const a = await buildSchedule1(ctx()) as any
    const f = a.pdf.getForm()
    const t = (id: string) => f.getFields().find((x: any) => x.getName().endsWith(`.${id}[0]`))?.getText()
    expect(t('f1_09')).toBe('500,000')
    expect(t('f1_36')).toBe('50')
    expect(t('f1_35')).toMatch(/^See Statement/)
    expect(t('f1_01')).toBe('Pat Example & Sam Example')
    expect(t('f1_02')).toBe('000000001')
  })

  it('puts the carryover and the 3,000 limit inside Schedule D parentheses as magnitudes', async () => {
    const a = await buildScheduleD(ctx()) as any
    const f = a.pdf.getForm()
    const t = (id: string) => f.getFields().find((x: any) => x.getName().endsWith(`.${id}[0]`))?.getText()
    expect(t('f1_42')).toBe('4,000')
    expect(t('f1_43')).toBe('-4,000')
    expect(t('f2_4')).toBe('3,000')
    expect(t('f1_22')).toBe('-950')
  })

  it('lists the K-1 as a Schedule B payer and answers Part III', async () => {
    const a = await buildScheduleB(ctx()) as any
    const f = a.pdf.getForm()
    const t = (id: string) => f.getFields().find((x: any) => x.getName().endsWith(`.${id}[0]`))?.getText()
    expect(t('f1_03')).toBe('Bank')
    expect(t('f1_05')).toBe('EXAMPLE CO')
    expect(t('f1_31')).toBe('10,300')
    expect(t('f1_36')).toBe('EXAMPLE CO')            // Part II starts on its second line
    expect(f.getFields().find((x: any) => x.getName().endsWith('.c1_1[1]'))?.isChecked()).toBe(true)
  })

  it('reports the S corporation in Schedule E Part II column (k)', async () => {
    const a = await buildScheduleEK1(ctx()) as any
    const f = a.pdf.getForm()
    const t = (id: string) => f.getFields().find((x: any) => x.getName().endsWith(`.${id}[0]`))?.getText()
    expect(t('f2_3')).toBe('EXAMPLE CO')
    expect(t('f2_4')).toBe('S')
    expect(t('f2_5')).toBe('000000003')
    expect(t('f2_19')).toBe('500,000')
    expect(t('f2_78')).toBe('500,000')
  })

  it("puts the spouse's name and SSN on a spouse shareholder's Form 7203", async () => {
    const a = await buildForm7203(ctx()) as any
    const f = a.pdf.getForm()
    const t = (id: string) => f.getFields().find((x: any) => x.getName().endsWith(`.${id}[0]`))?.getText()
    expect(t('f1_01')).toBe('Sam Example')
    expect(t('f1_02')).toBe('000000002')
    expect(t('f1_24')).toBe('300,000')
  })

  it('backs out nonpassive K-1 income on Form 8960 line 4b', async () => {
    const a = await buildForm8960(ctx()) as any
    const f = a.pdf.getForm()
    const t = (id: string) => f.getFields().find((x: any) => x.getName().endsWith(`.${id}[0]`))?.getText()
    expect(t('f1_6')).toBe('500,000')
    expect(t('f1_7')).toBe('-500,000')
    expect(t('f1_9')).toBe('-3,000')
  })

  it('refuses any year but 2025 rather than misplace 2025 box IDs', async () => {
    expect(await buildSchedule1({ ...ctx(), taxYear: 2024 })).toBeNull()
    expect(await buildScheduleEK1({ ...ctx(), taxYear: 2024 })).toBeNull()
  })
})

describe('2025 Form 1040 package', () => {
  it('renders every schedule the return needs, in attachment order', async () => {
    const r = calc1040(inputs)
    const { forms } = await buildReturnPdf({ formType: '1040', taxYear: 2025, entity: entity as any, inputData: inputs,
      computedData: {}, fieldValues: r.field_values })
    expect(forms).toEqual(['Form 1040', 'Schedule 1', 'Statement - Schedule 1 line 8z', 'Schedule 2', 'Schedule 3',
      'Schedule B', 'Schedule D', 'Schedule E', 'Schedule 8812', 'Form 8995-A', 'Form 8959', 'Form 8960', 'Form 7203', 'Form 1040-V'])
  })

  it('ticks MFJ on the 2025 layout, prints comb SSNs as digits, and fills the input-only boxes', async () => {
    const r = calc1040(inputs)
    const { pdf } = await buildReturnPdf({ formType: '1040', taxYear: 2025, entity: entity as any, inputData: inputs,
      computedData: {}, fieldValues: r.field_values })
    const pages = widgetValues(pdf)
    expect(box(pages, 0, 'Checkbox_ReadOrder[0].c1_8[1]')).not.toBe('Off')   // MFJ
    expect(box(pages, 0, 'Checkbox_ReadOrder[0].c1_8[0]')).toBe('Off')       // not Single
    expect(box(pages, 0, 'Page1[0].c1_8[0]')).toBe('Off')                    // not HOH
    expect(box(pages, 0, 'f1_16[0]')).toBe('000000001')
    expect(box(pages, 0, 'f1_31[0]')).toBe('Kid')
    expect(box(pages, 0, 'c1_28[0]')).not.toBe('Off')
    expect(box(pages, 0, 'c1_10[1]')).not.toBe('Off')
    expect(box(pages, 1, 'f2_40[0]')).toBe('TEACHER')
    expect(box(pages, 1, 'c2_17[1]')).not.toBe('Off')
    // Line 31 = Schedule 3 line 15 and line 32 includes it; line 20 is not a schedule's line 20.
    expect(box(pages, 1, 'f2_27[0]')).toBe('100,000')
    expect(box(pages, 1, 'f2_28[0]')).toBe('100,000')
    expect(box(pages, 1, 'f2_12[0]')).toBe('0')
    expect(box(pages, 0, 'f1_75[0]')).toBe(box(pages, 1, 'f2_01[0]'))
  })
})
