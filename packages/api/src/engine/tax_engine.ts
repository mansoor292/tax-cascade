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
// TAX TABLES  (IRS Rev. Proc. 2023-34 for TY2024)
// ─────────────────────────────────────────────────────────────

interface Bracket { min: number; max: number; rate: number; base_tax: number }

const TAX_BRACKETS: Record<FilingStatus, Bracket[]> = {
  single: [
    { min: 0,       max: 11600,  rate: 0.10, base_tax: 0 },
    { min: 11600,   max: 47150,  rate: 0.12, base_tax: 1160 },
    { min: 47150,   max: 100525, rate: 0.22, base_tax: 5426 },
    { min: 100525,  max: 191950, rate: 0.24, base_tax: 17168.50 },
    { min: 191950,  max: 243725, rate: 0.32, base_tax: 39110.50 },
    { min: 243725,  max: 609350, rate: 0.35, base_tax: 55678.50 },
    { min: 609350,  max: Infinity, rate: 0.37, base_tax: 183647.25 },
  ],
  mfj: [
    { min: 0,       max: 23200,  rate: 0.10, base_tax: 0 },
    { min: 23200,   max: 94300,  rate: 0.12, base_tax: 2320 },
    { min: 94300,   max: 201050, rate: 0.22, base_tax: 10852 },
    { min: 201050,  max: 383900, rate: 0.24, base_tax: 34337 },
    { min: 383900,  max: 487450, rate: 0.32, base_tax: 78221 },
    { min: 487450,  max: 731200, rate: 0.35, base_tax: 111357 },
    { min: 731200,  max: Infinity, rate: 0.37, base_tax: 196669.50 },
  ],
  mfs: [
    { min: 0,       max: 11600,  rate: 0.10, base_tax: 0 },
    { min: 11600,   max: 47150,  rate: 0.12, base_tax: 1160 },
    { min: 47150,   max: 100525, rate: 0.22, base_tax: 5426 },
    { min: 100525,  max: 191950, rate: 0.24, base_tax: 17168.50 },
    { min: 191950,  max: 243725, rate: 0.32, base_tax: 39110.50 },
    { min: 243725,  max: 365600, rate: 0.35, base_tax: 55678.50 },
    { min: 365600,  max: Infinity, rate: 0.37, base_tax: 98334.75 },
  ],
  hoh: [
    { min: 0,       max: 16550,  rate: 0.10, base_tax: 0 },
    { min: 16550,   max: 63100,  rate: 0.12, base_tax: 1655 },
    { min: 63100,   max: 100500, rate: 0.22, base_tax: 7241 },
    { min: 100500,  max: 191950, rate: 0.24, base_tax: 15469 },
    { min: 191950,  max: 243700, rate: 0.32, base_tax: 37417 },
    { min: 243700,  max: 609350, rate: 0.35, base_tax: 53977 },
    { min: 609350,  max: Infinity, rate: 0.37, base_tax: 181954.50 },
  ],
  qw: [] // same as mfj for simplicity
}

const STANDARD_DEDUCTION: Record<FilingStatus, number> = {
  single: 14600,
  mfj:    29200,
  mfs:    14600,
  hoh:    21900,
  qw:     29200,
}

// ─────────────────────────────────────────────────────────────
// CALCULATION FUNCTIONS
// ─────────────────────────────────────────────────────────────

/** Apply tax brackets — pure function */
export function applyTaxBrackets(taxable: number, status: FilingStatus): number {
  if (taxable <= 0) return 0
  const brackets = status === 'qw' ? TAX_BRACKETS.mfj : TAX_BRACKETS[status]
  for (const b of [...brackets].reverse()) {
    if (taxable > b.min) {
      return Math.round(b.base_tax + (taxable - b.min) * b.rate)
    }
  }
  return 0
}

/** QBI deduction §199A — simplified (no phase-out for demo) */
export function calcQBI(
  qbi_income: number,
  w2_wages: number,
  ubia: number,
  taxable_income: number,
  status: FilingStatus
): number {
  // Threshold: $201,050 single / $402,100 MFJ (TY2024) — simplified
  const threshold = status === 'mfj' ? 402100 : 201050
  const tentative = Math.round(qbi_income * 0.20)
  if (taxable_income <= threshold) return Math.min(tentative, Math.round(taxable_income * 0.20))
  // W-2 wage limitation kicks in above threshold
  const wage_limit = Math.round(w2_wages * 0.50)
  const wage_ubia_limit = Math.round(w2_wages * 0.25 + ubia * 0.025)
  const limited = Math.min(tentative, Math.max(wage_limit, wage_ubia_limit))
  return Math.min(limited, Math.round(taxable_income * 0.20))
}

/** Form 1120-S calculation */
export function calc1120S(inp: Form1120S_Inputs): Form1120S_Result {
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

/** Form 1120 calculation */
export function calc1120(inp: Form1120_Inputs): Form1120_Result {
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
export function calc1040(inp: Form1040_Inputs): {
  computed: Record<string,number>
  citations: string[]
} {
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

  // Lines 12-14: Deduction
  const std = STANDARD_DEDUCTION[inp.filing_status]
  const deduction = inp.use_itemized ? Math.max(inp.itemized_deductions, std) : std

  // QBI deduction (§199A) — Line 13
  const tentative_taxable = Math.max(0, agi - deduction)
  const qbi_deduction = calcQBI(
    inp.k1_ordinary_income + inp.qbi_from_k1,
    inp.k1_w2_wages,
    inp.k1_ubia,
    tentative_taxable,
    inp.filing_status
  )

  const taxable_income = Math.max(0, tentative_taxable - qbi_deduction)  // Line 15

  // Line 16: Tax
  const income_tax = applyTaxBrackets(taxable_income, inp.filing_status)

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
      'IRS Rev. Proc. 2023-34: TY2024 tax brackets',
      'IRC §63(c): Standard deduction',
      'IRC §199A: QBI deduction (20% of qualified income)',
      'IRC §86: Social security taxability (simplified at 85%)',
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
