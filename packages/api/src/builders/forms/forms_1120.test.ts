/**
 * Form 1120 package — attachments and main-form fixes from the 2026-10-15
 * filed-return parity sprint. Synthetic figures only.
 *
 * Each test reads what a box actually holds (widget /V, checkbox /AS) on the
 * rendered package, page by page, so a value on the wrong line fails here the
 * way it failed against the filed return.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } from 'pdf-lib'
import { buildReturnPdf, schedKFromDetail } from '../build_return_pdf.js'
import { calc1120 } from '../../engine/tax_engine.js'
import { buildForm2220 } from './form_2220.js'
import { buildScheduleO } from './form_1120_schedule_o.js'
import { buildForm1125E } from './form_1125e.js'
import { buildScheduleG } from './form_1120_schedule_g.js'
import { buildForm4562 } from './form_4562.js'
import { sections1120 } from './statements_1120.js'
import type { AttachmentContext, Attachment } from './types.js'

type Page = Record<string, string>

/** Every widget on every page: short name ("f1_6[0]") → value; checked boxes → 'X'. */
function pages(pdf: PDFDocument): Page[] {
  return pdf.getPages().map(p => {
    const out: Page = {}
    const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const a = annots!.lookup(i, PDFDict)
      const t = a.lookup(PDFName.of('T'))
      const name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : ''
      if (!name) continue
      const as = a.lookup(PDFName.of('AS'))
      if (as instanceof PDFName) { out[name] = as.asString() !== '/Off' ? 'X' : ''; continue }
      const v = a.lookup(PDFName.of('V'))
      out[name] = v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : ''
    }
    return out
  })
}

const entity = {
  name: 'Synthetic Corp', ein: '00-0000000',
  address: '1 TEST WAY STE 9Z', city: 'TESTVILLE', state: 'FL', zip: '33301',
  meta: {
    business_code: '541519', business_activity: 'OLD ACTIVITY', product_service: 'WIDGETS',
    owners: [{ name: 'SOLE OWNER', ssn: '***-**-0000', country: 'US', pct: '100%' }],
    sched_k: { K1_method: 'accrual', K28_controlled_group: 'yes', K29c_safe_harbor: 'no' },
  },
}
function ctx(inputData: Record<string, any>, model: Record<string, any> = {}): AttachmentContext {
  return { formType: '1120', taxYear: 2025, entity, model, inputData, computedData: {} }
}
const one = (a: Attachment | Attachment[] | null): Attachment => {
  expect(a).toBeTruthy()
  return Array.isArray(a) ? a[0] : a!
}

describe('Form 2220 attachment', () => {
  it('prints Parts I, III and IV from the same calculation as line 34', async () => {
    const a = one(await buildForm2220(ctx({ form2220: { prior_year_tax: 100_000 } }, { 'tax.L31_total_tax': 40_000 })))
    const p = pages(a.pdf)
    expect(p).toHaveLength(4)
    expect(p[0]['f1_3[0]']).toBe('40,000')       // line 1
    expect(p[0]['f1_9[0]']).toBe('100,000')      // line 4
    expect(p[0]['f1_15[0]']).toBe('10,000')      // line 10 (a)
    expect(p[0]['f1_31[0]'] ?? '').toBe('')      // line 14 (a) is shaded
    expect(p[0]['f1_32[0]']).toBe('10,000')      // line 14 (b)
    expect(p[1]['f2_5[0]']).toBe('365')          // line 20 (a)
    expect(p[1]['f2_13[0]']).toBe('146')         // line 22 (a)
    expect(p[1]['f2_77[0]']).toBe('1,807')       // line 38
  })
  it('prints an as-filed Schedule A Part III verbatim, cents and all', async () => {
    const a = one(await buildForm2220(ctx({ form2220: { prior_year_tax: 100_000, schedule_a_part3: { L35: ['1.25'], L37: [3] } } }, { 'tax.L31_total_tax': 40_000 })))
    const p = pages(a.pdf)
    expect(p[3]['f4_65[0]']).toBe('1.25')
    expect(p[3]['f4_73[0]']).toBe('3')
  })
  it('is not attached without Form 2220 inputs', async () => {
    expect(await buildForm2220(ctx({}, { 'tax.L31_total_tax': 40_000 }))).toBeNull()
  })
})

describe('Schedule O', () => {
  it('ticks the group type, entire year and plan boxes and lists members with totals', async () => {
    const a = one(await buildScheduleO(ctx({ schedO: {
      group_type: 'brother_sister', entire_year: true, plan: 'none',
      members: [{ name: 'MEMBER ONE', year_end: '12/2025', ae_credit: 100, est_tax_penalty: 200, other: 0 },
        { name: 'MEMBER TWO', ein: '***', year_end: '12/2025', ae_credit: 50, est_tax_penalty: 25, other: 0 }],
    } })))
    const p = pages(a.pdf)
    expect(p[0]['c1_1[1]']).toBe('X')
    expect(p[0]['c1_2[0]']).toBe('X')
    expect(p[0]['c1_5[0]']).toBe('X')
    expect(p[1]['f2_2[0]']).toBe('MEMBER ONE')
    expect(p[1]['f2_4[0]']).toBe('12/2025')
    expect(p[1]['f2_9[0]']).toBe('MEMBER TWO')
    expect(p[1]['f2_10[0]'] ?? '').toBe('')       // a masked/partial EIN never prints
    expect(p[1]['f2_71[0]']).toBe('150')
    expect(p[1]['f2_72[0]']).toBe('225')
  })
})

describe('Form 1125-E', () => {
  it('rounds once, prints no masked SSN, and serves the 1120-S too', async () => {
    const detail = [{ label: 'OFFICER A', ssn: '***-**-1111', time_pct: 100, common_pct: 60, preferred_pct: 0, amount: 100_000.4 },
      { label: 'OFFICER B', time_pct: 50, common_pct: 40, preferred_pct: 0, amount: 20_000.4 }]
    for (const formType of ['1120', '1120S']) {
      const a = one(await buildForm1125E({ ...ctx({ officer_compensation_detail: detail }), formType }))
      const p = pages(a.pdf)
      expect(p).toHaveLength(1)
      expect(p[0]['f1_3[0]']).toBe('OFFICER A')
      expect(p[0]['f1_4[0]'] ?? '').toBe('')
      expect(p[0]['f1_8[0]']).toBe('100,000')
      expect(p[0]['f1_9[0]']).toBe('OFFICER B')
      expect(p[0]['f1_123[0]']).toBe('120,001')   // 120,000.80, rounded once
      expect(p[0]['f1_125[0]']).toBe('120,001')
    }
  })
})

describe('Schedule G', () => {
  it('puts individuals in Part II and entities in Part I, form page only', async () => {
    const a = one(await buildScheduleG(ctx({ schedG_detail: [
      { label: 'PERSON ONE', kind: 'individual', country: 'US', pct_voting_stock: 80 },
      { label: 'HOLDCO LLC', kind: 'entity', entity_type: 'Partnership', country: 'US', pct_voting_stock: 20 },
    ] })))
    const p = pages(a.pdf)
    expect(p).toHaveLength(1)
    expect(p[0]['f1_32_0_[0]']).toBe('PERSON ONE')
    expect(p[0]['f1_38_0_[0]']).toBe('80')
    expect(p[0]['f1_4_0_[0]']).toBe('HOLDCO LLC')
    expect(p[0]['f1_6_0_[0]']).toBe('Partnership')
  })
  it('falls back to the standing owners, as individuals, never printing a masked SSN', async () => {
    const p = pages(one(await buildScheduleG(ctx({}))).pdf)
    expect(p[0]['f1_32_0_[0]']).toBe('SOLE OWNER')
    expect(p[0]['f1_33_0_[0]'] ?? '').toBe('')
    expect(p[0]['f1_4_0_[0]'] ?? '').toBe('')
  })
})

describe('Form 4562', () => {
  it('puts each line in its 2025 box (not 14/17/28-29 as before)', async () => {
    const model = { 'dep.L1_179_limit': 1_000, 'dep.L14_special_allowance': 11, 'dep.L17_macrs_prior': 22,
      'dep.L22_total': 33, 'dep.L43_amortization': 44, 'dep.L44_total_amort': 44 }
    const a = one(await buildForm4562(ctx({ macrs_19_detail: [{ row: 'b', period: '5', convention: 'MQ', method: '200 DB' }] }, model)))
    const p = pages(a.pdf)
    expect(p).toHaveLength(3)
    expect(p[0]['f1_2[0]']).toBe('1120')
    expect(p[0]['f1_4[0]']).toBe('1,000')
    expect(p[0]['f1_22[0]']).toBe('11')
    expect(p[0]['f1_25[0]']).toBe('22')
    expect([p[0]['f1_34[0]'], p[0]['f1_35[0]'], p[0]['f1_36[0]']]).toEqual(['5', 'MQ', '200 DB'])
    expect(p[1]['f2_2[0]']).toBe('33')
    expect(p[1]['f2_57[0]'] ?? '').toBe('')
    expect(p[2]['f3_13[0]']).toBe('44')
    expect(p[2]['f3_14[0]']).toBe('44')
  })
})

describe('1120 statements', () => {
  it('splits meals out of line 26 and keeps blank rows', () => {
    const { main, cogs } = sections1120({
      other_deductions_detail: [{ label: 'Meals', kind: 'meals', total: 200, amount: 100 }, { label: 'Gifts', amount: null }, { label: 'Office', amount: 5 }],
      schedL_other_assets_detail: [{ label: 'Deposit', boy: 1, eoy: 2 }],
      other_costs_detail: [{ label: 'Fees', amount: 7 }],
    })
    expect(main.map(s => s.title)).toEqual([
      'Schedule L - Line 14 - Other assets',
      'Line 26 - Other deductions - Meals and entertainment',
      'Line 26 - Other deductions - Other than meals and entertainment',
    ])
    expect(main[1].rows[0].cols).toEqual([200, 100])
    expect(main[2].rows.map(r => r.cols[0])).toEqual([null, 5])
    expect(cogs[0].rows[0]).toEqual({ label: 'Fees', cols: [7] })
  })
})

describe('schedKFromDetail', () => {
  it('keys answers by question number; a bare number answers its (a) part; blank is a deliberate blank', () => {
    const r = schedKFromDetail([
      { label: '1 Accounting method', answer: 'Accrual' },
      { label: '2b Business activity', answer: 'Design' },
      { label: '10 Number of shareholders', answer: '' },
      { label: '28 Controlled group', answer: 'Yes - brother-sister' },
      { label: '29 Corporate AMT', answer: 'No' },
      { label: '29c Safe harbor', answer: '' },
    ])
    expect(r.answers).toMatchObject({ K1_method: 'accrual', K28_controlled_group: 'yes', K29a_59k: 'no', K29c_safe_harbor: '' })
    expect(r.text['2b']).toBe('Design')
    expect(r.text['10']).toBe('')
  })
})

describe('Form 1120 main form (2025)', () => {
  const inputs: any = {
    gross_receipts: 1_000_000, cost_of_goods_sold: 5_000, salaries_wages: 804_524, estimated_tax_paid: 0, tax_year: 2025,
    form2220: { prior_year_tax: 100_000 },
  }
  async function render(extra: Record<string, any> = {}) {
    const r = calc1120(inputs)
    const fieldValues: Record<string, any> = {
      ...r.field_values, 'cogs.L5_other': 5_000, 'cogs.L6_total': 5_000, 'cogs.L8_cogs': 5_000,
      'meta.suite': '9Z', 'meta.country': 'United States',
      'schedL.L2a_trade_boy_a': 0, 'schedL.L2a_trade_boy_b': 0, 'schedL.L2a_trade_eoy_c': 700, 'schedL.L2a_trade_eoy_d': 700,
      'schedL.L2b_baddebt_boy_b': 0, 'schedL.L2b_baddebt_eoy_d': 0,
      'schedM1.L5c_travel_ent': 300, 'schedM1.L8a_depreciation': 400,
    }
    const inputData = {
      ...inputs,
      schedK_answers_detail: [{ label: '2b Business activity', answer: 'NEW ACTIVITY' }, { label: '10 Number of shareholders', answer: '' },
        { label: '29a x', answer: 'No' }, { label: '29b x', answer: 'No' }, { label: '29c x', answer: '' }],
      discuss_with_preparer: 'no',
      schedM1_L8_items: [{ label: 'State tax accrual', amount: 123 }],
      schedM2_L3_items: [{ label: 'Book-tax difference', amount: 456 }],
      ...extra,
    }
    const { pdf } = await buildReturnPdf({ formType: '1120', taxYear: 2025, entity, fieldValues, inputData })
    return { p: pages(pdf), count: pdf.getPageCount(), r }
  }

  it('line 34 carries the Form 2220 penalty and its box is ticked', async () => {
    const { p, r } = await render()
    expect(r.field_values!['payments.L34_est_penalty']).toBeGreaterThan(0)
    expect(p[0]['f1_51[0]']).toBe(r.field_values!['payments.L34_est_penalty'].toLocaleString('en-US'))
    expect(p[0]['c1_10[0]']).toBe('X')
    expect(p[0]['c1_12[1]']).toBe('X')       // discuss with preparer: No
  })
  it('does not print a suite already in the address, or a US country', async () => {
    const { p } = await render()
    expect(p[0]['f1_6[0]'] ?? '').toBe('')
    expect(p[0]['f1_9[0]'] ?? '').toBe('')
  })
  it('keeps cost of goods sold off Schedule J line 6 (Total credits)', async () => {
    const { p } = await render()
    expect(p[2]['f3_18[0]'] ?? '').toBe('')
  })
  it('takes Schedule K answers and text from the return over the standing ones', async () => {
    const { p } = await render()
    expect(p[3]['f4_3[0]']).toBe('NEW ACTIVITY')
    expect(p[3]['f4_35[0]'] ?? '').toBe('')
    expect(p[4]['c5_18[1]']).toBe('X')          // 29a No
    expect(p[4]['c5_19[1]']).toBe('X')          // 29b No
    expect(p[4]['c5_20[1]'] ?? '').toBe('')     // 29c deliberately blank, overriding the standing "no"
    expect(p[4]['c5_17[0]']).toBe('X')          // 28 Yes (standing)
  })
  it('prints the net receivable on line 2b and the M-1 / M-2 detail', async () => {
    const { p } = await render()
    expect(p[5]['f6_12[0]']).toBe('700')
    expect(p[5]['f6_141[0]']).toBe('300')
    expect(p[5]['f6_149[0]']).toBe('400')
    expect(p[5]['f6_151[0]']).toBe('State tax accrual 123')
    expect(p[5]['f6_159[0]']).toBe('Book-tax difference 456')
  })
  it('attaches the 1125-A form page without its instruction pages', async () => {
    const { count } = await render({ form2220: undefined })
    // 6 (1120) + 1 (1125-A) + 1 (1125-A line 5 statement is absent: no detail) — no Schedule G? owners present → 1
    expect(count).toBe(8)
  })
})
