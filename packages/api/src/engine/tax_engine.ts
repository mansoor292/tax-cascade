/**
 * Tax Calculation Engine — 1120-S, 1120, 1040
 * 
 * Architecture: each form is a pure function
 *   inputs (user-entered) → computed (derived) → full return
 * 
 * References:
 *   1120-S: IRS Form 1120-S Instructions (2024)
 *   1120:   IRS Form 1120 Instructions (2024) 
 *   1040:   IRS Rev. Proc. 2023-34 (tax tables), §199A (QBI)
 */

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh' | 'qw'

export interface Form1120S_Inputs {
  // Income
  gross_receipts:       number
  returns_allowances:   number
  cost_of_goods_sold:   number
  net_gain_4797:        number
  other_income:         number
  // Deductions
  officer_compensation: number
  salaries_wages:       number
  repairs_maintenance:  number
  bad_debts:            number
  rents:                number
  taxes_licenses:       number
  interest:             number
  depreciation:         number
  depletion:            number
  advertising:          number
  pension_plans:        number
  employee_benefits:    number
  other_deductions:     number
  // Schedule K pass-through items
  charitable_contrib:   number
  section_179:          number
  // Shareholders
  shareholders:         Array<{ name: string; pct: number }>
}

export interface Form1120S_Result {
  inputs:    Form1120S_Inputs
  computed: {
    balance_1c:           number  // L1a - L1b
    gross_profit:         number  // L1c - L2
    total_income:         number  // L3+L4+L5 (L6)
    total_deductions:     number  // L7-L19 sum (L20)
    ordinary_income_loss: number  // L6 - L20 (L21)
    k1s:                  Array<{
      name:            string
      pct:             number
      ordinary_income: number
      charitable:      number
      section_179:     number
      w2_wages:        number
    }>
  }
  liabilities: { tax_due: number }  // Usually 0 for S-corp
  citations: string[]
}

export interface Form1120_Inputs {
  gross_receipts:       number
  returns_allowances:   number
  cost_of_goods_sold:   number
  dividends:            number
  interest_income:      number
  gross_rents:          number
  gross_royalties:      number
  capital_gains:        number
  net_gain_4797:        number
  other_income:         number
  // Deductions
  officer_compensation: number
  salaries_wages:       number
  repairs_maintenance:  number
  bad_debts:            number
  rents:                number
  taxes_licenses:       number
  interest_expense:     number
  charitable_contrib:   number
  depreciation:         number
  depletion:            number
  advertising:          number
  pension_plans:        number
  employee_benefits:    number
  other_deductions:     number
  // NOL / special deductions
  nol_deduction:        number
  special_deductions:   number
  // Payments
  estimated_tax_paid:   number
  tax_year:             number
}

export interface Form1120_Result {
  inputs:   Form1120_Inputs
  computed: {
    balance_1c:       number
    gross_profit:     number
    total_income:     number
    total_deductions: number
    taxable_income_before_nol: number
    taxable_income:   number
    income_tax:       number  // Schedule J
    total_tax:        number
    total_payments:   number
    balance_due:      number
    overpayment:      number
  }
  citations: string[]
}

export interface Form1040_Inputs {
  filing_status:        FilingStatus
  tax_year:             number
  // Income
  wages:                number
  taxable_interest:     number
  ordinary_dividends:   number
  qualified_dividends:  number
  ira_distributions:    number
  pensions_annuities:   number
  social_security:      number
  capital_gains:        number
  schedule1_income:     number  // schedule E (K-1s), etc.
  // Above-the-line deductions (Sched 1 Part II)
  student_loan_interest: number
  educator_expenses:    number
  // Below-the-line
  itemized_deductions:  number  // or use standard
  use_itemized:         boolean
  qbi_from_k1:         number  // §199A pass-through income
  // K-1 items flowing from 1120-S
  k1_ordinary_income:   number
  k1_w2_wages:          number
  k1_ubia:              number
  // Payments
  withholding:          number
  estimated_payments:   number
}

// ─────────────────────────────────────────────────────────────
// Year-specific tax functions imported from tax_tables.ts
// ─────────────────────────────────────────────────────────────
import { ordinaryTax, standardDeduction, qbiDeduction } from './tax_tables.js'

/** Form 1120-S calculation */
export function calc1120S(raw: Form1120S_Inputs): Form1120S_Result {
  const inp: Form1120S_Inputs = Object.assign({
    gross_receipts: 0, returns_allowances: 0, cost_of_goods_sold: 0,
    net_gain_4797: 0, other_income: 0,
    officer_compensation: 0, salaries_wages: 0, repairs_maintenance: 0,
    bad_debts: 0, rents: 0, taxes_licenses: 0, interest: 0,
    depreciation: 0, depletion: 0, advertising: 0, pension_plans: 0,
    employee_benefits: 0, other_deductions: 0,
    charitable_contrib: 0, section_179: 0,
    shareholders: [{ name: 'Shareholder', pct: 100 }],
  }, raw)
  const balance_1c = inp.gross_receipts - inp.returns_allowances
  const gross_profit = balance_1c - inp.cost_of_goods_sold
  const total_income = gross_profit + inp.net_gain_4797 + inp.other_income  // L6

  const total_deductions = (
    inp.officer_compensation + inp.salaries_wages + inp.repairs_maintenance +
    inp.bad_debts + inp.rents + inp.taxes_licenses + inp.interest +
    inp.depreciation + inp.depletion + inp.advertising +
    inp.pension_plans + inp.employee_benefits + inp.other_deductions
  )  // L20

  const ordinary_income_loss = total_income - total_deductions  // L21

  // K-1 allocation — pro-rata by ownership %
  const k1s = inp.shareholders.map(s => ({
    name:            s.name,
    pct:             s.pct,
    ordinary_income: Math.round(ordinary_income_loss * s.pct / 100),
    charitable:      Math.round(inp.charitable_contrib * s.pct / 100),
    section_179:     Math.round(inp.section_179 * s.pct / 100),
    w2_wages:        Math.round((inp.salaries_wages + inp.officer_compensation) * s.pct / 100),
  }))

  return {
    inputs: inp,
    computed: { balance_1c, gross_profit, total_income, total_deductions, ordinary_income_loss, k1s },
    liabilities: { tax_due: 0 },  // S-corp: tax paid at shareholder level
    citations: [
      '1120-S Instructions (2024): Line 6 = Lines 3+4+5',
      '1120-S Instructions (2024): Line 20 = Sum of Lines 7-19',
      '1120-S Instructions (2024): Line 21 = Line 6 - Line 20',
      'Schedule K-1: Pro-rata allocation per IRC §1366',
    ]
  }
}

/** Default missing numeric fields to 0 */
function defaults<T extends Record<string, any>>(inp: T, exclude: string[] = []): T {
  const result = { ...inp }
  for (const [k, v] of Object.entries(result)) {
    if (v === undefined && !exclude.includes(k)) (result as any)[k] = 0
  }
  return result
}

/** Form 1120 calculation */
export function calc1120(raw: Form1120_Inputs): Form1120_Result {
  const inp: Form1120_Inputs = Object.assign({
    gross_receipts: 0, returns_allowances: 0, cost_of_goods_sold: 0,
    dividends: 0, interest_income: 0, gross_rents: 0, gross_royalties: 0,
    capital_gains: 0, net_gain_4797: 0, other_income: 0,
    officer_compensation: 0, salaries_wages: 0, repairs_maintenance: 0,
    bad_debts: 0, rents: 0, taxes_licenses: 0, interest_expense: 0,
    charitable_contrib: 0, depreciation: 0, depletion: 0, advertising: 0,
    pension_plans: 0, employee_benefits: 0, other_deductions: 0,
    nol_deduction: 0, special_deductions: 0, estimated_tax_paid: 0,
    tax_year: 2025,
  }, raw)
  const balance_1c = inp.gross_receipts - inp.returns_allowances
  const gross_profit = balance_1c - inp.cost_of_goods_sold
  const total_income = (
    gross_profit + inp.dividends + inp.interest_income +
    inp.gross_rents + inp.gross_royalties + inp.capital_gains +
    inp.net_gain_4797 + inp.other_income
  )  // L11

  const total_deductions = (
    inp.officer_compensation + inp.salaries_wages + inp.repairs_maintenance +
    inp.bad_debts + inp.rents + inp.taxes_licenses + inp.interest_expense +
    inp.charitable_contrib + inp.depreciation + inp.depletion +
    inp.advertising + inp.pension_plans + inp.employee_benefits + inp.other_deductions
  )  // L27 (simplified — excludes L25 special deductions pre-calc)

  const taxable_income_before_nol = total_income - total_deductions  // L28
  const taxable_income = Math.max(0, taxable_income_before_nol - inp.nol_deduction - inp.special_deductions)  // L30

  // Schedule J: 21% flat rate (TCJA 2017, permanent for C-corps)
  const income_tax = Math.round(taxable_income * 0.21)  // Sch J L2
  const total_tax = income_tax  // simplified (no AMT/credits for demo)

  const total_payments = inp.estimated_tax_paid
  const net = total_tax - total_payments
  const balance_due  = Math.max(0, net)
  const overpayment  = Math.max(0, -net)

  return {
    inputs: inp,
    computed: {
      balance_1c, gross_profit, total_income, total_deductions,
      taxable_income_before_nol, taxable_income,
      income_tax, total_tax, total_payments, balance_due, overpayment
    },
    citations: [
      '1120 Instructions (2024): Line 11 = Lines 3-10',
      '1120 Instructions (2024): Line 27 = Lines 12-26',
      '1120 Instructions (2024): Line 30 = Line 28 - Line 29c',
      'IRC §11(b): Corporate tax rate 21%',
      'TCJA 2017: Flat 21% rate effective TY2018+',
    ]
  }
}

/** Form 1040 calculation */
export function calc1040(raw: Form1040_Inputs): {
  computed: Record<string,number>
  citations: string[]
} {
  const inp: Form1040_Inputs = Object.assign({
    filing_status: 'single' as FilingStatus, tax_year: 2025,
    wages: 0, taxable_interest: 0, ordinary_dividends: 0, qualified_dividends: 0,
    ira_distributions: 0, pensions_annuities: 0, social_security: 0,
    capital_gains: 0, schedule1_income: 0,
    student_loan_interest: 0, educator_expenses: 0,
    itemized_deductions: 0, use_itemized: false,
    qbi_from_k1: 0, k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
    withholding: 0, estimated_payments: 0,
  }, raw)
  // Line 9: Total income
  const total_income = (
    inp.wages + inp.taxable_interest + inp.ordinary_dividends +
    inp.ira_distributions + inp.pensions_annuities +
    Math.round(inp.social_security * 0.85) +  // simplified: 85% taxable
    inp.capital_gains + inp.schedule1_income + inp.k1_ordinary_income
  )

  // Line 10: Adjustments (Schedule 1 Part II)
  const adjustments = inp.student_loan_interest + inp.educator_expenses

  const agi = total_income - adjustments  // Line 11

  // Lines 12-14: Deduction (year-specific standard deduction)
  const std = standardDeduction(inp.filing_status, inp.tax_year)
  const deduction = inp.use_itemized ? Math.max(inp.itemized_deductions, std) : std

  // QBI deduction (§199A) — Line 13 (year-specific thresholds)
  const tentative_taxable = Math.max(0, agi - deduction)
  const qbi_deduction = qbiDeduction(
    inp.k1_ordinary_income + inp.qbi_from_k1,
    inp.k1_w2_wages,
    inp.k1_ubia,
    tentative_taxable,
    inp.filing_status,
    inp.tax_year
  )

  const taxable_income = Math.max(0, tentative_taxable - qbi_deduction)  // Line 15

  // Line 16: Tax (year-specific brackets)
  const income_tax = ordinaryTax(taxable_income, inp.filing_status, inp.tax_year)

  // Lines 25-33: Payments
  const total_payments = inp.withholding + inp.estimated_payments

  const total_tax = income_tax  // simplified (no SE tax, AMT, etc.)
  const net = total_tax - total_payments
  const refund   = Math.max(0, -net)
  const owed     = Math.max(0, net)

  return {
    computed: {
      total_income, adjustments, agi, deduction, qbi_deduction,
      taxable_income, income_tax, total_tax,
      total_payments, refund, owed,
    },
    citations: [
      `IRS tax brackets for TY${inp.tax_year} (from TAX_TABLES)`,
      'IRC §63(c): Standard deduction',
      'IRC §199A: QBI deduction (year-specific thresholds)',
      'IRC §86: Social security taxability (simplified at 85%)',
    ]
  }
}

// ─────────────────────────────────────────────────────────────
// EXTENSION FORMS (4868, 7004, 8868)
// ─────────────────────────────────────────────────────────────

export type ExtensionType = '4868' | '7004' | '8868'

export interface ExtensionInputs {
  extension_type:          ExtensionType
  tax_year:                number
  // Identification
  taxpayer_name:           string
  taxpayer_id:             string    // SSN (4868) or EIN (7004/8868)
  address:                 string
  city:                    string
  state:                   string
  zip:                     string
  // Tax estimates
  estimated_tax_liability: number
  total_payments:          number
  amount_paying:           number
  // 4868-specific
  spouse_ssn?:             string
  out_of_country?:         boolean
  form_1040nr_no_wages?:   boolean
  // 7004-specific
  form_code?:              string    // 2-digit code (e.g. '12' for 1120, '25' for 1120-S)
  calendar_year?:          number
  is_foreign_corp?:        boolean
  is_consolidated_parent?: boolean
  // 8868-specific
  return_code?:            string    // 2-digit code (e.g. '01' for 990, '04' for 990-PF)
  org_books_care_of?:      string
  telephone?:              string
  fax?:                    string
  extension_date?:         string
}

export interface ExtensionResult {
  inputs:   ExtensionInputs
  computed: {
    balance_due:  number
    overpayment:  number
  }
  citations: string[]
}

/** Extension form calculation — applies to 4868, 7004, 8868 */
export function calcExtension(inp: ExtensionInputs): ExtensionResult {
  const balance_due  = Math.max(0, inp.estimated_tax_liability - inp.total_payments)
  const overpayment  = Math.max(0, inp.total_payments - inp.estimated_tax_liability)

  const formNames: Record<ExtensionType, string> = {
    '4868': 'Form 4868 — Individual Extension',
    '7004': 'Form 7004 — Business Extension',
    '8868': 'Form 8868 — Exempt Organization Extension',
  }

  return {
    inputs: inp,
    computed: { balance_due, overpayment },
    citations: [
      `${formNames[inp.extension_type]}: Balance due = Estimated tax - Total payments`,
      `${formNames[inp.extension_type]}: Line balance = max(0, ${inp.estimated_tax_liability} - ${inp.total_payments}) = ${balance_due}`,
      'Extension does not extend the time to pay — interest accrues on unpaid amounts',
    ]
  }
}

/**
 * CASCADE — multi-entity scenario
 * 1120-S → K-1s → 1040
 */
export function calcCascade(
  s_corp_inputs: Form1120S_Inputs,
  individual_base: Omit<Form1040_Inputs, 'k1_ordinary_income' | 'k1_w2_wages' | 'k1_ubia'>
): {
  s_corp:     Form1120S_Result
  individual: ReturnType<typeof calc1040>
  delta: {
    s_corp_income:    number
    k1_to_individual: number
    individual_tax:   number
    qbi_saved:        number
  }
} {
  const s_corp = calc1120S(s_corp_inputs)
  
  // Find the primary shareholder's K-1
  const primary_k1 = s_corp.computed.k1s[0]  // assumes first = owner

  const individual = calc1040({
    ...individual_base,
    k1_ordinary_income: primary_k1.ordinary_income,
    k1_w2_wages:        primary_k1.w2_wages,
    k1_ubia:            0,
  })

  return {
    s_corp,
    individual,
    delta: {
      s_corp_income:    s_corp.computed.ordinary_income_loss,
      k1_to_individual: primary_k1.ordinary_income,
      individual_tax:   individual.computed.income_tax,
      qbi_saved:        individual.computed.qbi_deduction,
    }
  }
}
