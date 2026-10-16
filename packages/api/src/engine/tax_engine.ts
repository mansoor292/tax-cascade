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

export const FILING_STATUSES: FilingStatus[] = ['single', 'mfj', 'mfs', 'hoh', 'qw']

/**
 * Bad input reaching the engine. Distinct from a genuine failure so callers
 * can answer 400 rather than 500 — the caller made a correctable mistake.
 */
/**
 * Ceiling on any single money field: $1 trillion.
 *
 * Finite is not the same as plausible. wages: 1e308 sailed through and
 * produced a tax of 3.79e307 — arithmetically consistent, completely
 * meaningless, and indistinguishable from a real figure in a PDF. Nothing a
 * US return legitimately reports comes near this, so a value above it is a
 * unit error or a corrupted import, and saying so beats computing on it.
 */
export const MAX_TAX_AMOUNT = 1e12

export class TaxInputError extends Error {
  readonly field: string
  readonly received: unknown
  constructor(field: string, received: unknown, detail: string) {
    super(`Invalid value for "${field}": ${detail}`)
    this.name = 'TaxInputError'
    this.field = field
    this.received = received
  }
}

/**
 * Merge caller input over the defaults, coercing every field the defaults
 * declare numeric — and REFUSING anything that is not a number.
 *
 * TypeScript's `number` is erased at runtime, so a JSON body, an HTML form
 * field or an LLM tool call can put a string into a field typed as a number
 * and nothing objects. The engine then sums the income lines with `+`, and
 * one string turns addition into concatenation:
 *
 *     "150000" + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 0  ->  "150000000000000"
 *
 * The later `-` coerces that back to a number, so wages of $150,000 became
 * an AGI of $150 trillion and a tax bill to match — HTTP 200, no warning.
 * Silently wrong arithmetic is the worst thing a tax engine can do, so the
 * boundary is enforced here, once, for every caller and every form.
 *
 * Digit strings ARE accepted, currency formatting and all ("$150,000"),
 * because that is what forms and spreadsheets legitimately produce. What is
 * refused is anything that does not denote a finite number.
 */
export function coerceInputs<T extends object>(defaults: T, raw: unknown): T {
  const merged: any = Object.assign({}, defaults, raw || {})

  for (const [key, def] of Object.entries(defaults as Record<string, unknown>)) {
    const v = merged[key]

    if (typeof def === 'number') {
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) {
          throw new TaxInputError(key, v, 'must be a finite number (got NaN or Infinity)')
        }
        if (Math.abs(v) > MAX_TAX_AMOUNT) {
          throw new TaxInputError(key, v, `exceeds the largest supported amount (${MAX_TAX_AMOUNT.toExponential()})`)
        }
        continue
      }
      // Absent is not an error — that is what the default is for.
      if (v === null || v === undefined || v === '') { merged[key] = def; continue }
      if (typeof v === 'string') {
        const cleaned = v.replace(/[$,\s]/g, '')
        const n = Number(cleaned)
        if (cleaned === '' || !Number.isFinite(n)) {
          throw new TaxInputError(key, v, 'expected a number')
        }
        if (Math.abs(n) > MAX_TAX_AMOUNT) {
          throw new TaxInputError(key, v, `exceeds the largest supported amount (${MAX_TAX_AMOUNT.toExponential()})`)
        }
        merged[key] = n
        continue
      }
      throw new TaxInputError(key, v, `expected a number, got ${typeof v}`)
    }

    if (typeof def === 'boolean') {
      if (typeof v === 'boolean') continue
      if (v === null || v === undefined || v === '') { merged[key] = def; continue }
      // "false" is a truthy string. Left alone it silently flips the flag on,
      // which would quietly switch a return to itemized deductions.
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase()
        if (t === 'true' || t === '1' || t === 'yes') { merged[key] = true; continue }
        if (t === 'false' || t === '0' || t === 'no') { merged[key] = false; continue }
        throw new TaxInputError(key, v, 'expected a boolean')
      }
      if (typeof v === 'number') { merged[key] = v !== 0; continue }
      throw new TaxInputError(key, v, `expected a boolean, got ${typeof v}`)
    }
  }

  // An unrecognised filing status silently fell through every bracket
  // comparison and crashed later with no indication of the real cause.
  if ('filing_status' in merged && merged.filing_status !== undefined) {
    if (!FILING_STATUSES.includes(merged.filing_status)) {
      throw new TaxInputError(
        'filing_status', merged.filing_status,
        `expected one of ${FILING_STATUSES.join(', ')}`,
      )
    }
  }

  return merged as T
}

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
  // Schedule K portfolio income (separately stated — does NOT flow through ordinary_income_loss)
  // Each item passes through pro-rata to shareholders on K-1 lines 4/5a/5b/6/7/8a/10/16a.
  schedule_k_interest?:               number  // K line 4 — portfolio interest income (1099-INT Box 1)
  schedule_k_dividends_ordinary?:     number  // K line 5a — ordinary dividends (1099-DIV Box 1a)
  schedule_k_dividends_qualified?:    number  // K line 5b — qualified dividends (1099-DIV Box 1b)
  schedule_k_royalties?:              number  // K line 6 — royalties
  schedule_k_st_cap_gain?:            number  // K line 7 — net short-term capital gain (loss)
  schedule_k_lt_cap_gain?:            number  // K line 8a — net long-term capital gain (loss)
  schedule_k_other_portfolio_income?: number  // K line 10 — other income (loss)
  schedule_k_tax_exempt_interest?:    number  // K line 16a — tax-exempt interest
  // K line 16c / 16d. The canonical spellings (schedK.L16c_nondeductible,
  // schedK.L16d_distributions) are read too: that is where returns carry them.
  schedule_k_nondeductible_expenses?: number  // K line 16c — nondeductible expenses (K-1 16C)
  schedule_k_distributions?:          number  // K line 16d — distributions (K-1 16D)
  // Schedule D (Form 1120-S). When present its lines 7 and 15 ARE Schedule K
  // lines 7 and 8a (engine/schedule_d_1120s.ts).
  schedule_d_1120s?:    unknown
  // §199A — flows to shareholders on K-1
  is_sstb?:             boolean
  // UBIA of qualified property (K-1 box 17 code V / Statement A) — the
  // corporation-level total, allocated pro-rata to each shareholder for
  // their QBI wage/UBIA limitation. Optional; 0 means "not provided".
  schedule_k_ubia?:     number
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
      qbi_income:      number
      ubia:            number
      // Schedule K portfolio items (pro-rata allocation)
      interest_income?:       number
      dividends_ordinary?:    number
      dividends_qualified?:   number
      royalties?:             number
      st_cap_gain?:           number
      lt_cap_gain?:           number
      other_portfolio?:       number
      tax_exempt_interest?:   number
      nondeductible_expenses?: number  // box 16 code C
      distributions?:          number  // box 16 code D
      investment_income?:      number  // box 17 code A
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
  // Payments (Schedule J Part III). Only estimated_tax_paid existed, so a
  // prior-year overpayment credited forward had to be folded into "estimated
  // payments" and line 13 could not say where the money came from.
  estimated_tax_paid:   number
  prior_year_overpayment?: number   // J13 — overpayment credited from the prior year
  deposit_7004?:        number      // J17 — tax deposited with Form 7004
  // Line 34 — estimated tax penalty. `form2220` computes it (and the form is
  // attached); `estimated_tax_penalty` states it outright when the penalty
  // was figured elsewhere. Neither → line 34 is 0, as before.
  form2220?:            Omit<Form2220Inputs, 'tax_year' | 'total_tax'>
  estimated_tax_penalty?: number
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
    // NOL tracking — see calc1120 for derivation:
    nol_applied:                  number  // capped at 80% of TI before NOL per IRC §172(a)(2)
    nol_carryforward_remaining:   number  // requested nol_deduction above the cap — carries forward
    nol_generated:                number  // abs(TI before NOL) when negative — feed into next year's deduction
    taxable_income:   number
    income_tax:       number  // Schedule J line 2
    total_credits:    number  // FTC + GBC + PYMTC + other
    total_tax:        number  // after credits
    total_payments:   number
    estimated_tax_penalty: number
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
  // ── Source-document detail (all optional; see form1040_detail.ts) ──
  /** One entry per W-2. When given, wages and withholding default to its totals. */
  w2s?:                 W2Input[]
  /** Schedule B Part I payers (1099-INT box 1). Sums to taxable_interest when both are given. */
  taxable_interest_detail?: DetailItem[]
  /** Schedule B Part II payers (1099-DIV box 1a; `qualified` = box 1b). */
  ordinary_dividends_detail?: DetailItem[]
  /** Schedule 1 line 8z other income, e.g. 1099-MISC box 8 substitute payments. */
  other_income?:        number
  other_income_detail?: DetailItem[]
  /** Broker 1099-B sales — Form 8949 / Schedule D. Replaces capital_gains when given. */
  capital_transactions_detail?: CapitalTransaction[]
  /** K-1 portfolio items (1120-S boxes 4, 5a, 5b, 7, 8a) — added to the 1099 figures. */
  k1_portfolio?:        K1PortfolioItems
  /** Paid with Form 4868 — Schedule 3 line 10, not an estimated payment. */
  extension_payment?:   number
  /** Prior-year total tax and AGI — the Form 2210 safe harbor. */
  prior_year_tax?:      number
  prior_year_agi?:      number
  /** Schedule B Part III: any foreign financial account. */
  foreign_accounts?:    boolean
  /** Capital losses carried in from the prior year (Schedule D lines 6 and 14), positive amounts. */
  capital_loss_carryover?: CapitalLossCarryover
  /** Dated estimated payments for Form 2210; without dates, estimated_payments counts as paid evenly. */
  estimated_payments_detail?: Array<{ date: string; amount: number }>
  /** Line 38 as stated by the caller (e.g. the annualized method); replaces the regular-method figure. */
  estimated_tax_penalty?: number
  /** Form 7203 basis facts for the S corporation behind the K-1. */
  form7203?: Form7203Input
}

// ─────────────────────────────────────────────────────────────
// Year-specific tax functions imported from tax_tables.ts
// ─────────────────────────────────────────────────────────────
import { scheduleD1120STotals } from './schedule_d_1120s.js'
import {
  ordinaryTax, standardDeduction, qbiDeduction,
  ltcgTax, niitTax, amtTax, seTax, childTaxCredit, additionalMedicareTax, TAX_TABLES,
  SECTION_179_LIMITS,
} from './tax_tables.js'
import {
  summarizeW2s, scheduleD, capitalLossCarryoverWorksheet, form2210Penalty, form7203StockBasis,
  type W2Input, type DetailItem, type CapitalTransaction, type K1PortfolioItems, type CapitalLossCarryover,
  type Form7203Input,
} from './form1040_detail.js'
import { calc2220, type Form2220Inputs } from './form2220.js'

/**
 * Form 1120-X — the amended corporate return as the IRS asks for it.
 *
 * Catipult stored an amendment as a corrected Form 1120 and nothing else,
 * so the refund it showed was the corrected return's whole overpayment.
 * Edgewater Ventures' 2023 amendment read 435,059 when the claim was
 * 192,234 — the original return had already credited 242,825 forward —
 * and its 2024 amendment read 168,170 against a 22,332 claim, because the
 * IRS had already refunded 145,838. A preparer pulling those rows had to
 * redo the netting by hand. This computes Part I the way the form does:
 * column A as originally reported (or as the IRS later adjusted it),
 * column C as corrected, B the difference, then lines 5–13 netting the
 * payments against what the original return already paid out.
 */
export interface Form1120X_Column {
  total_income: number       // Form 1120 line 11
  total_deductions: number   // Form 1120 lines 27 + 29c (NOL and special deductions included)
  taxable_income: number     // Form 1120 line 30
  total_tax: number          // Form 1120 line 31
}

export interface Form1120X_Inputs {
  original: Form1120X_Column
  corrected: Form1120X_Column
  prior_year_credit?: number     // 5a — overpayment credited from the prior year (as the IRS posted it)
  estimated_tax?: number         // 5b
  refund_4466?: number           // 5c — quick refund applied for on Form 4466
  deposit_7004?: number          // 5e
  other_credits?: number         // 5f + 5g
  tax_paid_after?: number        // 6 — paid with the original return or after it was filed
  original_overpayment?: number  // 8 — overpayment on the original return, or as later adjusted
  credit_to_estimated?: number   // 12 — part of line 11 to credit to next year's estimated tax
}

export function calc1120X(inp: Form1120X_Inputs): { field_values: Record<string, number>; refund: number; amount_owed: number } {
  const n = (v: unknown) => Math.round(Number(v) || 0)
  const fv: Record<string, number> = {}
  const cols: Array<[string, keyof Form1120X_Column]> = [
    ['L1_total_income', 'total_income'],
    ['L2_total_deductions', 'total_deductions'],
    ['L3_taxable_income', 'taxable_income'],
    ['L4_total_tax', 'total_tax'],
  ]
  for (const [key, field] of cols) {
    const a = n(inp.original[field])
    const c = n(inp.corrected[field])
    fv[`amended.${key}_a`] = a
    fv[`amended.${key}_b`] = c - a
    fv[`amended.${key}_c`] = c
  }
  const l5a = n(inp.prior_year_credit), l5b = n(inp.estimated_tax), l5c = n(inp.refund_4466)
  const l5d = l5a + l5b - l5c
  const l5e = n(inp.deposit_7004), l5fg = n(inp.other_credits), l6 = n(inp.tax_paid_after)
  const l7 = l5d + l5e + l5fg + l6
  const l8 = n(inp.original_overpayment)
  const l9 = l7 - l8
  const taxC = fv['amended.L4_total_tax_c']
  const l10 = Math.max(0, taxC - l9)
  const l11 = Math.max(0, l9 - taxC)
  const l12 = Math.min(l11, n(inp.credit_to_estimated))
  const l13 = l11 - l12
  Object.assign(fv, {
    'amended.L5a_prior_year_credit': l5a,
    'amended.L5b_estimated_tax': l5b,
    'amended.L5c_refund_4466': l5c,
    'amended.L5d_net_estimated': l5d,
    'amended.L5e_7004_deposit': l5e,
    'amended.L5f_other_credits': l5fg,
    'amended.L6_tax_paid_after': l6,
    'amended.L7_total_payments': l7,
    'amended.L8_original_overpayment': l8,
    'amended.L9_net_payments': l9,
    'amended.L10_tax_owed': l10,
    'amended.L11_overpayment': l11,
    'amended.L12_credited_estimated': l12,
    'amended.L13_refunded': l13,
  })
  return { field_values: fv, refund: l13, amount_owed: l10 }
}

/** Column A/C of Form 1120-X read off a Form 1120's field_values. */
export function form1120XColumn(fv: Record<string, any>): Form1120X_Column {
  const v = (k: string) => Number(fv?.[k]) || 0
  return {
    total_income: v('income.L11_total_income'),
    total_deductions: v('deductions.L27_total_deductions') + v('tax.L29c_total_29'),
    taxable_income: v('tax.L30_taxable_income'),
    total_tax: v('tax.L31_total_tax'),
  }
}


/** Form 1120-S calculation */
export function calc1120S(raw: Form1120S_Inputs): Form1120S_Result {
  const inp: Form1120S_Inputs = coerceInputs<Form1120S_Inputs>({
    gross_receipts: 0, returns_allowances: 0, cost_of_goods_sold: 0,
    net_gain_4797: 0, other_income: 0,
    officer_compensation: 0, salaries_wages: 0, repairs_maintenance: 0,
    bad_debts: 0, rents: 0, taxes_licenses: 0, interest: 0,
    depreciation: 0, depletion: 0, advertising: 0, pension_plans: 0,
    employee_benefits: 0, other_deductions: 0,
    charitable_contrib: 0, section_179: 0,
    schedule_k_interest: 0, schedule_k_dividends_ordinary: 0,
    schedule_k_dividends_qualified: 0, schedule_k_royalties: 0,
    schedule_k_st_cap_gain: 0, schedule_k_lt_cap_gain: 0,
    schedule_k_other_portfolio_income: 0, schedule_k_tax_exempt_interest: 0,
    schedule_k_ubia: 0,
    shareholders: [{ name: 'Shareholder', pct: 100 }],
  }, raw)
  // Schedule K line 7 / 8a are Schedule D lines 7 / 15 when the return
  // carries the schedule (see engine/schedule_d_1120s.ts for the dollar
  // this cost when they were two separate numbers).
  const schedD = scheduleD1120STotals(inp.schedule_d_1120s)
  if (schedD) {
    inp.schedule_k_st_cap_gain = schedD.L7
    inp.schedule_k_lt_cap_gain = schedD.L15
  }
  const rawAny = (raw || {}) as unknown as Record<string, unknown>
  const stated = (flat: number | undefined, canonical: string): number => {
    if (typeof flat === 'number' && isFinite(flat) && flat !== 0) return flat
    const v = rawAny[canonical]
    return typeof v === 'number' && isFinite(v) ? v : 0
  }
  const nondeductible = stated(inp.schedule_k_nondeductible_expenses, 'schedK.L16c_nondeductible')
  const distributions = stated(inp.schedule_k_distributions, 'schedK.L16d_distributions')
  // Line 17a: "only the investment income included on lines 4, 5a, 6, and
  // 10 of Schedule K" (1120-S instructions). Capital gains stay out unless a
  // shareholder elects them in on Form 4952.
  const investment_income = (inp.schedule_k_interest || 0) + (inp.schedule_k_dividends_ordinary || 0)
    + (inp.schedule_k_royalties || 0) + (inp.schedule_k_other_portfolio_income || 0)

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
  const prorata = (v: number | undefined, pct: number) => Math.round((v || 0) * pct / 100)
  const k1s = inp.shareholders.map(s => ({
    name:            s.name,
    pct:             s.pct,
    ordinary_income: Math.round(ordinary_income_loss * s.pct / 100),
    charitable:      Math.round(inp.charitable_contrib * s.pct / 100),
    section_179:     Math.round(inp.section_179 * s.pct / 100),
    w2_wages:        Math.round((inp.salaries_wages + inp.officer_compensation) * s.pct / 100),
    // §199A Statement A items: QBI is the shareholder's ordinary-income
    // share (v1 — no separately-stated QBI adjustments); UBIA pro-rata.
    qbi_income:      Math.round(ordinary_income_loss * s.pct / 100),
    ubia:            prorata(inp.schedule_k_ubia, s.pct),
    // Schedule K portfolio items (pro-rata)
    interest_income:      prorata(inp.schedule_k_interest, s.pct),
    dividends_ordinary:   prorata(inp.schedule_k_dividends_ordinary, s.pct),
    dividends_qualified:  prorata(inp.schedule_k_dividends_qualified, s.pct),
    royalties:            prorata(inp.schedule_k_royalties, s.pct),
    st_cap_gain:          prorata(inp.schedule_k_st_cap_gain, s.pct),
    lt_cap_gain:          prorata(inp.schedule_k_lt_cap_gain, s.pct),
    other_portfolio:      prorata(inp.schedule_k_other_portfolio_income, s.pct),
    tax_exempt_interest:  prorata(inp.schedule_k_tax_exempt_interest, s.pct),
    // Boxes 16C, 16D and 17A. An S corporation has one class of stock, so
    // distributions are pro rata like everything else (§1361(b)(1)(D)).
    nondeductible_expenses: prorata(nondeductible, s.pct),
    distributions:          prorata(distributions, s.pct),
    investment_income:      prorata(investment_income, s.pct),
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
    // Schedule K — pro-rata share items (flows to shareholders' K-1s)
    'schedK.L1_ordinary':               ordinary_income_loss,
    'schedK.L4_interest':               inp.schedule_k_interest || 0,
    'schedK.L5a_ordinary_dividends':    inp.schedule_k_dividends_ordinary || 0,
    'schedK.L5b_qualified_dividends':   inp.schedule_k_dividends_qualified || 0,
    'schedK.L6_royalties':              inp.schedule_k_royalties || 0,
    'schedK.L7_st_capital_gain':        inp.schedule_k_st_cap_gain || 0,
    'schedK.L8a_lt_capital_gain':       inp.schedule_k_lt_cap_gain || 0,
    'schedK.L10_other_income':          inp.schedule_k_other_portfolio_income || 0,
    'schedK.L11_section_179':           inp.section_179,
    'schedK.L12a_charitable':           inp.charitable_contrib,
    'schedK.L16a_tax_exempt_interest':  inp.schedule_k_tax_exempt_interest || 0,
    'schedK.L16c_nondeductible':        nondeductible,
    'schedK.L16d_distributions':        distributions,
    'schedK.L17a_invest_income':        investment_income,
    // L18: Income/loss reconciliation = ordinary + separately stated portfolio items - separately stated expenses
    'schedK.L18_income_loss':
      ordinary_income_loss
      + (inp.schedule_k_interest || 0)
      + (inp.schedule_k_dividends_ordinary || 0)
      + (inp.schedule_k_royalties || 0)
      + (inp.schedule_k_st_cap_gain || 0)
      + (inp.schedule_k_lt_cap_gain || 0)
      + (inp.schedule_k_other_portfolio_income || 0)
      + inp.charitable_contrib,
    // Schedule M-1 — reconciliation of income (loss) per books with return
    // Line 1 = net income per books, often close to ordinary_income_loss after book-tax adjustments
    'schedM1.L1_net_income':            ordinary_income_loss,
    'schedM1.L3_expenses_not_K':        0,  // book-only expenses not on K (e.g. 50% meals difference)
    'schedM1.L4_add':                   ordinary_income_loss,
    'schedM1.L6_ded_on_K':              0,  // K deductions not charged against book income
    'schedM1.L7_add_5_6':               0,
    'schedM1.L8_income_K18':            ordinary_income_loss,
  }
  // Keep zero values — they're structural (e.g. "no capital gains" still needs the line displayed).
  // Only drop undefined/null.
  for (const k of Object.keys(field_values)) {
    if (field_values[k] === undefined || field_values[k] === null) delete field_values[k]
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
      '1120-S Instructions: Schedule K lines 7 and 8a = Schedule D (Form 1120-S) lines 7 and 15',
      '1120-S Instructions: Line 17a = investment income included on Schedule K lines 4, 5a, 6 and 10',
    ]
  }
}

/** Default missing numeric fields to 0 */
function _defaults<T extends Record<string, any>>(inp: T, exclude: string[] = []): T {
  const result = { ...inp }
  for (const [k, v] of Object.entries(result)) {
    if (v === undefined && !exclude.includes(k)) (result as any)[k] = 0
  }
  return result
}

/** Form 1120 calculation */
export function calc1120(raw: Form1120_Inputs): Form1120_Result {
  const inp: Form1120_Inputs = coerceInputs<Form1120_Inputs>({
    gross_receipts: 0, returns_allowances: 0, cost_of_goods_sold: 0,
    dividends: 0, interest_income: 0, gross_rents: 0, gross_royalties: 0,
    capital_gains: 0, net_gain_4797: 0, other_income: 0,
    officer_compensation: 0, salaries_wages: 0, repairs_maintenance: 0,
    bad_debts: 0, rents: 0, taxes_licenses: 0, interest_expense: 0,
    charitable_contrib: 0, depreciation: 0, depletion: 0, advertising: 0,
    pension_plans: 0, employee_benefits: 0, other_deductions: 0,
    nol_deduction: 0, special_deductions: 0, estimated_tax_paid: 0,
    prior_year_overpayment: 0, deposit_7004: 0,
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

  // NOL deduction — cap at 80% of taxable income per IRC §172(a)(2)
  // (TCJA, applies to NOLs arising in tax years after 2017). The caller
  // may pass any nol_deduction amount; we cap server-side so wrong user
  // input can't under-tax a profitable year. nol_applied is what actually
  // reduced income; nol_carryforward_remaining is what's left for future
  // years (= requested nol_deduction − nol_applied).
  const nol_cap = Math.max(0, taxable_income_before_nol * 0.80)
  const nol_applied = Math.min(inp.nol_deduction || 0, nol_cap)
  const nol_carryforward_remaining = Math.max(0, (inp.nol_deduction || 0) - nol_applied)

  const taxable_income = Math.max(0, taxable_income_before_nol - nol_applied - special_deductions)  // L30

  // NOL generated THIS year (loss year) — caller can use this to auto-
  // carry forward into next year's nol_deduction. Rolled up and surfaced
  // in computed.nol_generated.
  const nol_generated = taxable_income_before_nol < 0 ? Math.abs(taxable_income_before_nol) : 0

  // Schedule J: 21% flat rate (TCJA 2017, permanent for C-corps)
  const income_tax = Math.round(taxable_income * 0.21)  // Sch J L2

  // Credits (Schedule J Part I)
  const total_credits = (inp.foreign_tax_credit ?? 0) +
    (inp.general_business_credit ?? 0) +
    (inp.prior_year_min_tax_credit ?? 0) +
    (inp.other_credits ?? 0)
  const total_tax = Math.max(0, income_tax - total_credits)

  const prior_year_overpayment = Number(inp.prior_year_overpayment) || 0
  const deposit_7004 = Number(inp.deposit_7004) || 0
  const total_payments = inp.estimated_tax_paid + prior_year_overpayment + deposit_7004

  // Line 34. Line 35 is "the total of lines 31, 32, and 34" less line 33, so
  // a penalty left off line 34 understated the balance due by exactly that
  // much (Form 2220 was simply not modeled).
  let estimated_tax_penalty = Number(inp.estimated_tax_penalty) || 0
  if (inp.form2220 && typeof inp.form2220 === 'object') {
    estimated_tax_penalty = calc2220({ ...inp.form2220, tax_year: inp.tax_year, total_tax }).L38
  }
  const net = total_tax + estimated_tax_penalty - total_payments
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
    'tax.L29a_nol':                    nol_applied,  // capped — what actually flows to L29a
    'tax.L29b_special_ded':            special_deductions,
    'tax.L29c_total_29':               nol_applied + special_deductions,
    'tax.L30_taxable_income':          taxable_income,
    // Schedule J Part I/II roll-ups. Only 1a was emitted, so lines 2, 4, 7,
    // 11a and 12 printed 0 under a page-1 line 31 that showed the tax — and
    // line 31 is defined as Schedule J line 12. No AMT (line 3) or Part I
    // line 8-10 items are modeled, so 2 = 4 = 1a and 7 = 11a = 12.
    'schedJ.J1a_income_tax':           income_tax,
    'schedJ.J2_total_income_tax':      income_tax,
    'schedJ.J4_add_2_3':               income_tax,
    'schedJ.J7_subtract_6_4':          total_tax,
    'schedJ.J11a_total_before_def':    total_tax,
    'schedJ.J12_total_tax':            total_tax,
    'tax.L31_total_tax':               total_tax,
    'schedJ.J13_prior_overpayment':    prior_year_overpayment,
    'schedJ.J14_estimated_payments':   inp.estimated_tax_paid,
    'schedJ.J17_7004_deposit':         deposit_7004,
    'schedJ.J19_total_payments':       total_payments,
    'schedJ.J23_total_pay_credits':    total_payments,
    'payments.L33_total_payments':     total_payments,
    'payments.L34_est_penalty':        estimated_tax_penalty,
    'payments.L35_amount_owed':        balance_due,
    'payments.L36_overpayment':        overpayment,
  }
  // Keep zero values — they're structural (e.g. "no capital gains" still needs the line displayed).
  // Only drop undefined/null.
  for (const k of Object.keys(field_values)) {
    if (field_values[k] === undefined || field_values[k] === null) delete field_values[k]
  }

  return {
    inputs: inp,
    computed: {
      balance_1c, gross_profit, total_income, total_deductions,
      taxable_income_before_nol, special_deductions,
      nol_applied, nol_carryforward_remaining, nol_generated,
      taxable_income,
      income_tax, total_credits, total_tax, total_payments, estimated_tax_penalty, balance_due, overpayment
    },
    field_values,
    citations: [
      '1120 Instructions: Line 11 = Lines 3-10',
      '1120 Instructions: Line 27 = Lines 12-26',
      '1120 Instructions: Line 30 = Line 28 - Line 29c',
      'IRC §11(b): Corporate tax rate 21%',
      'IRC §172(a)(2): NOL deduction capped at 80% of taxable income (TCJA 2017)',
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
  const inp: Form1040_Inputs = coerceInputs<Form1040_Inputs>({
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

  // ── Source documents → scalars (form1040_detail.ts) ───────────
  const detailIn = (raw || {}) as Partial<Form1040_Inputs>
  const w2 = summarizeW2s(detailIn.w2s, inp.tax_year)
  if (w2.count) {
    if (!inp.wages) inp.wages = w2.wages
    if (!inp.withholding) inp.withholding = w2.withholding
  }
  const k1p = detailIn.k1_portfolio || {}
  const n0 = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const sumItems = (xs?: DetailItem[], f: (x: DetailItem) => number = x => n0(x.amount)) =>
    Math.round((xs || []).reduce((t, x) => t + f(x), 0))
  if (detailIn.taxable_interest_detail?.length && !inp.taxable_interest) inp.taxable_interest = sumItems(detailIn.taxable_interest_detail)
  if (detailIn.ordinary_dividends_detail?.length) {
    if (!inp.ordinary_dividends) inp.ordinary_dividends = sumItems(detailIn.ordinary_dividends_detail)
    if (!inp.qualified_dividends) inp.qualified_dividends = sumItems(detailIn.ordinary_dividends_detail, x => n0(x.qualified))
  }
  // K-1 portfolio income lands on the same 1040 lines as the 1099s.
  inp.taxable_interest += Math.round(n0(k1p.interest))
  inp.ordinary_dividends += Math.round(n0(k1p.ordinary_dividends))
  inp.qualified_dividends += Math.round(n0(k1p.qualified_dividends))
  const other_income = Math.round(n0(detailIn.other_income) ||
    sumItems(detailIn.other_income_detail))
  const other_investment_income = detailIn.other_income_detail?.length
    ? sumItems(detailIn.other_income_detail.filter(x => x.investment))
    : 0
  const schedD = scheduleD(detailIn.capital_transactions_detail, k1p, s, detailIn.capital_loss_carryover)
  if (schedD.any) {
    inp.capital_gains = schedD.lineAmount
    inp.ltcg_portion = schedD.netCapitalGain
  } else if (inp.capital_gains < 0) {
    // §1211(b): a net capital loss offsets ordinary income only up to 3,000.
    inp.capital_gains = Math.max(inp.capital_gains, s === 'mfs' ? -1500 : -3000)
  }

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
    other_income + (inp.net_se_income || 0)
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
    inp.qualified_dividends + Math.max(0, inp.ltcg_portion || 0),
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
  // Form 8960 line 5a is the gain or loss from 1040 line 7 — so a net capital
  // loss counts, but only the part §1211(b) lets you deduct this year (3,000;
  // the carryforward never touches NII). Treas. Reg. §1.1411-4(d)(2). This
  // used to floor 5a at zero, which the filed 2025 joint return shows is
  // wrong: its 8960 nets the 3,000 against interest and dividends.
  const nii_gain = schedD.any ? schedD.lineAmount : inp.capital_gains
  // Line 12: net investment income, never below zero.
  const nii = Math.max(0, inp.taxable_interest + inp.ordinary_dividends + nii_gain + other_investment_income)
  const niit_status = (s === 'hoh' || s === 'qw') ? 'single' : s as 'single' | 'mfj' | 'mfs'
  const niit = niitTax(nii, agi, niit_status, inp.tax_year)
  // Form 8959 runs on Medicare wages (box 5), not box 1.
  const medicare_wages = w2.count ? w2.medicareWages : inp.wages
  const additional_medicare = additionalMedicareTax(medicare_wages, inp.net_se_income || 0, s)

  // ── Credits ───────────────────────────────────────────────────
  const ctc_detail = childTaxCredit(inp.num_dependents || 0, agi, s, inp.tax_year)
  const tax_before_credits = income_tax + amt + niit + additional_medicare + se_tax
  const ctc_nonrefundable = Math.min(ctc_detail.credit - ctc_detail.refundable, income_tax + amt)

  // ── Line 24: Total tax ────────────────────────────────────────
  const total_tax = Math.max(0, tax_before_credits - ctc_nonrefundable)

  // ── Line 33: Payments ─────────────────────────────────────────
  const addl_medicare_withheld = w2.addlMedicareWithheld          // 1040 line 25c
  const extension_payment = Math.round(n0(detailIn.extension_payment))
  const excess_ss = w2.excessSS
  const sched3_payments = extension_payment + excess_ss            // Schedule 3 line 15 → 1040 line 31
  const total_payments = inp.withholding + addl_medicare_withheld + inp.estimated_payments +
    ctc_detail.refundable + sched3_payments

  // ── Form 2210 — was enough paid during the year? ──────────────
  // An extension payment is not timely for this purpose. Required annual
  // payment = the smaller of 90% of this year's tax and 100% (110% above
  // $150,000 AGI) of last year's. Withholding — including the 0.9% withheld
  // (25c) and excess social security (Schedule 3 line 11) — counts as paid
  // evenly on the four due dates.
  const prior_tax = n0(detailIn.prior_year_tax)
  const withholding_2210 = inp.withholding + addl_medicare_withheld + excess_ss
  const timely_paid = withholding_2210 + inp.estimated_payments
  const tax_2210 = total_tax - ctc_detail.refundable
  let form2210_required = 0, form2210_shortfall = 0, est_penalty = 0
  if (tax_2210 - withholding_2210 >= 1000) {
    const ninety = Math.round(tax_2210 * 0.90)
    const prior_mult = n0(detailIn.prior_year_agi) > (s === 'mfs' ? 75000 : 150000) ? 1.10 : 1.00
    form2210_required = prior_tax > 0 ? Math.min(ninety, Math.round(prior_tax * prior_mult)) : ninety
    form2210_shortfall = Math.max(0, form2210_required - timely_paid)
    if (form2210_shortfall > 0) {
      const dated = detailIn.estimated_payments_detail || []
      // Undated estimates are spread like withholding: the only assumption
      // that needs no dates, and the one Form 2210 makes for withholding.
      const undated = dated.length ? 0 : inp.estimated_payments
      const p2210 = form2210Penalty({
        taxYear: inp.tax_year,
        requiredAnnualPayment: form2210_required,
        withholding: withholding_2210 + undated,
        payments: dated,
      })
      est_penalty = p2210?.penalty ?? 0
    }
  }
  if (detailIn.estimated_tax_penalty !== undefined && detailIn.estimated_tax_penalty !== null) {
    est_penalty = Math.round(n0(detailIn.estimated_tax_penalty))
  }

  // Line 37 includes the line 38 penalty; an overpayment is reduced by it.
  const net = total_tax - total_payments
  const refund = Math.max(0, -net - est_penalty)
  const owed   = Math.max(0, net + est_penalty)

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
    // Income lines — default L1a_w2_wages = wages when no explicit breakdown is provided
    // (W-2 box 1 matches L1a; in the absence of household/tips/dep-care inputs, all wages
    // flow through L1a and L1z)
    'income.L1a_w2_wages':         inp.wages,
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
    // Schedule 1 line 10: K-1 ordinary income is Schedule 1 line 5, so it
    // belongs here — it was in line 9's total and missing from line 8.
    'income.L8_schedule1':         inp.schedule1_income + inp.k1_ordinary_income + other_income,
    'income.L9_total_income':      total_income,
    'income.L10_adjustments':      adjustments,
    // 2025 prints AGI twice: 11a closes page 1, 11b opens page 2. Only 11b
    // was emitted, so 11a printed 0 on every 2025 return.
    'income.L11a_subtract':        agi,
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
    // Credits. Line 20 is stated even at zero: a face line the return leaves
    // unsaid is up for grabs by the PDF builder's label matcher, which put
    // Form 8959 line 20 (Medicare wages, six figures) in the 1040's line 20
    // credits box. Line 36 below, for the same reason (8995-A line 36).
    'credits.L19_child_tax':       ctc_nonrefundable,
    'credits.L20_sched3':          0,
    'credits.L21_add_19_20':       ctc_nonrefundable,
    // Payments — default L25a_w2 = withholding (assume all withholding is W-2)
    'payments.L25a_w2':            inp.withholding,
    'payments.L25c_other':         addl_medicare_withheld,
    'payments.L25d_total':         inp.withholding + addl_medicare_withheld,
    'payments.L26_estimated':      inp.estimated_payments,
    'payments.L31_sched3':         sched3_payments,
    'payments.L28_child_addl':     ctc_detail.refundable,
    // Line 32 adds 27 through 31 — Schedule 3's payments included. It carried
    // the refundable child credit alone, so an extension payment
    // printed on line 31 and vanished from line 32.
    'payments.L32_other_total':    ctc_detail.refundable + sched3_payments,
    'payments.L33_total':          total_payments,
    // Result. Line 34 is the overpayment; the line 38 penalty comes out of
    // what is refunded (35a) or is added to what is owed (37).
    'refund.L35a_refunded':        refund,
    'refund.L36_applied_est':      0,
    'result.L34_overpayment':      Math.max(0, -net),
    'owed.L37_amount_owed':        owed,
    'penalty.L38_est_penalty':     est_penalty,
  }
  // Keep zero values — structural. Only drop undefined/null.
  for (const k of Object.keys(field_values)) {
    if (field_values[k] === null || field_values[k] === undefined) {
      delete field_values[k]
    }
  }

  // ── Supporting schedules ──────────────────────────────────────
  // Emitted whenever they carry anything, so an export of the return shows
  // where each face line came from. Keys follow the canonical pattern
  // <schedule>.L<line>_<label>; the label is a convenience, the line is the
  // identifier.
  const put = (k: string, v: number) => { if (v) field_values[k] = Math.round(v) }
  // Schedule 1
  put('sched1.L5_rental_partnership_scorp', inp.schedule1_income + inp.k1_ordinary_income)
  put('sched1.L8z_other_income', other_income)
  put('sched1.L9_total_other_income', other_income)
  put('sched1.L10_additional_income', inp.schedule1_income + inp.k1_ordinary_income + other_income)
  put('sched1.L26_adjustments', adjustments)
  // Schedule 2
  put('sched2.L2_amt', amt)
  put('sched2.L3_add_1z_2', amt)
  put('sched2.L4_se_tax', se_tax)
  put('sched2.L11_additional_medicare', additional_medicare)
  put('sched2.L12_niit', niit)
  put('sched2.L21_total_other_taxes', niit + additional_medicare + se_tax)
  // Schedule 3
  put('sched3.L10_extension_payment', extension_payment)
  put('sched3.L11_excess_social_security', excess_ss)
  put('sched3.L15_total_payments', sched3_payments)
  // Schedule B — required over $1,500 of either
  if (inp.taxable_interest > 1500 || inp.ordinary_dividends > 1500 || detailIn.taxable_interest_detail || detailIn.ordinary_dividends_detail) {
    put('schedB.L2_total_interest', inp.taxable_interest)
    put('schedB.L4_taxable_interest', inp.taxable_interest)
    put('schedB.L6_total_dividends', inp.ordinary_dividends)
    ;(field_values as Record<string, any>)['schedB.L7a_foreign_account'] = detailIn.foreign_accounts ? 'Yes' : 'No'
  }
  // Schedule D / Form 8949
  if (schedD.any) {
    Object.assign(field_values, schedD.fv)
    // What carries to next year, short- and long-term (Capital Loss Carryover
    // Worksheet) — next year's line 6 and line 14.
    if (schedD.total < 0) {
      const next = capitalLossCarryoverWorksheet({
        taxableIncome: agi - deduction - qbi_deduction,
        lossAllowed: -schedD.lineAmount, netST: schedD.netST, netLT: schedD.netLT,
      })
      put('schedD.carryover_next_st', next.short_term)
      put('schedD.carryover_next_lt', next.long_term)
    }
  }
  // Form 8959 — Additional Medicare Tax
  if (additional_medicare || addl_medicare_withheld) {
    const threshold = s === 'mfj' ? 250000 : s === 'mfs' ? 125000 : 200000
    put('f8959.L1_medicare_wages', medicare_wages)
    put('f8959.L4_total', medicare_wages)
    put('f8959.L5_threshold', threshold)
    put('f8959.L6_excess', Math.max(0, medicare_wages - threshold))
    put('f8959.L7_tax_on_wages', additional_medicare)
    // Parts II and III restate the threshold, and Part II line 10 the wages
    // from line 4, even with no self-employment or RRTA income to test.
    put('f8959.L9_threshold', threshold)
    put('f8959.L10_wages_from_L4', medicare_wages)
    put('f8959.L15_threshold', threshold)
    put('f8959.L18_total', additional_medicare)
    if (w2.count) {
      put('f8959.L19_medicare_withheld', w2.medicareWithheld)
      put('f8959.L20_medicare_wages', w2.medicareWages)
      put('f8959.L21_regular_rate', w2.regularMedicare)
      put('f8959.L22_additional_withheld', addl_medicare_withheld)
      put('f8959.L24_total_withholding', addl_medicare_withheld)
    }
  }
  // Form 8960 — Net Investment Income Tax
  if (niit) {
    const threshold = s === 'mfj' ? 250000 : s === 'mfs' ? 125000 : 200000
    put('f8960.L1_interest', inp.taxable_interest)
    put('f8960.L2_dividends', inp.ordinary_dividends)
    // Lines 4a/4b: S-corporation income on Schedule E is entered in full on
    // 4a and backed out on 4b when it comes from a nonpassive trade or
    // business — which is what K-1 ordinary income from the shareholder's own
    // corporation is. 4c (their sum) is then zero.
    put('f8960.L4a_rental_partnership', inp.k1_ordinary_income)
    put('f8960.L4b_nonsection1411_adj', -inp.k1_ordinary_income)
    put('f8960.L5a_net_gain', nii_gain)
    put('f8960.L5d_combined', nii_gain)
    put('f8960.L7_other', other_investment_income)
    put('f8960.L8_total', nii)
    put('f8960.L12_net_investment_income', nii)
    put('f8960.L13_magi', agi)
    put('f8960.L14_threshold', threshold)
    put('f8960.L15_excess', Math.max(0, agi - threshold))
    put('f8960.L16_lesser', Math.min(nii, Math.max(0, agi - threshold)))
    put('f8960.L17_niit', niit)
  }
  // Form 8995-A — QBI deduction above the threshold (8995 below it)
  const qbi = inp.k1_ordinary_income + inp.qbi_from_k1
  if (qbi > 0) {
    const ncg = inp.qualified_dividends + Math.max(0, inp.ltcg_portion || 0)
    put('f8995a.L2_qbi', qbi)
    put('f8995a.L3_twenty_pct_qbi', qbi * 0.20)
    put('f8995a.L4_w2_wages', inp.k1_w2_wages)
    put('f8995a.L5_fifty_pct_wages', inp.k1_w2_wages * 0.50)
    put('f8995a.L6_twentyfive_pct_wages', inp.k1_w2_wages * 0.25)
    put('f8995a.L7_ubia', inp.k1_ubia)
    put('f8995a.L8_two_half_pct_ubia', inp.k1_ubia * 0.025)
    put('f8995a.L9_add_6_8', inp.k1_w2_wages * 0.25 + inp.k1_ubia * 0.025)
    const l10 = Math.max(inp.k1_w2_wages * 0.50, inp.k1_w2_wages * 0.25 + inp.k1_ubia * 0.025)
    put('f8995a.L10_greater_5_9', l10)
    // Part II, one business: line 11 caps 20% of QBI at the wage limit; with
    // no phased-in reduction (Part III) or patron reduction, it carries
    // unchanged through 13, 15 and 16 to the Part IV total on 27 and 32.
    const component = inp.is_sstb && tentative_taxable >= TAX_TABLES[inp.tax_year].qbi_phaseout[s]
      ? 0 : Math.min(qbi * 0.20, l10)
    put('f8995a.L11_smaller_3_10', component)
    put('f8995a.L13_greater_11_12', component)
    put('f8995a.L15_qbi_component', component)
    put('f8995a.L16_total_qbi_component', component)
    // Part III prints the threshold and phase-in range for the filing status.
    const t = TAX_TABLES[inp.tax_year]
    put('f8995a.L21_threshold', t.qbi_threshold[s])
    put('f8995a.L23_phase_in_range', t.qbi_phaseout[s] - t.qbi_threshold[s])
    put('f8995a.L27_total_qbi_component', component)
    put('f8995a.L32_qbi_before_income_limit', component)
    put('f8995a.L33_taxable_income_before_qbi', tentative_taxable)
    put('f8995a.L34_net_capital_gain', ncg)
    put('f8995a.L35_subtract', Math.max(0, tentative_taxable - ncg))
    put('f8995a.L36_income_limit', Math.max(0, tentative_taxable - ncg) * 0.20)
    put('f8995a.L37_qbi_before_dpad', qbi_deduction)
    put('f8995a.L39_qbi_deduction', qbi_deduction)
  }

  // Form 7203 — stock basis, from the K-1 items above plus the shareholder's
  // own basis facts. Required in any year with a distribution.
  if (detailIn.form7203 && typeof detailIn.form7203 === 'object') {
    const b = form7203StockBasis(detailIn.form7203, {
      ordinary: inp.k1_ordinary_income, interest: k1p.interest, dividends: k1p.ordinary_dividends,
      capitalGain: n0(k1p.st_gain) + n0(k1p.lt_gain),
    })
    for (const [k, v] of Object.entries(b.lines)) put(`f7203.${k}`, v)
    put('f7203.excess_distribution_gain', b.excessDistribution)
  }

  // Schedule 8812 — filed whenever a dependent is claimed, even when the
  // credit phases out to nothing (line 12 "No. Stop here").
  if ((inp.num_dependents || 0) > 0) {
    const kids = inp.num_dependents || 0
    const perChild = TAX_TABLES[inp.tax_year].child_tax_credit
    const l8 = kids * perChild
    const l9 = s === 'mfj' ? 400000 : 200000
    const l10 = Math.max(0, Math.ceil((agi - l9) / 1000) * 1000)
    const l11 = l10 * 0.05
    put('f8812.L1_agi', agi)
    put('f8812.L3_add_1_2d', agi)
    put('f8812.L4_qualifying_children', kids)
    put('f8812.L5_children_credit', l8)
    put('f8812.L8_add_5_7', l8)
    put('f8812.L9_threshold', l9)
    put('f8812.L10_excess_rounded', l10)
    put('f8812.L11_phaseout', l11)
    put('f8812.L12_after_phaseout', Math.max(0, l8 - l11))
    put('f8812.L13_credit_limit', income_tax + amt)
    put('f8812.L14_ctc_odc', ctc_nonrefundable)
  }

  return {
    computed: { ...computedCore, form2210_required_annual_payment: form2210_required, form2210_shortfall },
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
  section_179_max?:           number  // Line 1 (default: SECTION_179_LIMITS for the year — 2,500,000 for 2025)
  section_179_total_cost?:    number  // Line 2
  section_179_threshold?:     number  // Line 3 (default: SECTION_179_LIMITS — 4,000,000 for 2025)
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
  // Year table, not a literal: the 2025 literal was Rev. Proc. 2024-40's
  // $1.25M / $3.13M, which the One Big Beautiful Bill Act doubled.
  const lim179 = SECTION_179_LIMITS[year] ?? SECTION_179_LIMITS[2025]
  const max179 = inp.section_179_max ?? lim179.limit
  const threshold = inp.section_179_threshold ?? lim179.threshold
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

// ─────────────────────────────────────────────────────────────
// SCHEDULE E — Supplemental Income and Loss (Form 1040)
// Parts I (rental/royalty), II (partnerships/S-corps), III (estates/
// trusts), IV (REMICs), V (summary). Feeds into 1040 Schedule 1 Line 5.
// ─────────────────────────────────────────────────────────────

export interface RentalProperty {
  address?:             string
  property_type?:       string   // 1=Single Family, 2=Multi-Family, 3=Vacation, 4=Commercial, 5=Land, 6=Royalties, 7=Self-Rental, 8=Other
  fair_rental_days?:    number
  personal_use_days?:   number
  // Income
  rents:                number   // Line 3
  royalties?:           number   // Line 4
  // Expenses — Lines 5-19
  advertising?:         number
  auto_travel?:         number
  cleaning_maintenance?: number
  commissions?:         number
  insurance?:           number
  legal_professional?:  number
  management_fees?:     number
  mortgage_interest?:   number   // Line 12 (→ L23c)
  other_interest?:      number
  repairs?:             number
  supplies?:            number
  taxes?:               number
  utilities?:           number
  depreciation?:        number   // Line 18 (→ L23d)
  other_expenses?:      number
}

export interface PartnershipK1 {
  name:            string
  ein?:            string
  type:            'P' | 'S'  // partnership or S-corp
  passive?:        boolean
  ordinary_income: number     // K-1 Part III Line 1 (→ Schedule E line 28/29)
  section_179?:    number
}

export interface ScheduleE_Inputs {
  taxpayer_name?:        string
  taxpayer_id?:          string
  tax_year:              number
  rental_properties?:    RentalProperty[]
  partnerships?:         PartnershipK1[]
  // Part III — estates/trusts: summary only (detail not modeled)
  estate_trust_income?:  number  // Line 37
  // Part IV — REMICs
  remic_income?:         number  // Line 39
  // Part V reconciliation
  farm_rental?:          number  // Line 40 (Form 4835)
  // §469 passive activity loss limitation (Form 8582).
  // If omitted, all rental RE losses flow through as-is (optimistic).
  pal_limitation?: {
    filing_status:       'single' | 'mfj' | 'mfs' | 'hoh' | 'qw'
    magi:                number  // modified AGI (AGI + passive-loss addback)
    active_participation: boolean  // §469(i) special allowance gate
    prior_year_suspended_re?: number  // unallowed rental RE losses carried forward
  }
}

// ─────────────────────────────────────────────────────────────
// FORM 8582 — Passive Activity Loss Limitations (§469)
// MVP: rental real estate with active participation. Other passive
// activities (Part II "other") and real estate professional status
// not yet wired.
// ─────────────────────────────────────────────────────────────

export interface Form8582_Inputs {
  tax_year:                  number
  filing_status:             'single' | 'mfj' | 'mfs' | 'hoh' | 'qw'
  magi:                      number
  active_participation:      boolean
  rental_re_current_income:  number   // L1a — positive current-year RE L21 sum
  rental_re_current_loss:    number   // |L1b|
  rental_re_prior_unallowed: number   // |L1c|
  other_current_income:      number   // L2a
  other_current_loss:        number   // |L2b|
  other_prior_unallowed:     number   // |L2c|
}

export interface Form8582_Result {
  inputs:   Form8582_Inputs
  computed: {
    L1a: number; L1b: number; L1c: number; L1d: number
    L2a: number; L2b: number; L2c: number; L2d: number
    L3:  number
    L4:  number; L5: number; L6: number; L7: number; L8: number; L9: number
    L10: number; L11: number
    rental_re_allowed_loss: number   // total RE loss that deducts this year
    rental_re_suspended:    number
    other_allowed_loss:     number
    other_suspended:        number
  }
  field_values: Record<string, number>
  citations: string[]
}

export function calcForm8582(inp: Form8582_Inputs): Form8582_Result {
  const L1a =  Math.round(inp.rental_re_current_income || 0)
  const L1b = -Math.round(Math.abs(inp.rental_re_current_loss || 0))
  const L1c = -Math.round(Math.abs(inp.rental_re_prior_unallowed || 0))
  const L1d = L1a + L1b + L1c
  const L2a =  Math.round(inp.other_current_income || 0)
  const L2b = -Math.round(Math.abs(inp.other_current_loss || 0))
  const L2c = -Math.round(Math.abs(inp.other_prior_unallowed || 0))
  const L2d = L2a + L2b + L2c
  const L3  = L1d + L2d

  // Part II — Special allowance (active participation rental RE only)
  let L4 = 0, L5 = 0, L6 = 0, L7 = 0, L8 = 0, L9 = 0
  if (inp.active_participation && L1d < 0 && L3 < 0) {
    L4 = Math.min(Math.abs(L1d), Math.abs(L3))          // smaller of the two net losses
    L5 = inp.filing_status === 'mfs' ? 75000 : 150000
    L6 = Math.round(inp.magi || 0)
    L7 = Math.max(0, L5 - L6)
    const maxAllowance = inp.filing_status === 'mfs' ? 12500 : 25000
    L8 = Math.min(Math.round(L7 * 0.5), maxAllowance)
    L9 = Math.min(L4, L8)
  }

  // Part III — Total losses allowed
  const L10 = L1a + L2a
  const L11 = L9 + L10

  // Apportion L11 between rental RE (gets special allowance) and other (only netting).
  const total_re_gross_loss    = Math.abs(L1b) + Math.abs(L1c)
  const total_other_gross_loss = Math.abs(L2b) + Math.abs(L2c)

  // "Other" losses can only be offset by "other" income.
  const other_allowed  = Math.min(total_other_gross_loss, Math.max(0, L2a))
  const other_suspended = total_other_gross_loss - other_allowed

  // Rental RE: gets its own income offset plus the special allowance.
  const re_allowed = Math.min(total_re_gross_loss, L1a + L9 + Math.max(0, L2a - other_allowed))
  const re_suspended = total_re_gross_loss - re_allowed

  const field_values: Record<string, number> = {
    'f8582.L1a_rental_re_income':       L1a,
    'f8582.L1b_rental_re_loss':         L1b,
    'f8582.L1c_rental_re_prior':        L1c,
    'f8582.L1d_combine_1a_1b_1c':       L1d,
    'f8582.L2a_other_income':           L2a,
    'f8582.L2b_other_loss':             L2b,
    'f8582.L2c_other_prior':            L2c,
    'f8582.L2d_combine_2a_2b_2c':       L2d,
    'f8582.L3_combine_1d_2d':           L3,
    'f8582.L4_smaller_1d_3':            L4,
    'f8582.L5_threshold':               L5,
    'f8582.L6_magi':                    L6,
    'f8582.L7_excess':                  L7,
    'f8582.L8_allowance_after_phase':   L8,
    'f8582.L9_special_allowance':       L9,
    'f8582.L10_passive_income':         L10,
    'f8582.L11_total_allowed':          L11,
  }

  return {
    inputs: inp,
    computed: {
      L1a, L1b, L1c, L1d, L2a, L2b, L2c, L2d, L3, L4, L5, L6, L7, L8, L9, L10, L11,
      rental_re_allowed_loss: re_allowed,
      rental_re_suspended:    re_suspended,
      other_allowed_loss:     other_allowed,
      other_suspended:        other_suspended,
    },
    field_values,
    citations: [
      'IRC §469 — Passive activity losses and credits limited',
      'IRC §469(i) — $25,000 offset for rental real estate activities',
      'IRS Form 8582 Instructions',
    ],
  }
}

export interface ScheduleE_Result {
  inputs: ScheduleE_Inputs
  computed: {
    per_property: Array<{
      address: string
      total_expenses:     number   // Line 20
      net_income_loss:    number   // Line 21
      deductible_loss:    number   // Line 22 — after PAL pro-ration (if applied)
    }>
    // Part I totals
    L23a_total_rents:        number
    L23b_total_royalties:    number
    L23c_total_mortgage_int: number
    L23d_total_depreciation: number
    L23e_total_expenses:     number
    L24_income:              number   // sum of positive L21s
    L25_losses:              number   // sum of |L22s|  (deductible losses post-PAL)
    L26_rental_royalty_net:  number   // L24 - L25
    L32_partnership_total:   number   // Part II
    L37_estate_trust_total:  number   // Part III
    L39_remic_total:         number   // Part IV
    L40_farm_rental:         number
    L41_total_income_loss:   number   // flows to 1040 Sch 1 L5
    // PAL metadata (present when pal_limitation was provided)
    pal?: {
      form_8582:          Form8582_Result
      suspended_rental:   number   // RE loss carryforward to next year
      suspended_other:    number
    }
  }
  field_values: Record<string, number>
  citations: string[]
}

/** Schedule E calculation — totals-only; per-property cells not filled (PDF map covers summary only) */
export function calcScheduleE(inp: ScheduleE_Inputs): ScheduleE_Result {
  const props = inp.rental_properties || []
  const parts = inp.partnerships || []

  const per_property_raw = props.map(p => {
    const expenses = (p.advertising || 0) + (p.auto_travel || 0) + (p.cleaning_maintenance || 0)
      + (p.commissions || 0) + (p.insurance || 0) + (p.legal_professional || 0)
      + (p.management_fees || 0) + (p.mortgage_interest || 0) + (p.other_interest || 0)
      + (p.repairs || 0) + (p.supplies || 0) + (p.taxes || 0) + (p.utilities || 0)
      + (p.depreciation || 0) + (p.other_expenses || 0)
    const income = (p.rents || 0) + (p.royalties || 0)
    return {
      address:         p.address || '',
      total_expenses:  Math.round(expenses),
      net_income_loss: Math.round(income - expenses),
    }
  })

  // Apply Form 8582 PAL limitation if requested. We pro-rate the allowed loss
  // across loss-making properties by their magnitude so each property's L22
  // reflects its share of the special-allowance envelope.
  let pal: ScheduleE_Result['computed']['pal'] = undefined
  let per_property: ScheduleE_Result['computed']['per_property'] = per_property_raw.map(p => ({
    ...p, deductible_loss: p.net_income_loss < 0 ? p.net_income_loss : 0,
  }))
  if (inp.pal_limitation) {
    const pp = inp.pal_limitation
    const gross_re_income = per_property_raw.filter(p => p.net_income_loss > 0)
      .reduce((s, p) => s + p.net_income_loss, 0)
    const gross_re_loss = Math.abs(per_property_raw.filter(p => p.net_income_loss < 0)
      .reduce((s, p) => s + p.net_income_loss, 0))
    const f8582 = calcForm8582({
      tax_year:                   inp.tax_year,
      filing_status:              pp.filing_status,
      magi:                       pp.magi,
      active_participation:       pp.active_participation,
      rental_re_current_income:   gross_re_income,
      rental_re_current_loss:     gross_re_loss,
      rental_re_prior_unallowed:  pp.prior_year_suspended_re || 0,
      other_current_income:       0,
      other_current_loss:         0,
      other_prior_unallowed:      0,
    })
    const allowed_loss_pool = f8582.computed.rental_re_allowed_loss
    // Pro-rate allowed loss across loss-making properties by magnitude.
    // Properties with positive L21 are fully deductible (income flows through).
    const _total_raw_loss_mag = gross_re_loss + (pp.prior_year_suspended_re || 0)
    per_property = per_property_raw.map(p => {
      if (p.net_income_loss >= 0) {
        return { ...p, deductible_loss: 0 }
      }
      // Loss property: share = magnitude / total_raw_loss_mag (excluding prior year — prior is already outside per-property)
      const share = gross_re_loss > 0 ? Math.abs(p.net_income_loss) / gross_re_loss : 0
      const allowed_for_current_year = Math.max(0, allowed_loss_pool - (pp.prior_year_suspended_re || 0))
      const deductible = -Math.min(Math.abs(p.net_income_loss), Math.round(share * allowed_for_current_year))
      return { ...p, deductible_loss: deductible }
    })
    pal = {
      form_8582: f8582,
      suspended_rental: f8582.computed.rental_re_suspended,
      suspended_other:  f8582.computed.other_suspended,
    }
  }

  const L23a = Math.round(props.reduce((s, p) => s + (p.rents || 0), 0))
  const L23b = Math.round(props.reduce((s, p) => s + (p.royalties || 0), 0))
  const L23c = Math.round(props.reduce((s, p) => s + (p.mortgage_interest || 0), 0))
  const L23d = Math.round(props.reduce((s, p) => s + (p.depreciation || 0), 0))
  const L23e = Math.round(per_property.reduce((s, p) => s + p.total_expenses, 0))
  const L24  = per_property.filter(p => p.net_income_loss > 0).reduce((s, p) => s + p.net_income_loss, 0)
  // L25 uses deductible_loss (post-PAL) so Schedule E flows PAL-limited losses
  const L25  = Math.abs(per_property.reduce((s, p) => s + p.deductible_loss, 0))
  const L26  = L24 - L25

  const L32 = Math.round(parts.reduce((s, k) => s + (k.ordinary_income || 0), 0))
  const L37 = Math.round(inp.estate_trust_income || 0)
  const L39 = Math.round(inp.remic_income || 0)
  const L40 = Math.round(inp.farm_rental || 0)
  const L41 = L26 + L32 + L37 + L39 + L40

  const field_values: Record<string, number> = {
    'schedE.L23a_total_rents':        L23a,
    'schedE.L23b_total_royalties':    L23b,
    'schedE.L23c_total_mortgage_int': L23c,
    'schedE.L23d_total_depreciation': L23d,
    'schedE.L23e_total_expenses':     L23e,
    'schedE.L24_income':              L24,
    'schedE.L25_losses':              L25,
    'schedE.L26_rental_royalty_net':  L26,
    'schedE.L32_partnership_total':   L32,
    'schedE.L37_estate_trust_total':  L37,
    'schedE.L39_remic_total':         L39,
    'schedE.L40_farm_rental':         L40,
    'schedE.L41_total_income_loss':   L41,
  }

  return {
    inputs: inp,
    computed: {
      per_property,
      L23a_total_rents: L23a, L23b_total_royalties: L23b,
      L23c_total_mortgage_int: L23c, L23d_total_depreciation: L23d,
      L23e_total_expenses: L23e, L24_income: L24, L25_losses: L25,
      L26_rental_royalty_net: L26, L32_partnership_total: L32,
      L37_estate_trust_total: L37, L39_remic_total: L39,
      L40_farm_rental: L40, L41_total_income_loss: L41,
      ...(pal ? { pal } : {}),
    },
    field_values: {
      ...field_values,
      ...(pal ? pal.form_8582.field_values : {}),
    },
    citations: [
      'IRC §61(a)(5) — rental income',
      'IRC §212 — expenses for production of income',
      'IRC §469 — passive activity limitations',
      'IRS Form 1040 Schedule E Instructions',
      ...(pal ? pal.form_8582.citations : []),
    ],
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
    s_corp_income:       number
    k1_to_individual:    number
    individual_tax:      number  // Schedule J line 2 equivalent — income tax only
    qbi_saved:           number
    // Separately-stated surtaxes so they're obvious in the delta rather
    // than silently rolled into individual_tax. Both are independently
    // deterministic from wages / net_se_income / investment income / filing status.
    additional_medicare: number  // §3101(b)(2) — 0.9% on wages+SE above $250k MFJ / $200k single
    niit:                number  // §1411 — 3.8% on net investment income above MAGI threshold
    total_tax:           number  // Form 1040 line 24 — sum of all federal tax owed
  }
  warnings: Array<{ code: string; message: string; fix_hint?: string }>
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

  // Loud diagnostic: if wages + SE income cross the Additional Medicare
  // threshold but the computed surtax is zero, something is off. Should
  // never happen once calc1040 is wired correctly, but surface it so a
  // regression doesn't silently skip $1k–2k of tax.
  const warnings: Array<{ code: string; message: string; fix_hint?: string }> = []
  const addMedThreshold = individual_base.filing_status === 'mfj' || individual_base.filing_status === 'qw' ? 250000
    : individual_base.filing_status === 'mfs' ? 125000
    : 200000
  const addMedBase = (individual_base.wages || 0) + (individual_base.net_se_income || 0)
  if (addMedBase > addMedThreshold && individual.computed.additional_medicare === 0) {
    warnings.push({
      code: 'ADDMED_ZERO_DESPITE_HIGH_WAGES',
      message: `Wages + SE income ($${addMedBase.toLocaleString()}) exceeds the Additional Medicare Tax threshold ($${addMedThreshold.toLocaleString()} for ${individual_base.filing_status}) but the computed surtax is $0. Expected ~0.9% × excess.`,
      fix_hint: 'Verify wages and net_se_income are passed as separate scalars; calc1040 sums them. If both are present and non-zero, this is a bug — file it.',
    })
  }

  return {
    s_corp,
    individual,
    delta: {
      s_corp_income:       s_corp.computed.ordinary_income_loss,
      k1_to_individual:    primary_k1.ordinary_income,
      individual_tax:      individual.computed.income_tax,
      qbi_saved:           individual.computed.qbi_deduction,
      additional_medicare: individual.computed.additional_medicare || 0,
      niit:                individual.computed.niit || 0,
      total_tax:           individual.computed.total_tax,
    },
    warnings,
  }
}

// ─── Schedule K-1 (Form 1065) allocation ───
// NOT a 1065 return engine — that rule stands (1065s enter Cati only as
// filed imports). This allocates caller-supplied Schedule K totals across
// partners pro-rata so the ISSUER side can generate distributable K-1s
// (SOP-04 tester: "as managing partner I had to send out the K-1s").
// Special allocations are out of scope: income items follow profit_pct,
// losses loss_pct, distributions capital_pct; guaranteed payments are
// per-partner facts, never allocated. SE earnings (box 14A) apply to
// general partners only: ordinary share + own guaranteed payments.

export interface K1Totals1065 {
  ordinary_business_income?: number
  rental_real_estate?:       number
  other_rental?:             number
  interest_income?:          number
  dividends_ordinary?:       number
  dividends_qualified?:      number
  royalties?:                number
  st_cap_gain?:              number
  lt_cap_gain?:              number
  net_1231_gain?:            number
  section_179?:              number
  charitable?:               number
  distributions?:            number
  w2_wages?:                 number  // §199A Statement A
  ubia?:                     number  // §199A Statement A
}

export interface Partner1065 {
  name: string
  tin?: string
  address?: string
  entity_type?: string        // Part II box I1, default 'Individual'
  is_general?: boolean        // box G; drives SE earnings
  profit_pct: number
  loss_pct?: number           // default profit_pct
  capital_pct?: number        // default profit_pct
  guaranteed_payments_services?: number
  guaranteed_payments_capital?:  number
}

export interface K1Allocation1065 {
  name: string
  tin?: string
  address?: string
  entity_type: string
  is_general: boolean
  profit_pct: number
  loss_pct: number
  capital_pct: number
  ordinary_income: number
  rental_real_estate: number
  other_rental: number
  guaranteed_payments_services: number
  guaranteed_payments_capital: number
  interest_income: number
  dividends_ordinary: number
  dividends_qualified: number
  royalties: number
  st_cap_gain: number
  lt_cap_gain: number
  net_1231_gain: number
  section_179: number
  charitable: number
  distributions: number
  se_earnings: number
  qbi_income: number
  w2_wages: number
  ubia: number
}

export function calc1065K1s(totals: K1Totals1065, partners: Partner1065[]): K1Allocation1065[] {
  if (!partners.length) throw new Error('at least one partner is required')
  const profitSum = partners.reduce((s, p) => s + p.profit_pct, 0)
  if (Math.abs(profitSum - 100) > 0.01) {
    throw new Error(`profit percentages must sum to 100 (got ${profitSum})`)
  }
  const share = (v: number | undefined, pct: number) => Math.round((v || 0) * pct / 100)
  return partners.map(p => {
    const loss_pct = p.loss_pct ?? p.profit_pct
    const capital_pct = p.capital_pct ?? p.profit_pct
    const ordinary_income = share(totals.ordinary_business_income, p.profit_pct)
    const gpS = Math.round(p.guaranteed_payments_services || 0)
    const gpC = Math.round(p.guaranteed_payments_capital || 0)
    return {
      name: p.name,
      tin: p.tin,
      address: p.address,
      entity_type: p.entity_type || 'Individual',
      is_general: p.is_general ?? false,
      profit_pct: p.profit_pct,
      loss_pct,
      capital_pct,
      ordinary_income,
      rental_real_estate: share(totals.rental_real_estate, p.profit_pct),
      other_rental: share(totals.other_rental, p.profit_pct),
      guaranteed_payments_services: gpS,
      guaranteed_payments_capital: gpC,
      interest_income: share(totals.interest_income, p.profit_pct),
      dividends_ordinary: share(totals.dividends_ordinary, p.profit_pct),
      dividends_qualified: share(totals.dividends_qualified, p.profit_pct),
      royalties: share(totals.royalties, p.profit_pct),
      st_cap_gain: share(totals.st_cap_gain, p.profit_pct),
      lt_cap_gain: share(totals.lt_cap_gain, p.profit_pct),
      net_1231_gain: share(totals.net_1231_gain, p.profit_pct),
      section_179: share(totals.section_179, p.profit_pct),
      charitable: share(totals.charitable, p.profit_pct),
      distributions: share(totals.distributions, capital_pct),
      se_earnings: p.is_general ? ordinary_income + gpS + gpC : 0,
      qbi_income: ordinary_income,
      w2_wages: share(totals.w2_wages, p.profit_pct),
      ubia: share(totals.ubia, p.profit_pct),
    }
  })
}
