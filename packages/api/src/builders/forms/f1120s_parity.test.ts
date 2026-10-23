/**
 * Form 1120-S 2025 parity fixes (2026-10-15 sprint): the filed EZ-Advisors
 * return was compared box by box with ours, and these pin each fix to the
 * FIELD it lands in — a value in the wrong box is the failure class the
 * comparison exists to catch, so asserting "the text appears somewhere" is
 * not enough. All data here is synthetic.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { PDFDocument, PDFName, PDFDict, PDFString, PDFHexString, PDFCheckBox } from 'pdf-lib'
import { fill1120SAnswers, parseAnswers, answerIs, isUnitedStates } from './f1120s_answers.js'
import { buildScheduleD1120S } from './schedule_d_1120s.js'
import { applySupplemental, buildK1s1120S } from './k1_1120s.js'
import { statementBlocks1120S } from './statements_1120s.js'
import { build1120SK1, K1_1120S_CODE_ROWS_2025 } from '../build_k1_pdfs.js'
import { buildReturnPdf } from '../build_return_pdf.js'
import { calc1120S } from '../../engine/tax_engine.js'
import type { AttachmentContext } from './types.js'

const entity = {
  name: 'Parity Test Inc', ein: '00-0000000',
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '30589',
}

/** Every widget on every page: short field name → text value or checkbox state. Works on merged packages. */
function widgetValues(pdf: PDFDocument): Map<string, string> {
  const out = new Map<string, string>()
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict)
      if (a.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue
      const t = a.lookup(PDFName.of('T'))
      const name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : ''
      const v = a.lookup(PDFName.of('V'))
      const as = a.lookup(PDFName.of('AS'))
      let val = ''
      if (v instanceof PDFString || v instanceof PDFHexString) val = v.decodeText()
      else if (as instanceof PDFName && as.asString() !== '/Off') val = 'CHECKED'
      if (val) out.set(name, val)
    }
  }
  return out
}

function textValue(pdf: PDFDocument, short: string): string | undefined {
  for (const f of pdf.getForm().getFields()) {
    if (f.getName().endsWith('.' + short + '[0]')) return pdf.getForm().getTextField(f.getName()).getText()
  }
  return undefined
}
function isChecked(pdf: PDFDocument, id: string): boolean {
  for (const f of pdf.getForm().getFields()) {
    if (f instanceof PDFCheckBox && f.getName().endsWith('.' + id)) return f.isChecked()
  }
  return false
}

describe('1120-S answers (header, Schedule B, preparer)', () => {
  const answers = parseAnswers([
    { label: '1 Accounting method', answer: 'Cash' },
    { label: '2a Business activity', answer: 'Consulting' },
    { label: '2b Product or service', answer: 'Advice' },
    { label: '3 Any shareholder a disregarded entity', answer: 'No' },
    { label: '12 Non-shareholder debt canceled', answer: 'No' },
    { label: '14a Payments requiring Forms 1099', answer: 'Yes' },
    { label: '14b Filed required Forms 1099', answer: 'Yes - 1099-NEC to a contractor' },
    { label: '7 Publicly offered debt with OID', answer: 'Not checked' },
    { label: 'Header G Electing S status this year', answer: 'No' },
    { label: 'Header H(4) Amended return', answer: 'Checked' },
    { label: 'Header I Number of shareholders', answer: '2' },
    { label: 'Sch K 14b Schedule K-2 filing exception', answer: 'Checked' },
    { label: 'May the IRS discuss this return with the preparer', answer: 'No' },
  ])

  it('keys rows by the line the form prints', () => {
    expect(answers.get('14a')).toBe('Yes')
    expect(answers.get('G')).toBe('No')
    expect(answers.get('H4')).toBe('Checked')
    expect(answers.get('K14b')).toBe('Checked')
    expect(answers.get('DISCUSS')).toBe('No')
    expect(answerIs('Yes - 1099-NEC to a contractor', 'yes')).toBe(true)
    expect(answerIs('Not checked', 'checked')).toBe(false)
    expect(isUnitedStates('United States')).toBe(true)
    expect(isUnitedStates('Canada')).toBe(false)
  })

  it('checks the Yes/No box each answer names, on the 2025 blank', async () => {
    const pdf = await PDFDocument.load(readFileSync('data/irs_forms/f1120s_2025.pdf'))
    const form = pdf.getForm()
    form.getTextField(form.getFields().find(f => f.getName().endsWith('.f1_9[0]'))!.getName()).setText('United States')
    fill1120SAnswers(form, 2025, {
      answers, country: 'United States',
      preparer: { name: 'Pat Preparer', ptin: 'P00000000', firm_name: 'Prep LLC', firm_address: '2 Main St Town FL 33000', phone: '(555)000-0000' },
    })
    // [0] = Yes, [1] = No
    expect(isChecked(pdf, 'c2_1[0]')).toBe(true)   // cash
    expect(isChecked(pdf, 'c2_1[2]')).toBe(false)  // not "other"
    expect(isChecked(pdf, 'c2_2[1]')).toBe(true)   // 3: No
    expect(isChecked(pdf, 'c3_1[1]')).toBe(true)   // 12: No
    expect(isChecked(pdf, 'c3_3[0]')).toBe(true)   // 14a: Yes
    expect(isChecked(pdf, 'c3_4[0]')).toBe(true)   // 14b: Yes
    expect(isChecked(pdf, 'c2_8[0]')).toBe(false)  // 7: not checked
    expect(isChecked(pdf, 'c1_2[1]')).toBe(true)   // G: No
    expect(isChecked(pdf, 'c1_6[0]')).toBe(true)   // H(4) amended
    expect(isChecked(pdf, 'c1_7[0]')).toBe(false)  // H(5) S election termination
    expect(isChecked(pdf, 'c3_8[0]')).toBe(true)   // Sch K 14b
    expect(isChecked(pdf, 'c1_11[1]')).toBe(true)  // may the IRS discuss: No
    expect(textValue(pdf, 'f2_2')).toBe('Consulting')
    expect(textValue(pdf, 'f2_3')).toBe('Advice')
    expect(textValue(pdf, 'f1_16')).toBe('2')
    expect(textValue(pdf, 'f1_57')).toBe('Pat Preparer')
    expect(textValue(pdf, 'f1_58')).toBe('P00000000')
    expect(textValue(pdf, 'f1_59')).toBe('Prep LLC')
    expect(textValue(pdf, 'f1_62')).toBe('(555)000-0000')
    expect(textValue(pdf, 'f1_9') || '').toBe('')  // no country for a US address
  })

  it('writes nothing on another year\'s layout', async () => {
    const pdf = await PDFDocument.load(readFileSync('data/irs_forms/f1120s_2024.pdf'))
    expect(fill1120SAnswers(pdf.getForm(), 2024, { answers })).toBe(0)
  })

  it('an accrual-basis 2024 return checks Accrual only, not Other as well', async () => {
    const { pdf } = await buildReturnPdf({
      formType: '1120S', taxYear: 2024,
      entity: { ...entity, meta: { sched_k: { accounting_method: 'accrual' } } },
      fieldValues: { 'income.L1a_gross_receipts': 1000 },
    })
    const v = widgetValues(pdf)
    expect(v.get('c2_1[1]')).toBe('CHECKED')
    expect(v.has('c2_1[2]')).toBe(false)
  })
})

function ctx(inputData: Record<string, any>, taxYear = 2025): AttachmentContext {
  return { formType: '1120S', taxYear, entity, model: {}, inputData, computedData: {} }
}

describe('Schedule D (Form 1120-S)', () => {
  const sched = {
    qof_disposed: 'no',
    rows: { L1a: { proceeds: 50_000, cost: 49_000 }, L8a: { proceeds: 10_000, cost: 12_500 } },
    part3: { L17: 77_000 },
  }

  it('fills each column of each row and derives lines 7 and 15', async () => {
    const att = await buildScheduleD1120S(ctx({ schedule_d_1120s: sched }))
    expect(att).not.toBeNull()
    const pdf = att!.pdf
    expect(textValue(pdf, 'f1_1')).toBe('Parity Test Inc')
    expect(textValue(pdf, 'f1_3')).toBe('50,000')   // 1a (d) proceeds
    expect(textValue(pdf, 'f1_4')).toBe('49,000')   // 1a (e) cost
    expect(textValue(pdf, 'f1_6')).toBe('1,000')    // 1a (h) gain, derived
    expect(textValue(pdf, 'f1_22')).toBe('1,000')   // line 7
    expect(textValue(pdf, 'f1_26')).toBe('-2,500')  // 8a (h)
    expect(textValue(pdf, 'f1_43')).toBe('-2,500')  // line 15
    expect(textValue(pdf, 'f2_2')).toBe('77,000')   // Part III line 17
    expect(isChecked(pdf, 'c1_1[1]')).toBe(true)    // QOF: No
  })

  it('is not attached without data, or for another year', async () => {
    expect(await buildScheduleD1120S(ctx({}))).toBeNull()
    expect(await buildScheduleD1120S(ctx({ schedule_d_1120s: sched }, 2024))).toBeNull()
  })
})

describe('Schedule K-1 (Form 1120-S) 2025', () => {
  const alloc = {
    name: 'Sam Shareholder', pct: 100, ordinary_income: 500_000, charitable: 0, section_179: 0,
    w2_wages: 80_000, qbi_income: 500_000, ubia: 0, interest_income: 1_200, st_cap_gain: 300,
  }

  it('puts coded boxes and Part I/II items in their own fields', async () => {
    const k1 = applySupplemental(alloc, [
      { label: 'Box 16C Nondeductible expenses', amount: 900 },
      { label: 'Box 16D Distributions', amount: 250_000 },
      { label: 'Box 17V Section 199A QBI (ordinary business income)', amount: 500_000 },
      { label: 'Box 17V Section 199A W-2 wages', amount: 80_000 },
      { label: 'Box 17V SSTB', answer: 'Yes' },
      { label: 'Box 17A Investment income', amount: 1_500 },
      { label: 'Item C IRS Center', answer: '' },
      { label: 'Item I Loans from shareholder, beginning of year', amount: 5_000 },
      { label: 'Item I Loans from shareholder, end of year', amount: 0 },
    ])
    expect(k1.sstb).toBe(true)
    const { pdf } = await build1120SK1(2025, { ...entity }, { name: 'Sam Shareholder', address: '9 Elm St\nTown FL 33000' }, k1)
    const [c16r1, a16r1] = K1_1120S_CODE_ROWS_2025['16'][0]
    const [c16r2, a16r2] = K1_1120S_CODE_ROWS_2025['16'][1]
    expect(textValue(pdf, c16r1)).toBe('C')
    expect(textValue(pdf, a16r1)).toBe('900')
    expect(textValue(pdf, c16r2)).toBe('D')
    expect(textValue(pdf, a16r2)).toBe('250,000')
    // Box 17: a statement-only code (V) leaves row 1 for the caption.
    const rows17 = K1_1120S_CODE_ROWS_2025['17']
    expect(textValue(pdf, rows17[0][0]) || '').toBe('')
    expect(textValue(pdf, rows17[1][0])).toBe('V')
    expect(textValue(pdf, rows17[1][1]) || '').toBe('')
    expect(textValue(pdf, rows17[2][0])).toBe('A')
    expect(textValue(pdf, rows17[2][1])).toBe('1,500')
    expect(textValue(pdf, 'f1_16')).toBe('100')      // the form prints the %
    expect(textValue(pdf, 'f1_08') || '').toBe('')    // item C left blank as stated
    expect(textValue(pdf, 'f1_19')).toBe('5,000')     // item I, beginning
    expect(textValue(pdf, 'f1_20')).toBe('0')         // item I, end: zero is a value
    expect(textValue(pdf, 'f1_21')).toBe('500,000')   // box 1
    expect(textValue(pdf, 'f1_28')).toBe('300')       // box 7
    expect(pdf.getPageCount()).toBe(2)                // + the 199A / line 17 statement
  })

  it('keeps the K-1 route default of "e-file" for item C', async () => {
    const { pdf } = await build1120SK1(2025, { ...entity }, { name: 'Sam Shareholder' }, alloc)
    expect(textValue(pdf, 'f1_08')).toBe('e-file')
  })

  it('rides in the 1120-S package, one per shareholder', async () => {
    const atts = await buildK1s1120S(ctx({
      gross_receipts: 100_000, shareholders: [{ name: 'A', pct: 60 }, { name: 'B', pct: 40 }],
    }))
    expect(atts?.map(a => a.label)).toEqual(['Schedule K-1 (A)', 'Schedule K-1 (B)'])
    expect(textValue(atts![1].pdf, 'f1_21')).toBe('40,000')
  })
})

describe('1120-S statements', () => {
  it('prints a block per stored itemization, tied back to line 20 for meals', () => {
    const blocks = statementBlocks1120S({
      schedL_other_investments_detail: [{ label: 'Brokerage', boy: 100, eoy: 250 }],
      schedM2_other_additions_detail: [{ label: 'Interest', amount: 40 }, { label: 'Dividends', amount: 10 }],
      other_deductions_detail: [{ label: 'Rent', value: 900 }, { label: 'Meals', value: 50 }],
      meals_entertainment_detail: [{ label: '50% of meals', amount: 100, deductible: 50 }],
      amended_return_changes_detail: [{ description: 'Ordinary income', line: '22', explanation: 'x', previous: 1, amended: 2 }],
      schedK_other_items_detail: [{ label: 'V', amount: 7 }],
    })
    const titles = blocks.map(b => b.title)
    expect(titles).toContain('Statement - 1120S - Schedule L - Line 9 - Other investments')
    expect(blocks.find(b => b.title.includes('Line 9'))!.total).toEqual(['Total:', '100', '250'])
    expect(blocks.find(b => b.title.includes('M2'))!.total).toEqual(['Total:', '50', ''])
    const other = blocks.find(b => b.title.startsWith('Line 20 - Other deductions other than'))!
    expect(other.rows[0][1]).toBe('900')
    expect(other.total).toEqual(['Line 20 total:', '950'])
    expect(statementBlocks1120S({})).toEqual([])
  })
})

/**
 * 2026-10-16 blind test: with nothing typed in, the 1120-S package left out
 * K-1 codes 16C/16D/17A/17V, Schedule K line 17a and the M-2 line 3
 * statement, and its short-term gain was a dollar off its own Schedule D.
 * The figures are the Talbrook demo group's, standing in for the filed ones.
 */
describe('1120-S lines the engine now derives', () => {
  const base = {
    gross_receipts: 2_555_456, cost_of_goods_sold: 1_065_137, other_income: 10_500,
    officer_compensation: 120_000, taxes_licenses: 10_542, rents: 5_689, employee_benefits: 160, other_deductions: 202_475,
    schedule_k_interest: 28_837, schedule_k_dividends_ordinary: 511,
    schedule_k_st_cap_gain: 148,   // the 1099-B import: 147.65 rounded
    'schedK.L16c_nondeductible': 4_616, 'schedK.L16d_distributions': 905_103,
    schedule_d_1120s: { rows: { L1a: { proceeds: 1_049_201, cost: 1_049_054.22 }, L8a: { proceeds: 15_000, cost: 15_000 } } },
    shareholders: [{ name: 'Sam Shareholder', pct: 100 }],
  }

  it('takes Schedule K line 7 from the attached Schedule D, which foots in whole dollars', () => {
    const r = calc1120S(base as any)
    // 2,555,456 − 1,065,137 + 10,500 − (120,000 + 10,542 + 5,689 + 160 + 202,475)
    expect(r.computed.ordinary_income_loss).toBe(1_161_953)
    expect(r.field_values!['schedK.L7_st_capital_gain']).toBe(147)
    expect(r.field_values!['schedK.L18_income_loss']).toBe(1_191_448)   // 1,161,953 + 28,837 + 511 + 147
    expect(r.computed.k1s[0].st_cap_gain).toBe(147)
  })

  it('states 16c, 16d and 17a on Schedule K and on the K-1 allocation', () => {
    const r = calc1120S(base as any)
    expect(r.field_values!['schedK.L16c_nondeductible']).toBe(4_616)
    expect(r.field_values!['schedK.L16d_distributions']).toBe(905_103)
    expect(r.field_values!['schedK.L17a_invest_income']).toBe(29_348)   // lines 4 + 5a only
    const k1 = r.computed.k1s[0]
    expect([k1.nondeductible_expenses, k1.distributions, k1.investment_income]).toEqual([4_616, 905_103, 29_348])
  })

  it('prints 16C, 16D, 17V and 17A on the K-1 with no supplemental rows', async () => {
    const k1 = calc1120S(base as any).computed.k1s[0]
    const { pdf } = await build1120SK1(2025, { ...entity }, { name: 'Sam Shareholder' }, k1 as any)
    const r16 = K1_1120S_CODE_ROWS_2025['16']
    const r17 = K1_1120S_CODE_ROWS_2025['17']
    expect([textValue(pdf, r16[0][0]), textValue(pdf, r16[0][1])]).toEqual(['C', '4,616'])
    expect([textValue(pdf, r16[1][0]), textValue(pdf, r16[1][1])]).toEqual(['D', '905,103'])
    expect(textValue(pdf, r17[1][0])).toBe('V')
    expect([textValue(pdf, r17[2][0]), textValue(pdf, r17[2][1])]).toEqual(['A', '29,348'])
  })

  it('lets a stated code replace the implied one, never print twice', async () => {
    const alloc = calc1120S(base as any).computed.k1s[0]
    const k1 = applySupplemental(alloc as any, [
      { label: 'Box 16C Nondeductible expenses', amount: 4_616 },
      { label: 'Box 16D Distributions', amount: 905_103 },
    ])
    const { pdf } = await build1120SK1(2025, { ...entity }, { name: 'Sam Shareholder' }, k1)
    const codes16 = K1_1120S_CODE_ROWS_2025['16'].map(([c]) => textValue(pdf, c) || '')
    expect(codes16).toEqual(['C', 'D', '', '', ''])
  })

  it('prints the rounded-column gain on Schedule D itself', async () => {
    // 147.60 unrounded, which rounds to 148; the columns print as 1,049,200 and 1,049,053.
    const att = await buildScheduleD1120S(ctx({ schedule_d_1120s: { rows: { L1a: { proceeds: 1_049_200.40, cost: 1_049_052.80 } } } }))
    expect(textValue(att!.pdf, 'f1_3')).toBe('1,049,200')
    expect(textValue(att!.pdf, 'f1_4')).toBe('1,049,053')
    expect(textValue(att!.pdf, 'f1_6')).toBe('147')    // (d) - (e) as printed
    expect(textValue(att!.pdf, 'f1_22')).toBe('147')   // line 7
  })

  it('itemizes a derived M-2 line 3 by its Schedule K items', () => {
    const blocks = statementBlocks1120S({}, {
      'schedK.L4_interest': 28_837, 'schedK.L5a_dividends': 511, 'schedK.L7_st_gain': 147,
      'schedM2.L3_other_additions': 29_495,
    })
    const m2 = blocks.find(b => b.title.includes('M2'))!
    expect(m2.rows.map(r => r[1])).toEqual(['28,837', '511', '147'])
    expect(m2.total).toEqual(['Total:', '29,495', ''])
    // A stated line 3 the Schedule K items do not explain gets no invented breakdown.
    expect(statementBlocks1120S({}, { 'schedK.L4_interest': 10, 'schedM2.L3_other_additions': 99 })).toEqual([])
  })
})
