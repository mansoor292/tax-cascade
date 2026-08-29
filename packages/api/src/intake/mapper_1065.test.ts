import { describe, it, expect } from 'vitest'
import { mapToCanonical } from './json_model_mapper.js'
import { archiveFiledReturn } from './archive_filed_return.js'

/**
 * Form 1065 import.
 *
 * The labels below are not invented: they are the exact strings the discovery
 * pipeline pulled off the IRS blank (f1065--2024.pdf, 127 fields, all
 * verified), which is also what Textract reads off a filed copy. Testing
 * against the form's own wording is the point — rules written from memory
 * match a form that does not exist.
 */
const KVS = [
  { key: 'Name of partnership', value: 'DC PARTNERS LLC' },
  { key: 'D Employer identification number', value: '87-1234567' },
  { key: 'E Date business started', value: '01/15/2019' },
  { key: 'I Number of Schedules K-1. Attach one for each person who was a partner at any time during the tax year:', value: '3' },
  { key: '1a Gross receipts or sales', value: '1,250,000' },
  { key: 'b Less returns and allowances', value: '10,000' },
  { key: '2 Cost of goods sold (attach Form 1125-A) 2', value: '400,000' },
  { key: '3 Gross profit. Subtract line 2 from line 1c 3', value: '840,000' },
  { key: '4 Ordinary income (loss) from other partnerships, estates, and trusts (attach statement) 4', value: '15,000' },
  { key: '5 Net farm profit (loss) (attach Schedule F (Form 1040)) 5', value: '0' },
  { key: '6 Net gain (loss) from Form 4797, Part II, line 17 (attach Form 4797) 6', value: '5,000' },
  { key: '7 Other income (loss) (attach statement) 7', value: '2,000' },
  { key: '8 Total income (loss). Combine lines 3 through 7 8', value: '862,000' },
  { key: '9 Salaries and wages (other than to partners) (less employment credits) 9', value: '300,000' },
  { key: '10 Guaranteed payments to partners 10', value: '120,000' },
  { key: '11 Repairs and maintenance 11', value: '8,000' },
  { key: '12 Bad debts 12', value: '1,500' },
  { key: '13 Rent 13', value: '60,000' },
  { key: '14 Taxes and licenses 14', value: '25,000' },
  { key: '15 Interest (see instructions) 15', value: '12,000' },
  { key: '16a Depreciation (if required, attach Form 4562) 16a', value: '40,000' },
  { key: '17 Depletion (Do not deduct oil and gas depletion.) 17', value: '0' },
  { key: '18 Retirement plans, etc. 18', value: '18,000' },
  { key: '19 Employee benefit programs 19', value: '22,000' },
  { key: '21 Other deductions (attach statement) 21', value: '30,000' },
  { key: '22 Total deductions. Add the amounts shown in the far right column for lines 9 through 21 22', value: '636,500' },
  { key: '23 Ordinary business income (loss). Subtract line 22 from line 8 23', value: '225,500' },
]

function mapped() {
  return mapToCanonical({
    source: 'textract', form_type: '1065', tax_year: 2024,
    key_value_pairs: KVS, tables: [],
  } as any)
}

describe('importing a filed Form 1065', () => {
  it('maps the income lines to sectioned IRS keys', () => {
    const { field_values } = archiveFiledReturn(mapped(), '1065', null)
    expect(field_values['income.L1a_gross_receipts']).toBe(1250000)
    expect(field_values['income.L2_cogs']).toBe(400000)
    expect(field_values['income.L3_gross_profit']).toBe(840000)
    expect(field_values['income.L8_total_income']).toBe(862000)
  })

  it('maps guaranteed payments, which no other form has', () => {
    const { field_values } = archiveFiledReturn(mapped(), '1065', null)
    expect(field_values['deductions.L10_guaranteed_payments']).toBe(120000)
  })

  it('maps the deduction lines', () => {
    const { field_values } = archiveFiledReturn(mapped(), '1065', null)
    expect(field_values['deductions.L9_salaries']).toBe(300000)
    expect(field_values['deductions.L13_rent']).toBe(60000)
    expect(field_values['deductions.L16a_depreciation']).toBe(40000)
    expect(field_values['deductions.L22_total_deductions']).toBe(636500)
  })

  it('carries line 23 through as the figure the partners receive', () => {
    const { field_values, totals } = archiveFiledReturn(mapped(), '1065', null)
    expect(field_values['tax.L23_ordinary_business_income']).toBe(225500)
    expect(totals.ordinary_income_loss).toBe(225500)
  })

  it('reports no tax, because a partnership owes none', () => {
    const { totals } = archiveFiledReturn(mapped(), '1065', null)
    expect(totals.total_tax).toBeUndefined()
    expect(totals.taxable_income).toBeUndefined()
    expect(totals.total_income).toBe(862000)
    expect(totals.total_deductions).toBe(636500)
  })

  it('stores only sectioned keys, never the descriptive shape', () => {
    const { field_values } = archiveFiledReturn(mapped(), '1065', null)
    const leaked = Object.keys(field_values).filter(k => /^(income|deductions|tax)\.[a-z]/.test(k))
    expect(leaked, `descriptive keys reached storage: ${leaked.join(', ')}`).toHaveLength(0)
  })

  it('covers most of what a filed return actually contains', () => {
    const m = mapped()
    expect(m.fields.length, `only ${m.fields.length} of ${KVS.length} lines mapped`).toBeGreaterThanOrEqual(20)
  })
})
