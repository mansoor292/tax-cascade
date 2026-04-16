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
  // §199A — flows to shareholders on K-1
  is_sstb?:             boolean
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
  field_values?: Record<string, number>
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
  special_deductions:   number   // Schedule C line 29b — if 0, computed from dividends via DRD
  dividends_less_20pct_owned?:  number  // for DRD — 50% deduction
  dividends_20pct_or_more_owned?: number  // for DRD — 65% deduction
  dividends_affiliated_group?:   number  // for DRD — 100% deduction
  // Credits
  foreign_tax_credit?:       number
  general_business_credit?:  number
  prior_year_min_tax_credit?: number
  other_credits?:           number
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
    special_deductions: number  // computed DRD
    taxable_income:   number
    income_tax:       number  // Schedule J line 2
    total_credits:    number  // FTC + GBC + PYMTC + other
    total_tax:        number  // after credits
    total_payments:   number
    balance_due:      number
    overpayment:      number
  }
  field_values?: Record<string, number>
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
  ltcg_portion?:        number   // portion of capital_gains that is long-term (default: 0)
  schedule1_income:     number  // schedule E (K-1s), etc.
  // Above-the-line deductions (Sched 1 Part II)
  student_loan_interest: number
  educator_expenses:    number
  // Below-the-line
  itemized_deductions:  number  // or use standard
  use_itemized:         boolean
  qbi_from_k1:         number  // §199A pass-through income
  is_sstb?:            boolean   // Specified Service Trade or Business (§199A(d))
  // K-1 items flowing from 1120-S
  k1_ordinary_income:   number
  k1_w2_wages:          number
  k1_ubia:              number
  // Self-employment
  net_se_income?:       number
  // Dependents
  num_dependents?:      number
  // Payments
  withholding:          number
  estimated_payments:   number
}

// ─────────────────────────────────────────────────────────────
// Year-specific tax functions imported from tax_tables.ts
// ─────────────────────────────────────────────────────────────
import {
  ordinaryTax, standardDeduction, qbiDeduction,
  ltcgTax, niitTax, amtTax, seTax, childTaxCredit, additionalMedicareTax,
  TAX_TABLES,
} from './tax_tables.js'

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

  // IRS-line canonical field_values for direct PDF fill
  const field_values: Record<string, number> = {
    'income.L1a_gross_receipts': inp.gross_receipts,
    'income.L1b_returns':        inp.returns_allowances,
    'income.L1c_balance':        balance_1c,
    'income.L2_cogs':            inp.cost_of_goods_sold,
    'income.L3_gross_profit':    gross_profit,
    'income.L4_net_gain_4797':   inp.net_gain_4797,
    'income.L5_other_income':    inp.other_income,
    'income.L6_total_income':    total_income,
    'deductions.L7_officer_comp':       inp.officer_compensation,
    'deductions.L8_salaries':           inp.salaries_wages,
    'deductions.L9_repairs':            inp.repairs_maintenance,
    'deductions.L10_bad_debts':         inp.bad_debts,
    'deductions.L11_rents':             inp.rents,
    'deductions.L12_taxes':             inp.taxes_licenses,
    'deductions.L13_interest':          inp.interest,
    'deductions.L14_depreciation':      inp.depreciation,
    'deductions.L15_depletion':         inp.depletion,
    'deductions.L16_advertising':       inp.advertising,
    'deductions.L17_pension':           inp.pension_plans,
    'deductions.L18_employee_benefits': inp.employee_benefits,
    'deductions.L20_other':             inp.other_deductions,
    'deductions.L21_total':             total_deductions,
    'tax.L22_ordinary_income':          ordinary_income_loss,
    // Schedule K pro-rata totals
    'schedK.L1_ordinary':               ordinary_income_loss,
    'schedK.L12a_charitable':           inp.charitable_contrib,
    'schedK.L11_section_179':           inp.section_179,
  }
  for (const k of Object.keys(field_values)) {
    if (!field_values[k]) delete field_values[k]
  }

  return {
    inputs: inp,
    computed: { balance_1c, gross_profit, total_income, total_deductions, ordinary_income_loss, k1s },
    field_values,
    liabilities: { tax_due: 0 },  // S-corp: tax paid at shareholder level
    citations: [
      '1120-S Instructions: Line 6 = Lines 3+4+5',
      '1120-S Instructions: Line 20 = Sum of Lines 7-19',
      '1120-S Instructions: Line 21 = Line 6 - Line 20',
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

  // Special deductions (Schedule C — Dividends Received Deduction per IRC §243)
  // If user didn't supply, compute from the per-ownership-tier dividends
  const computed_drd = Math.round(
    (inp.dividends_less_20pct_owned ?? 0) * 0.50 +   // <20% owned: 50% DRD
    (inp.dividends_20pct_or_more_owned ?? 0) * 0.65 + // ≥20% owned: 65% DRD
    (inp.dividends_affiliated_group ?? 0) * 1.00      // affiliated: 100% DRD
  )
  const special_deductions = inp.special_deductions || computed_drd

  const taxable_income = Math.max(0, taxable_income_before_nol - inp.nol_deduction - special_deductions)  // L30

  // Schedule J: 21% flat rate (TCJA 2017, permanent for C-corps)
  const income_tax = Math.round(taxable_income * 0.21)  // Sch J L2

  // Credits (Schedule J Part I)
  const total_credits = (inp.foreign_tax_credit ?? 0) +
    (inp.general_business_credit ?? 0) +
    (inp.prior_year_min_tax_credit ?? 0) +
    (inp.other_credits ?? 0)
  const total_tax = Math.max(0, income_tax - total_credits)

  const total_payments = inp.estimated_tax_paid
  const net = total_tax - total_payments
  const balance_due  = Math.max(0, net)
  const overpayment  = Math.max(0, -net)

  // IRS-line canonical field_values for direct PDF fill
  const field_values: Record<string, number> = {
    'income.L1a_gross_receipts':       inp.gross_receipts,
    'income.L1b_returns':              inp.returns_allowances,
    'income.L1c_balance':              balance_1c,
    'income.L2_cogs':                  inp.cost_of_goods_sold,
    'income.L3_gross_profit':          gross_profit,
    'income.L4_dividends':             inp.dividends,
    'income.L5_interest':              inp.interest_income,
    'income.L6_gross_rents':           inp.gross_rents,
    'income.L7_gross_royalties':       inp.gross_royalties,
    'income.L8_capital_gains':         inp.capital_gains,
    'income.L9_net_gain_4797':         inp.net_gain_4797,
    'income.L10_other_income':         inp.other_income,
    'income.L11_total_income':         total_income,
    'deductions.L12_officer_comp':     inp.officer_compensation,
    'deductions.L13_salaries':         inp.salaries_wages,
    'deductions.L14_repairs':          inp.repairs_maintenance,
    'deductions.L15_bad_debts':        inp.bad_debts,
    'deductions.L16_rents':            inp.rents,
    'deductions.L17_taxes_licenses':   inp.taxes_licenses,
    'deductions.L18_interest':         inp.interest_expense,
    'deductions.L19_charitable':       inp.charitable_contrib,
    'deductions.L20_depreciation':     inp.depreciation,
    'deductions.L21_depletion':        inp.depletion,
    'deductions.L22_advertising':      inp.advertising,
    'deductions.L23_pension':          inp.pension_plans,
    'deductions.L24_employee_benefits': inp.employee_benefits,
    'deductions.L26_other_deductions': inp.other_deductions,
    'deductions.L27_total_deductions': total_deductions,
    'tax.L28_ti_before_nol':           taxable_income_before_nol,
    'tax.L29a_nol':                    inp.nol_deduction,
    'tax.L29b_special_ded':            special_deductions,
    'tax.L29c_total_29':               inp.nol_deduction + special_deductions,
    'tax.L30_taxable_income':          taxable_income,
    'schedJ.J1a_income_tax':           income_tax,
    'tax.L31_total_tax':               total_tax,
    'schedJ.J14_estimated_payments':   inp.estimated_tax_paid,
    'payments.L33_total_payments':     total_payments,
    'payments.L35_amount_owed':        balance_due,
    'payments.L36_overpayment':        overpayment,
  }
  for (const k of Object.keys(field_values)) {
    if (!field_values[k]) delete field_values[k]
  }

  return {
    inputs: inp,
    computed: {
      balance_1c, gross_profit, total_income, total_deductions,
      taxable_income_before_nol, special_deductions, taxable_income,
      income_tax, total_credits, total_tax, total_payments, balance_due, overpayment
    },
    field_values,
    citations: [
      '1120 Instructions: Line 11 = Lines 3-10',
      '1120 Instructions: Line 27 = Lines 12-26',
      '1120 Instructions: Line 30 = Line 28 - Line 29c',
      'IRC §11(b): Corporate tax rate 21%',
      'IRC §243: Dividends Received Deduction (50%/65%/100% by ownership tier)',
      'IRC §38-39: General Business Credit',
      'IRC §901: Foreign Tax Credit',
    ]
  }
}

/** Form 1040 calculation — full computation including SE, NIIT, AMT, Additional Medicare, CTC */
export function calc1040(raw: Form1040_Inputs): {
  computed: Record<string,number>
  field_values?: Record<string,number>
  citations: string[]
} {
  const inp: Form1040_Inputs = Object.assign({
    filing_status: 'single' as FilingStatus, tax_year: 2025,
    wages: 0, taxable_interest: 0, ordinary_dividends: 0, qualified_dividends: 0,
    ira_distributions: 0, pensions_annuities: 0, social_security: 0,
    capital_gains: 0, ltcg_portion: 0, schedule1_income: 0,
    student_loan_interest: 0, educator_expenses: 0,
    itemized_deductions: 0, use_itemized: false,
    qbi_from_k1: 0, is_sstb: false,
    k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
    net_se_income: 0, num_dependents: 0,
    withholding: 0, estimated_payments: 0,
  }, raw)
  const s = inp.filing_status

  // ── Social Security taxability (§86) ──────────────────────────
  // Provisional income = AGI (before SS) + tax-exempt interest + 50% of SS
  const ss_threshold_1 = s === 'mfj' ? 32000 : 25000
  const ss_threshold_2 = s === 'mfj' ? 44000 : 34000
  const provisional = inp.wages + inp.taxable_interest + inp.ordinary_dividends +
    inp.ira_distributions + inp.pensions_annuities + inp.capital_gains +
    inp.schedule1_income + inp.k1_ordinary_income + (inp.net_se_income || 0) +
    inp.social_security * 0.5
  let ss_taxable = 0
  if (provisional > ss_threshold_2) {
    ss_taxable = Math.min(
      inp.social_security * 0.85,
      (provisional - ss_threshold_2) * 0.85 + Math.min((ss_threshold_2 - ss_threshold_1) * 0.5, inp.social_security * 0.5)
    )
  } else if (provisional > ss_threshold_1) {
    ss_taxable = Math.min(inp.social_security * 0.5, (provisional - ss_threshold_1) * 0.5)
  }
  ss_taxable = Math.round(ss_taxable)

  // ── Line 9: Total income ──────────────────────────────────────
  const total_income = (
    inp.wages + inp.taxable_interest + inp.ordinary_dividends +
    inp.ira_distributions + inp.pensions_annuities + ss_taxable +
    inp.capital_gains + inp.schedule1_income + inp.k1_ordinary_income +
    (inp.net_se_income || 0)
  )

  // ── Line 10: Adjustments ──────────────────────────────────────
  const se_detail = seTax(inp.net_se_income || 0, inp.tax_year)
  const se_deduction = se_detail.deduction  // §164(f) — half SE tax
  const adjustments = inp.student_loan_interest + inp.educator_expenses + se_deduction

  const agi = total_income - adjustments  // Line 11

  // ── Lines 12-15: Deduction + QBI ──────────────────────────────
  const std = standardDeduction(s, inp.tax_year)
  const deduction = inp.use_itemized ? Math.max(inp.itemized_deductions, std) : std
  const tentative_taxable = Math.max(0, agi - deduction)
  const qbi_deduction = qbiDeduction(
    inp.k1_ordinary_income + inp.qbi_from_k1,
    inp.k1_w2_wages,
    inp.k1_ubia,
    tentative_taxable,
    s, inp.tax_year,
    inp.is_sstb || false,
  )
  const taxable_income = Math.max(0, tentative_taxable - qbi_deduction)  // Line 15

  // ── Line 16: Tax (separate ordinary vs LTCG/qualified dividends) ──
  const ltcg_income = (inp.ltcg_portion || 0) + inp.qualified_dividends
  const ordinary_taxable = Math.max(0, taxable_income - ltcg_income)
  const ordinary_tax = ordinaryTax(ordinary_taxable, s, inp.tax_year)
  const ltcg_tax = ltcg_income > 0
    ? ltcgTax(ltcg_income, ordinary_taxable, s, inp.tax_year)
    : 0
  const income_tax = ordinary_tax + ltcg_tax

  // ── Line 17: AMT ──────────────────────────────────────────────
  const amt_status = (s === 'hoh' || s === 'qw') ? 'single' : s as 'single' | 'mfj' | 'mfs'
  const amt_gross = amtTax(taxable_income, amt_status, inp.tax_year)
  const amt = Math.max(0, amt_gross - income_tax)

  // ── Schedule 2: Other taxes ───────────────────────────────────
  const se_tax = se_detail.se_tax
  const nii = inp.taxable_interest + inp.ordinary_dividends + inp.capital_gains
  const niit_status = (s === 'hoh' || s === 'qw') ? 'single' : s as 'single' | 'mfj' | 'mfs'
  const niit = niitTax(nii, agi, niit_status, inp.tax_year)
  const additional_medicare = additionalMedicareTax(inp.wages, inp.net_se_income || 0, s)

  // ── Credits ───────────────────────────────────────────────────
  const ctc_detail = childTaxCredit(inp.num_dependents || 0, agi, s, inp.tax_year)
  const tax_before_credits = income_tax + amt + niit + additional_medicare + se_tax
  const ctc_nonrefundable = Math.min(ctc_detail.credit - ctc_detail.refundable, income_tax + amt)

  // ── Line 24: Total tax ────────────────────────────────────────
  const total_tax = Math.max(0, tax_before_credits - ctc_nonrefundable)

  // ── Line 33: Payments ─────────────────────────────────────────
  const total_payments = inp.withholding + inp.estimated_payments + ctc_detail.refundable

  const net = total_tax - total_payments
  const refund = Math.max(0, -net)
  const owed   = Math.max(0, net)

  // Build a field_values bag with both short keys AND IRS-line canonical keys
  // so both the engine_to_pdf map and direct canonical keys work.
  const computedCore = {
    total_income, adjustments, agi, deduction, qbi_deduction,
    taxable_income, ordinary_tax, ltcg_tax, income_tax,
    amt, se_tax, niit, additional_medicare,
    ctc_credit: ctc_detail.credit, ctc_refundable: ctc_detail.refundable,
    ctc_nonrefundable,
    ss_taxable, tax_before_credits, total_tax,
    total_payments, refund, owed,
  }

  // IRS-line-keyed field_values for direct PDF fill
  const field_values: Record<string, number> = {
    // Income lines
    'income.L1z_total_wages':      inp.wages,
    'income.L2b_taxable_int':      inp.taxable_interest,
    'income.L3a_qual_dividends':   inp.qualified_dividends,
    'income.L3b_ord_dividends':    inp.ordinary_dividends,
    'income.L4a_ira':              inp.ira_distributions,
    'income.L4b_ira_taxable':      inp.ira_distributions,
    'income.L5a_pensions':         inp.pensions_annuities,
    'income.L5b_pensions_tax':     inp.pensions_annuities,
    'income.L6a_social_sec':       inp.social_security,
    'income.L6b_ss_taxable':       ss_taxable,
    'income.L7a_capital_gains':    inp.capital_gains,
    'income.L8_schedule1':         inp.schedule1_income,
    'income.L9_total_income':      total_income,
    'income.L10_adjustments':      adjustments,
    'income.L11b_agi':             agi,
    // Deductions
    'deductions.L12e_standard':    deduction,
    'deductions.L13a_qbi':         qbi_deduction,
    'deductions.L14_total':        deduction + qbi_deduction,
    // Tax
    'tax.L15_taxable_income':      taxable_income,
    'tax.L16_income_tax':          income_tax,
    'tax.L17_sched2':              amt,   // Schedule 2 line 3 (AMT) flows to 1040 L17
    'tax.L18_add_16_17':           income_tax + amt,
    'tax.L22_subtract':            income_tax + amt - ctc_nonrefundable,
    'tax.L23_other_taxes':         niit + additional_medicare + se_tax,  // Schedule 2 L21
    'tax.L24_total_tax':           total_tax,
    // Credits
    'credits.L19_child_tax':       ctc_nonrefundable,
    'credits.L21_add_19_20':       ctc_nonrefundable,
    // Payments
    'payments.L25d_total':         inp.withholding,
    'payments.L26_estimated':      inp.estimated_payments,
    'payments.L28_child_addl':     ctc_detail.refundable,
    'payments.L33_total':          total_payments,
    // Result
    'refund.L35a_refunded':        refund,
    'result.L34_overpayment':      refund,
    'owed.L37_amount_owed':        owed,
  }
  // Filter zeros to avoid noise
  for (const k of Object.keys(field_values)) {
    if (field_values[k] === 0 || field_values[k] === null || field_values[k] === undefined) {
      delete field_values[k]
    }
  }

  return {
    computed: computedCore,
    field_values,
    citations: [
      `IRS tax brackets for TY${inp.tax_year} (Rev. Proc.)`,
      'IRC §63(c): Standard deduction',
      'IRC §199A: QBI deduction (SSTB-aware)',
      'IRC §86: Social Security taxability (two-tier 50%/85%)',
      'IRC §1(h): Long-term capital gains rates',
      'IRC §55: Alternative Minimum Tax',
      'IRC §1401/1402: Self-employment tax',
      'IRC §1411: Net Investment Income Tax (3.8%)',
      'IRC §3101(b)(2): Additional Medicare Tax (0.9%)',
      'IRC §24: Child Tax Credit',
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

// ─────────────────────────────────────────────────────────────
// FORM 4562 — Depreciation and Amortization
// ─────────────────────────────────────────────────────────────

/** MACRS GDS depreciation rates by recovery period and year */
const MACRS_RATES: Record<number, number[]> = {
  3:  [0.3333, 0.4445, 0.1481, 0.0741],
  5:  [0.2000, 0.3200, 0.1920, 0.1152, 0.1152, 0.0576],
  7:  [0.1429, 0.2449, 0.1749, 0.1249, 0.0893, 0.0892, 0.0893, 0.0446],
  10: [0.1000, 0.1800, 0.1440, 0.1152, 0.0922, 0.0737, 0.0655, 0.0655, 0.0656, 0.0655, 0.0328],
  15: [0.0500, 0.0950, 0.0855, 0.0770, 0.0693, 0.0623, 0.0590, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0295],
  20: [0.0375, 0.0722, 0.0668, 0.0618, 0.0571, 0.0528, 0.0489, 0.0452, 0.0447, 0.0447, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0223],
}

export interface DepreciationAsset {
  description:      string
  date_placed:      string    // MM/YYYY or YYYY
  cost_basis:       number
  business_pct:     number    // 0-100
  recovery_period:  number    // 3,5,7,10,15,20,25,27.5,39
  method:           'MACRS' | 'SL' | 'DB'  // GDS default is MACRS (200% DB switching to SL)
  convention:       'HY' | 'MM' | 'MQ'  // Half-Year, Mid-Month, Mid-Quarter
  year_number:      number    // which depreciation year (1-based)
  section_179_elected?: number
}

export interface Form4562_Inputs {
  taxpayer_name:     string
  business_activity: string
  taxpayer_id:       string
  tax_year:          number
  // Part I — Section 179
  section_179_max?:           number  // Line 1 (default: 1,250,000 for 2025)
  section_179_total_cost?:    number  // Line 2
  section_179_threshold?:     number  // Line 3 (default: 3,130,000 for 2025)
  section_179_carryover?:     number  // Line 10
  business_income_limit?:     number  // Line 11
  // Part II — Special depreciation
  special_depreciation?:      number  // Line 14 (bonus depreciation)
  // Part III — MACRS
  macrs_prior_years?:         number  // Line 17
  other_depreciation?:        number  // Line 16
  // Assets placed in service this year (Section B)
  assets?:                    DepreciationAsset[]
  // Part VI — Amortization
  amortization_prior?:        number  // Line 43
}

export interface Form4562_Result {
  inputs:   Form4562_Inputs
  computed: {
    // Part I
    section_179_limitation:   number  // Line 5
    section_179_deduction:    number  // Line 12
    section_179_carryforward: number  // Line 13
    // Part III — per-class depreciation
    depreciation_by_class:    Record<string, number>
    // Part IV — Summary
    listed_property:          number  // Line 21
    total_depreciation:       number  // Line 22
    // Part VI
    total_amortization:       number  // Line 44
  }
  citations: string[]
}

/** Calculate MACRS depreciation for a single asset */
function macrsDepreciation(asset: DepreciationAsset): number {
  const basis = asset.cost_basis * (asset.business_pct / 100) - (asset.section_179_elected || 0)
  if (basis <= 0) return 0

  if (asset.method === 'SL') {
    // Straight-line: half-year convention in first/last year
    const annual = basis / asset.recovery_period
    if (asset.year_number === 1 || asset.year_number === Math.ceil(asset.recovery_period) + 1) {
      return Math.round(annual / 2)
    }
    return Math.round(annual)
  }

  // MACRS GDS (200% DB switching to SL)
  const rates = MACRS_RATES[asset.recovery_period]
  if (!rates) {
    // For 25, 27.5, 39 year property — use straight-line
    const annual = basis / asset.recovery_period
    if (asset.convention === 'MM') {
      // Mid-month: first year = (12 - month_placed + 0.5) / 12
      const month = parseInt(asset.date_placed?.split('/')[0] || '7') || 7
      if (asset.year_number === 1) return Math.round(annual * (12 - month + 0.5) / 12)
    }
    if (asset.year_number === 1) return Math.round(annual / 2)
    return Math.round(annual)
  }

  const idx = asset.year_number - 1
  if (idx < 0 || idx >= rates.length) return 0
  return Math.round(basis * rates[idx])
}

/** Form 4562 calculation */
export function calc4562(inp: Form4562_Inputs): Form4562_Result {
  const year = inp.tax_year || 2025

  // Part I — Section 179
  const max179 = inp.section_179_max ?? 1250000  // 2025 limit
  const threshold = inp.section_179_threshold ?? 3130000
  const totalCost = inp.section_179_total_cost ?? 0
  const reduction = Math.max(0, totalCost - threshold)
  const limitation = Math.max(0, max179 - reduction)  // Line 5

  // Sum elected 179 from assets
  const elected179 = (inp.assets || []).reduce((s, a) => s + (a.section_179_elected || 0), 0)
  const tentative = Math.min(limitation, elected179)  // Line 9
  const carryover = inp.section_179_carryover ?? 0
  const bizLimit = inp.business_income_limit ?? limitation
  const section179_deduction = Math.min(tentative + carryover, bizLimit)  // Line 12
  const section179_carryforward = Math.max(0, tentative + carryover - section179_deduction)  // Line 13

  // Part III — MACRS by class
  const depreciation_by_class: Record<string, number> = {}
  let totalMacrsThisYear = 0

  for (const asset of (inp.assets || [])) {
    const dep = macrsDepreciation(asset)
    const classKey = `${asset.recovery_period}yr`
    depreciation_by_class[classKey] = (depreciation_by_class[classKey] || 0) + dep
    totalMacrsThisYear += dep
  }

  const specialDepr = inp.special_depreciation ?? 0  // Line 14
  const otherDepr = inp.other_depreciation ?? 0  // Line 16
  const macrsPrior = inp.macrs_prior_years ?? 0  // Line 17

  // Part IV — Summary (Line 22)
  const total_depreciation = section179_deduction + specialDepr + otherDepr + macrsPrior + totalMacrsThisYear

  // Part VI — Amortization
  const amortPrior = inp.amortization_prior ?? 0
  const total_amortization = amortPrior  // Line 44 (no new amortization in simplified model)

  return {
    inputs: inp,
    computed: {
      section_179_limitation: limitation,
      section_179_deduction: section179_deduction,
      section_179_carryforward: section179_carryforward,
      depreciation_by_class,
      listed_property: 0,
      total_depreciation,
      total_amortization,
    },
    citations: [
      `IRC §179: Maximum deduction $${max179.toLocaleString()} for TY${year}`,
      `IRC §179: Phase-out threshold $${threshold.toLocaleString()}`,
      'IRC §168: MACRS GDS 200% DB switching to SL (half-year convention)',
      'Form 4562 Line 22 = Lines 12 + 14-17 + 19-20(g) + 21',
    ]
  }
}

// ─────────────────────────────────────────────────────────────
// FORM 8594 — Asset Acquisition Statement (IRC §1060)
// ─────────────────────────────────────────────────────────────

export interface Form8594_Inputs {
  taxpayer_name:       string
  taxpayer_id:         string
  is_purchaser:        boolean   // true = purchaser, false = seller
  other_party_name:    string
  other_party_id:      string
  other_party_address: string
  other_party_city:    string
  date_of_sale:        string   // MM/DD/YYYY
  total_sales_price:   number
  // Class allocations — FMV and sales price allocation
  class_i_fmv:         number   // Cash and cash equivalents
  class_i_alloc:       number
  class_ii_fmv:        number   // Actively traded securities
  class_ii_alloc:      number
  class_iii_fmv:       number   // Accounts receivable, mortgages
  class_iii_alloc:     number
  class_iv_fmv:        number   // Inventory
  class_iv_alloc:      number
  class_v_fmv:         number   // All other tangible/intangible assets
  class_v_alloc:       number
  class_vi_vii_fmv:    number   // §197 intangibles and goodwill
  class_vi_vii_alloc:  number
  // Yes/No questions
  has_allocation_agreement?: boolean  // Line 5
  fmv_amounts_agreed?:      boolean  // Line 5 follow-up
  has_covenant?:             boolean  // Line 6
}

export interface Form8594_Result {
  inputs:   Form8594_Inputs
  computed: {
    total_fmv:        number
    total_allocation: number
    allocation_matches_price: boolean
    goodwill:         number   // residual in Class VI/VII
  }
  citations: string[]
}

/** Form 8594 calculation — residual method allocation per IRC §1060 */
export function calc8594(inp: Form8594_Inputs): Form8594_Result {
  const total_fmv = (inp.class_i_fmv || 0) + (inp.class_ii_fmv || 0) + (inp.class_iii_fmv || 0) +
    (inp.class_iv_fmv || 0) + (inp.class_v_fmv || 0) + (inp.class_vi_vii_fmv || 0)

  const total_allocation = (inp.class_i_alloc || 0) + (inp.class_ii_alloc || 0) + (inp.class_iii_alloc || 0) +
    (inp.class_iv_alloc || 0) + (inp.class_v_alloc || 0) + (inp.class_vi_vii_alloc || 0)

  // Goodwill is the residual — Class VI/VII allocation minus FMV of identifiable intangibles
  const goodwill = Math.max(0, (inp.class_vi_vii_alloc || 0) - (inp.class_vi_vii_fmv || 0))

  return {
    inputs: inp,
    computed: {
      total_fmv,
      total_allocation,
      allocation_matches_price: total_allocation === inp.total_sales_price,
      goodwill,
    },
    citations: [
      'IRC §1060: Residual method for asset acquisitions',
      'IRC §197: Goodwill and going concern value amortizable over 15 years',
      'Allocation order: Class I (cash) → II (securities) → III (receivables) → IV (inventory) → V (tangible/intangible) → VI/VII (§197 intangibles/goodwill)',
      `Total sales price: $${inp.total_sales_price?.toLocaleString()}, Total allocation: $${total_allocation.toLocaleString()}`,
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
    // SSTB status flows from S-Corp to shareholder's QBI calc, unless overridden
    is_sstb:            individual_base.is_sstb ?? s_corp_inputs.is_sstb ?? false,
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
