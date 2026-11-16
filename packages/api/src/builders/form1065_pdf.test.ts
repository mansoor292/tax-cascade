/**
 * Form 1065 package: the main form fills from the engine's keys on the right
 * lines, and one K-1 per partner rides along carrying its capital account and
 * coded boxes. Fictional partnership.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildReturnPdf } from './build_return_pdf.js'
import { calc1065 } from '../engine/form1065.js'

const entity = {
  name: 'Fictional Ridge Partners', ein: '00-0000000', address: '1 Test Way', city: 'Testville', state: 'FL', zip: '33301',
  meta: { accounting_method: 'cash', partnership_type: 'general_partnership', sched_b: { '4': 'yes', '5': 'no' } },
}
const inputs = {
  tax_year: 2025, gross_receipts: 912_345, cost_of_goods_sold: 101_010, salaries_wages: 202_020,
  rents: 30_303, other_deductions: 40_404, schedule_k_interest: 5_050, distributions: 60_606,
  other_deductions_detail: [{ label: 'Software', amount: 40_404 }],
  partners: [
    { name: 'Alder Partner', partner_type: 'general' as const, profit_pct: 70, guaranteed_payments_services: 70_707, capital_beginning: 10_000 },
    { name: 'Birch Partner', partner_type: 'limited' as const, profit_pct: 30, capital_beginning: 5_000 },
  ],
}

async function render() {
  const r = calc1065(inputs)
  const res = await buildReturnPdf({ formType: '1065', taxYear: 2025, entity, inputData: inputs, fieldValues: r.field_values, computedData: { k1s: r.k1s } })
  const dir = mkdtempSync(path.join(tmpdir(), 'f1065-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await res.pdf.save())
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    return { r, res, text }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const row = (text: string, re: RegExp) => text.split('\n').find(l => re.test(l)) ?? ''

describe('Form 1065 PDF package', () => {
  it('renders the 2025 form with each line on its own row', async () => {
    const { r, res, text } = await render()
    expect(res.formYear).toBe(2025)
    expect(row(text, /Gross receipts or sales/)).toContain('912,345')
    expect(row(text, /Guaranteed payments to partners/)).toContain('70,707')
    const obi = (r.field_values['tax.L23_ordinary_business_income'] as number).toLocaleString('en-US')
    expect(text).toContain(obi)
    expect(row(text, /Interest income/)).toContain('5,050')
    expect(row(text, /Distributions of cash and marketable/)).toContain('60,606')
  })

  it('attaches 1125-A, the line 21 statement and one K-1 per partner', async () => {
    const { res, text } = await render()
    expect(res.forms).toEqual(expect.arrayContaining(['Form 1125-A', 'Statements', 'Schedule K-1 — Alder Partner', 'Schedule K-1 — Birch Partner']))
    expect(text).toMatch(/Form 1065, Line 21 . Other Deductions/)
  })

  it('prints the K-1 capital account and self-employment box', async () => {
    const { r, text } = await render()
    const alder = r.k1s[0]
    expect(text).toContain(alder.capital_ending.toLocaleString('en-US'))
    expect(text).toContain(alder.se_earnings.toLocaleString('en-US'))
    expect(text).toMatch(/Statement A \(Section 199A information\)/)
  })
})
