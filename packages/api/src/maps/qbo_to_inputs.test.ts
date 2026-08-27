/**
 * Books-to-tax mapping (SOP 05).
 *
 * This is where a QuickBooks chart of accounts becomes IRS form lines, and
 * it is the largest piece of judgement in the codebase. The rule that
 * matters most is the last one in this file: a leaf must never be silently
 * dropped. An account that matches no rule has to land in other_deductions
 * AND raise a warning — an expense that quietly disappears understates
 * deductions and overstates tax, and nothing downstream would notice.
 *
 * Inputs are flat maps in the shape flattenReport produces.
 */
import { describe, it, expect } from 'vitest'
import { buildCorporateInputsFromQbo } from './qbo_to_inputs.js'

const build = (pnl: Record<string, number>, form_type: '1120' | '1120S' = '1120S') =>
  buildCorporateInputsFromQbo({ pnl, form_type })

describe('buildCorporateInputsFromQbo — expense classification', () => {
  const cases: Array<[string, string]> = [
    ['Advertising',            'advertising'],
    ['Advertising and Promotion', 'advertising'],
    ['Repairs & Maintenance',  'repairs_maintenance'],
    ['Rent',                   'rents'],
    ['Payroll Taxes',          'taxes_licenses'],
    ['Taxes & Licenses',       'taxes_licenses'],
    ['Depreciation',           'depreciation'],
    ['Bad Debts',              'bad_debts'],
    ['Salaries & Wages',       'salaries_wages'],
    ['Contract Labor',         'salaries_wages'],
    ['Health Insurance',       'employee_benefits'],
    ['Interest Expense',       'interest'],
  ]

  for (const [account, bucket] of cases) {
    it(`routes "${account}" to ${bucket}`, () => {
      const out = build({ [`Expenses > ${account}`]: 5_000 })
      expect(out.inputs[bucket]).toBe(5_000)
    })
  }

  it('routes a 401(k) account to pension_plans', () => {
    // The rule has to survive the parentheses in the account name.
    const out = build({ 'Expenses > 401(k) Employer Match': 12_000 })
    expect(out.inputs.pension_plans).toBe(12_000)
  })

  it('sums multiple accounts landing in the same bucket', () => {
    const out = build({
      'Expenses > Advertising': 1_000,
      'Expenses > Marketing':   2_500,
    })
    expect(out.inputs.advertising).toBe(3_500)
  })
})

describe('buildCorporateInputsFromQbo — nothing may be dropped', () => {
  it('falls an unmatched expense through to other_deductions', () => {
    const out = build({ 'Expenses > Llama Grooming': 4_321 })
    expect(out.inputs.other_deductions).toBe(4_321)
  })

  it('warns when an expense falls through, rather than doing it silently', () => {
    const out = build({ 'Expenses > Llama Grooming': 4_321 })
    expect(out.warnings.length).toBeGreaterThan(0)
    expect(JSON.stringify(out.warnings)).toMatch(/other_deductions/i)
  })

  it('accounts for every expense dollar somewhere in the output', () => {
    // The strongest invariant available: total classified deductions must
    // equal total expenses in. Any shortfall is money the return will not
    // deduct.
    const pnl = {
      'Expenses > Advertising':          1_000,
      'Expenses > Rent':                 2_000,
      'Expenses > Llama Grooming':       3_000,
      'Expenses > Insurance > Business Insurance': 4_000,
    }
    const out = build(pnl)
    const expensesIn = Object.values(pnl).reduce((a, b) => a + b, 0)

    const deductionBuckets = [
      'officer_compensation', 'salaries_wages', 'repairs_maintenance', 'bad_debts',
      'rents', 'taxes_licenses', 'interest', 'depreciation', 'depletion',
      'advertising', 'pension_plans', 'employee_benefits', 'other_deductions',
    ]
    const classified = deductionBuckets.reduce((s, k) => s + (out.inputs[k] || 0), 0)
    expect(classified).toBe(expensesIn)
  })

  it('reaches leaves nested more than one level deep', () => {
    // Regression: an earlier implementation only walked depth-1 leaves and
    // silently dropped accounts like Expenses > Insurance > Business Insurance.
    const out = build({ 'Expenses > Insurance > Business Insurance': 4_200 })
    const total = Object.entries(out.inputs)
      .filter(([k]) => k !== 'gross_receipts' && k !== 'cost_of_goods_sold')
      .reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0)
    expect(total).toBeGreaterThanOrEqual(4_200)
  })

  it('does not double-count a section total alongside its leaves', () => {
    const out = build({
      'Expenses > Advertising': 1_000,
      'Expenses > Rent':        2_000,
      'Expenses (Total)':       3_000,   // subtotal, not an account
    })
    expect(out.inputs.advertising).toBe(1_000)
    expect(out.inputs.rents).toBe(2_000)
    expect(out.inputs.other_deductions || 0).toBe(0)
  })
})

describe('buildCorporateInputsFromQbo — income', () => {
  it('maps ordinary revenue to gross receipts', () => {
    const out = build({ 'Income > Consulting Revenue': 500_000 })
    expect(out.inputs.gross_receipts).toBe(500_000)
  })

  // NOTE: the section prefix is QBO's group name "OtherIncome" (no space),
  // confirmed against the captured report fixture. Writing "Other Income"
  // here silently matches nothing — which is how this test was wrong first
  // time round.
  it('keeps portfolio interest out of ordinary business income on an 1120S', () => {
    // Interest is a separately-stated Schedule K item, not trade or business
    // income. Folding it into gross receipts would misstate both the K-1 and
    // the shareholder's return.
    const out = build({
      'Income > Consulting Revenue': 500_000,
      'OtherIncome > Interest Earned': 12_000,
    }, '1120S')
    expect(out.inputs.gross_receipts).toBe(500_000)
    expect(out.inputs.schedule_k_interest).toBe(12_000)
  })

  it('separates dividend income from ordinary income', () => {
    const out = build({
      'Income > Consulting Revenue': 500_000,
      'OtherIncome > Dividends': 3_000,
    }, '1120S')
    expect(out.inputs.gross_receipts).toBe(500_000)
    expect(out.inputs.schedule_k_dividends_ordinary).toBe(3_000)
  })

  it('maps cost of goods sold', () => {
    const out = build({
      'Income > Product Sales': 800_000,
      'COGS > Materials': 300_000,
    })
    expect(out.inputs.gross_receipts).toBe(800_000)
    expect(out.inputs.cost_of_goods_sold).toBe(300_000)
  })
})

describe('buildCorporateInputsFromQbo — auditability', () => {
  it('records an audit entry for every account it classified', () => {
    // A number on a tax return that cannot be traced back to a book account
    // is not defensible to a client or an examiner.
    const out = build({
      'Expenses > Advertising': 1_000,
      'Expenses > Rent':        2_000,
    })
    expect(out.audit.length).toBeGreaterThanOrEqual(2)
    const paths = JSON.stringify(out.audit)
    expect(paths).toContain('Advertising')
    expect(paths).toContain('Rent')
  })

  it('is deterministic for identical input', () => {
    const pnl = { 'Expenses > Advertising': 1_000, 'Income > Revenue': 9_000 }
    expect(JSON.stringify(build(pnl).inputs)).toBe(JSON.stringify(build(pnl).inputs))
  })
})
