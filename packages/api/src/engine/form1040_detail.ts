/**
 * Form 1040 supporting schedules, as data.
 *
 * calc1040 computed the face of the return and nothing behind it. Schedules
 * 1, 2, 3, B and D and Forms 8949, 8959, 8960 and 8995-A existed only as
 * single figures folded into a 1040 line, so an export of a computed return
 * could not say where line 8 came from, which payers made up line 2b, or how
 * the 0.9% and 3.8% taxes on line 23 were reached. Preparing the 2025 joint
 * return meant rebuilding every one of them by hand from W-2s and a broker
 * statement — and the face lines were wrong in places too:
 *
 *  - 1040 line 8 carried schedule1_income only, so K-1 ordinary income (which
 *    IS Schedule 1 line 5) was in line 9's total and missing from line 8.
 *  - Net investment income netted a capital LOSS against interest and
 *    dividends. Form 8960 line 5a is the net gain, never below zero.
 *  - A net capital loss reached line 7 uncapped; §1211(b) allows 3,000.
 *  - Additional Medicare tax ran on box 1 wages; Form 8959 uses box 5, and
 *    the 0.9% an employer already withheld (line 24 → 1040 line 25c) was never
 *    credited.
 *  - Two employers each withholding social security on a full wage base
 *    produced no excess-SS credit (Schedule 3 line 11).
 *  - A payment sent with Form 4868 had nowhere to go except "estimated
 *    payments", which is a different line (26 vs Schedule 3 line 10) and
 *    counts as timely for Form 2210 when it is not.
 *
 * This module turns the caller's source documents into those schedules. Every
 * structured input is optional; a caller that still sends only the scalar
 * fields gets the same answer as before apart from the corrections above.
 */

import { SS_WAGE_BASE } from './tax_tables.js'

export interface W2Input {
  /** Whose W-2 — matters only for the excess social security credit, which is per person. */
  owner?: 'taxpayer' | 'spouse'
  employer?: string
  box1: number
  box2: number
  box3?: number
  box4?: number
  box5?: number
  box6?: number
}

export interface DetailItem {
  label: string
  amount: number
  /** Dividends only: the qualified portion (1099-DIV box 1b). */
  qualified?: number
  /** Other income only: counts as net investment income (e.g. 1099-MISC box 8). */
  investment?: boolean
}

export interface CapitalTransaction {
  label: string
  proceeds: number
  basis: number
  /** Form 8949 column (g). */
  adjustment?: number
  term: 'short' | 'long'
  /** Form 8949 box: A/B/C short-term, D/E/F long-term. Defaults to A or D. */
  box?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
}

export interface K1PortfolioItems {
  name?: string
  interest?: number
  ordinary_dividends?: number
  qualified_dividends?: number
  st_gain?: number
  lt_gain?: number
}

/**
 * Form 7203 facts only the shareholder has; the K-1 income items come from
 * k1_ordinary_income / k1_portfolio already on the return.
 */
export interface Form7203Input {
  /** Whose basis this is — on a joint return, often the spouse. */
  shareholder?: 'primary' | 'spouse'
  scorp_name?: string
  scorp_ein?: string
  stock_basis_boy?: number
  capital_contributions?: number
  /** K-1 box 16D, non-dividend distributions. */
  distributions?: number
  /** K-1 box 16C. */
  nondeductible_expenses?: number
  oil_gas_depletion?: number
  /** K-1 box 16A/16B. */
  tax_exempt_income?: number
  other_increases?: number
}

/**
 * Form 7203 Part I (stock basis), lines 1-15, for a year with no loss items.
 * Distributions above basis zero line 7; the excess is capital gain the
 * shareholder reports on Form 8949, returned as `excessDistribution`.
 */
export function form7203StockBasis(
  f: Form7203Input,
  k1: { ordinary?: number; interest?: number; dividends?: number; capitalGain?: number },
) {
  const L: Record<string, number> = {}
  L.L1_stock_basis_boy = n(f.stock_basis_boy)
  L.L2_contributions = n(f.capital_contributions)
  L.L3a_ordinary_income = Math.max(0, n(k1.ordinary))
  L.L3d_interest = Math.max(0, n(k1.interest))
  L.L3e_dividends = Math.max(0, n(k1.dividends))
  L.L3g_capital_gain = Math.max(0, n(k1.capitalGain))
  L.L3k_tax_exempt = n(f.tax_exempt_income)
  L.L3m_other_increases = n(f.other_increases)
  L.L4_increases = L.L3a_ordinary_income + L.L3d_interest + L.L3e_dividends + L.L3g_capital_gain +
    L.L3k_tax_exempt + L.L3m_other_increases
  L.L5_basis_before_distributions = L.L1_stock_basis_boy + L.L2_contributions + L.L4_increases
  L.L6_distributions = n(f.distributions)
  L.L7_basis_after_distributions = Math.max(0, L.L5_basis_before_distributions - L.L6_distributions)
  L.L8a_nondeductible = n(f.nondeductible_expenses)
  L.L8b_oil_gas_depletion = n(f.oil_gas_depletion)
  L.L9_add_8 = L.L8a_nondeductible + L.L8b_oil_gas_depletion
  L.L10_basis_before_losses = Math.max(0, L.L7_basis_after_distributions - L.L9_add_8)
  L.L15_stock_basis_eoy = L.L10_basis_before_losses
  const excessDistribution = Math.max(0, L.L6_distributions - L.L5_basis_before_distributions)
  return { lines: L, excessDistribution }
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(x) ? x : 0
}
const r = (x: number) => Math.round(x)
const sum = <T>(xs: T[] | undefined, f: (x: T) => number) => (xs || []).reduce((t, x) => t + f(x), 0)

/** W-2 roll-up: line 1a/25a, Form 8959 Part I/V, and Schedule 3 line 11. */
export function summarizeW2s(w2s: W2Input[] | undefined, year: number) {
  const list = Array.isArray(w2s) ? w2s : []
  const wages = sum(list, w => n(w.box1))
  const withholding = sum(list, w => n(w.box2))
  const medicareWages = sum(list, w => n(w.box5 ?? w.box1))
  const medicareWithheld = sum(list, w => n(w.box6))
  // Form 8959 Part V: what each employer withheld beyond the 1.45% regular rate.
  const regularMedicare = r(medicareWages * 0.0145)
  const addlMedicareWithheld = Math.max(0, r(medicareWithheld - regularMedicare))

  // Excess social security: per person, only when more than one employer, and
  // only for amounts above 6.2% of the wage base. One employer over-withholding
  // is that employer's refund to make, not a credit on the return.
  const cap = r((SS_WAGE_BASE[year] ?? 176100) * 0.062)
  let excessSS = 0
  for (const owner of ['taxpayer', 'spouse'] as const) {
    const mine = list.filter(w => (w.owner ?? 'taxpayer') === owner)
    if (mine.length < 2) continue
    excessSS += Math.max(0, r(sum(mine, w => n(w.box4))) - cap)
  }
  return { count: list.length, wages: r(wages), withholding: r(withholding), medicareWages: r(medicareWages),
    medicareWithheld: r(medicareWithheld), regularMedicare, addlMedicareWithheld, excessSS }
}

/**
 * Capital losses carried in from the prior year (Schedule D lines 6 and 14),
 * as POSITIVE amounts — the form prints them in parentheses. They come off the
 * prior year's Capital Loss Carryover Worksheet (lines 8 and 13).
 *
 * A filed 2025 return carried a long-term loss in from 2024 and the engine
 * had nowhere to put it: line 7 of the 1040 showed a few hundred dollars of
 * loss where the filed return correctly showed the 3,000 limit, overstating
 * income — and the 3.8% investment income tax with it.
 */
export interface CapitalLossCarryover {
  short_term?: number
  long_term?: number
}

/** Schedule D / Form 8949 from transactions plus K-1 gains, with the §1211(b) limit. */
export function scheduleD(
  txns: CapitalTransaction[] | undefined,
  k1: K1PortfolioItems | undefined,
  filingStatus: string,
  carryover?: CapitalLossCarryover,
) {
  const list = Array.isArray(txns) ? txns : []
  const gain = (t: CapitalTransaction) => n(t.proceeds) - n(t.basis) + n(t.adjustment)
  const boxOf = (t: CapitalTransaction) => t.box ?? (t.term === 'long' ? 'D' : 'A')
  const rows: Record<string, { proceeds: number; basis: number; adj: number; gain: number }> = {}
  for (const t of list) {
    // Box A/D with no adjustment goes straight on Schedule D line 1a/8a
    // without Form 8949; anything else goes through 8949 to its line.
    const b = boxOf(t)
    const adj = n(t.adjustment)
    const line = b === 'A' ? (adj ? '1b' : '1a') : b === 'B' ? '2' : b === 'C' ? '3'
      : b === 'D' ? (adj ? '8b' : '8a') : b === 'E' ? '9' : '10'
    const row = rows[line] ||= { proceeds: 0, basis: 0, adj: 0, gain: 0 }
    row.proceeds += n(t.proceeds); row.basis += n(t.basis); row.adj += adj; row.gain += gain(t)
  }
  const st = sum(Object.entries(rows).filter(([l]) => ['1a', '1b', '2', '3'].includes(l)), ([, v]) => v.gain)
  const lt = sum(Object.entries(rows).filter(([l]) => ['8a', '8b', '9', '10'].includes(l)), ([, v]) => v.gain)
  const k1st = n(k1?.st_gain), k1lt = n(k1?.lt_gain)
  const stCarry = Math.abs(n(carryover?.short_term)), ltCarry = Math.abs(n(carryover?.long_term))
  const netST = r(st + k1st - stCarry)       // line 7
  const netLT = r(lt + k1lt - ltCarry)       // line 15
  const total = netST + netLT                // line 16
  const limit = filingStatus === 'mfs' ? 1500 : 3000
  const allowed = total < 0 ? Math.max(total, -limit) : total   // line 21 / 1040 line 7
  // Gain taxed at preferential rates (Schedule D line 15 vs 16 worksheet).
  const netCapitalGain = total > 0 && netLT > 0 ? Math.min(netLT, total) : 0
  const fv: Record<string, number> = {}
  for (const [line, v] of Object.entries(rows)) {
    fv[`schedD.L${line}_proceeds_d`] = r(v.proceeds)
    fv[`schedD.L${line}_basis_e`] = r(v.basis)
    if (v.adj) fv[`schedD.L${line}_adjustment_g`] = r(v.adj)
    fv[`schedD.L${line}_gain_h`] = r(v.gain)
  }
  if (k1st) fv['schedD.L5_k1_st_gain'] = r(k1st)
  if (stCarry) fv['schedD.L6_st_carryover'] = r(stCarry)
  fv['schedD.L7_net_short_term'] = netST
  if (k1lt) fv['schedD.L12_k1_lt_gain'] = r(k1lt)
  if (ltCarry) fv['schedD.L14_lt_carryover'] = r(ltCarry)
  fv['schedD.L15_net_long_term'] = netLT
  fv['schedD.L16_total'] = total
  if (total < 0) {
    fv['schedD.L21_loss_allowed'] = allowed
    if (total !== allowed) fv['schedD.loss_carryover'] = total - allowed
  }
  return {
    lineAmount: allowed, total, netST, netLT, netCapitalGain, fv,
    any: list.length > 0 || !!k1st || !!k1lt || !!stCarry || !!ltCarry,
  }
}

/**
 * Capital Loss Carryover Worksheet (Schedule D instructions), lines 1-13:
 * how much of this year's net capital loss is left for next year, split
 * short / long-term. The §1211(b) deduction is used up short-term first.
 *
 * `taxableIncome` is Form 1040 line 15 — negative when line 15 would be
 * below zero before the floor (callers pass the unfloored figure if known).
 */
export function capitalLossCarryoverWorksheet(p: {
  taxableIncome: number
  lossAllowed: number          // Schedule D line 21, as a positive number
  netST: number                // Schedule D line 7
  netLT: number                // Schedule D line 15
}) {
  const l1 = p.taxableIncome
  const l2 = Math.abs(p.lossAllowed)
  const l3 = Math.max(0, l1 + l2)
  const l4 = Math.min(l2, l3)
  let st = 0, lt = 0
  let l7 = 0
  if (p.netST < 0) {
    const l5 = -p.netST
    const l6 = Math.max(0, p.netLT)
    l7 = l4 + l6
    st = Math.max(0, l5 - l7)                                   // line 8
  }
  if (p.netLT < 0) {
    const l9 = -p.netLT
    const l10 = Math.max(0, p.netST)
    const l11 = l4
    const l12 = p.netST < 0 ? Math.max(0, l7 - (-p.netST)) : 0  // unused deduction left after short-term
    const l13 = l10 + (p.netST < 0 ? l12 : l11)
    lt = Math.max(0, l9 - l13)                                  // line 13
  }
  return { short_term: r(st), long_term: r(lt) }
}

/**
 * Form 2210, Part III regular method — the underpayment penalty on 1040 line 38.
 *
 * A filed 2025 return carried a line 38 penalty the engine never computed
 * (it reported the shortfall and stopped); this reproduces it to the dollar. The regular method is
 * mechanical once three facts are known: the required annual payment, what
 * was paid by each installment date, and the IRS underpayment rate for each
 * quarter. Withholding counts as paid evenly on the four due dates unless the
 * caller says otherwise; a payment sent with the extension is paid on its
 * own date, which is the return's due date, so it stops the penalty clock
 * there and never counts as timely.
 *
 * The penalty runs from each installment's due date to the date the
 * underpayment is paid, or the return's original due date if earlier. Rates
 * are the §6621(a)(2) underpayment rates, per quarter.
 */
const UNDERPAYMENT_RATES: Record<string, number> = {
  '2024Q1': 0.08, '2024Q2': 0.08, '2024Q3': 0.08, '2024Q4': 0.08,
  '2025Q1': 0.07, '2025Q2': 0.07, '2025Q3': 0.07, '2025Q4': 0.07,
  '2026Q1': 0.07, '2026Q2': 0.07,
}

/** 2025 installment due dates (Form 2210 line 19 column headings); a weekend date rolls to Monday. */
const INSTALLMENT_DUE: Record<number, string[]> = {
  2024: ['2024-04-15', '2024-06-17', '2024-09-16', '2025-01-15'],
  2025: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
}

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000
const isoOf = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const yearDays = (y: number) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365)

/**
 * Penalty = Σ over days of (unpaid required installments that day) × that
 * quarter's rate / days in the year. Form 2210's worksheet assigns each
 * payment to the earliest underpayment and counts days per installment; the
 * total is the same integral, computed here directly so payment ordering and
 * mid-period rate changes need no special cases.
 */
export function form2210Penalty(p: {
  taxYear: number
  requiredAnnualPayment: number
  /** Withholding, treated as paid in four equal parts on the due dates. */
  withholding: number
  /** Dated payments other than withholding (estimates, extension payment), ISO dates. */
  payments?: Array<{ date: string; amount: number }>
}): { penalty: number; underpayments: number[] } | null {
  const due = INSTALLMENT_DUE[p.taxYear]
  if (!due || p.requiredAnnualPayment <= 0) return null
  const endDate = `${p.taxYear + 1}-04-15`
  const required = p.requiredAnnualPayment / 4
  const withheld = n(p.withholding) / 4
  const pays = (p.payments || []).filter(x => n(x.amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(x.date))
  const paidBy = (iso: string) =>
    pays.filter(x => x.date <= iso).reduce((t, x) => t + n(x.amount), 0) +
    withheld * due.filter(d => d <= iso).length
  const requiredBy = (iso: string) => required * due.filter(d => d <= iso).length

  // Section A: the underpayment shown for each installment (line 25).
  const underpayments = due.map(d => Math.max(0, requiredBy(d) - paidBy(d)))
    .map((cum, i, all) => Math.max(0, cum - (i ? all[i - 1] : 0)))

  let penalty = 0
  for (let d = day(due[0]) + 1; d <= day(endDate); d++) {
    const iso = isoOf(d)
    // The installment due today is not late until tomorrow.
    const owed = requiredBy(isoOf(d - 1)) - paidBy(isoOf(d - 1))
    if (owed <= 0) continue
    const y = +iso.slice(0, 4), q = Math.floor((+iso.slice(5, 7) - 1) / 3) + 1
    const rate = UNDERPAYMENT_RATES[`${y}Q${q}`]
    if (rate === undefined) return null
    penalty += owed * rate / yearDays(y)
  }
  return { penalty: r(penalty), underpayments: underpayments.map(r) }
}
