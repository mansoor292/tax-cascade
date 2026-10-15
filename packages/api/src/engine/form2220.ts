/**
 * Form 2220 — Underpayment of Estimated Tax by Corporations (2025 form).
 *
 * Why this exists: Form 1120 line 34 (estimated tax penalty) had no engine at
 * all. A corporation that made no estimated payments printed line 34 blank and
 * line 35 short by the penalty, so the balance due on our 1120 disagreed with
 * the return the filer's software produced for the same figures (the
 * 2026-10-15 filed-return parity sprint found exactly that).
 *
 * This is the regular installment method (Parts I, III, IV) line for line, so
 * the attached form can be printed from the same numbers that reach line 34:
 *  - required installments are 25% of line 5, each rounded to whole dollars;
 *  - every penalty cell (lines 22-36) is rounded on its own and the cells are
 *    then added, which is how the form is completed and how filed software
 *    rounds — rounding the total instead drifts by a dollar or two;
 *  - the rate periods are the ones PRINTED on the 2025 form (7% through
 *    3/31/2026). Later periods print "*%" — the IRS sets those rates after the
 *    form is published — so they come from `later_rates` and default to 0,
 *    which is what a return prepared on the published form shows.
 *
 * Not modeled (callers must not pass these cases): the annualized-income and
 * adjusted-seasonal methods (Schedule A, lines 6-7), the large-corporation
 * first-installment rule (line 8), short or fiscal tax years. The rate periods
 * are 2025's, so any other tax year is refused rather than computed on the
 * wrong calendar.
 */
import { TaxInputError } from './tax_engine.js'

export interface Form2220Payment {
  /** ISO date the payment was made (or credited). */
  date: string
  amount: number
}

export interface Form2220Inputs {
  tax_year: number
  /** Line 1 — total tax (Form 1120, Schedule J line 12 / page 1 line 31). */
  total_tax: number
  /** Line 2a-2c — PHC tax, look-back interest, fuel credit included on line 1. */
  phc_tax?: number
  lookback_interest?: number
  fuel_credit?: number
  /** Line 4 — tax shown on the prior-year (2024) return. Omit (or 0) when the prior year had no tax or was short. */
  prior_year_tax?: number | null
  /** Estimated tax paid or credited, by date. Payments after an installment due date reduce the penalty from the day paid. */
  payments?: Form2220Payment[]
  /** Rates for the four "*%" periods (lines 30, 32, 34, 36), as decimals. Default 0 — see header. */
  later_rates?: number[]
}

export interface Form2220Result {
  L1: number; L2a: number; L2b: number; L2c: number; L2d: number
  L3: number; L4: number | null; L5: number
  /** False when line 3 is under $500: no penalty and no form. */
  required: boolean
  L9: string[]            // MM/DD/YYYY
  L10: number[]
  L11: number[]
  L12: Array<number | null>  // column (a) is shaded
  L13: Array<number | null>
  L14: Array<number | null>
  L15: number[]
  L16: Array<number | null>  // columns (b) and (c) only
  L17: number[]
  L18: Array<number | null>  // columns (a)-(c) only
  L19: string[]
  L20: number[]
  /** Lines 21-36 as [daysLine, penaltyLine] pairs: periods[k].days[col], periods[k].penalty[col]. */
  periods: Array<{ days_line: number; penalty_line: number; rate: number | null; days: number[]; penalty: number[] }>
  L37: number[]
  L38: number
}

const DAY = 86_400_000

function utc(y: number, m: number, d: number): number { return Date.UTC(y, m - 1, d) }
function parseIso(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
  if (!m) throw new TaxInputError('form2220.payments', s, 'payment dates must be ISO YYYY-MM-DD')
  return utc(+m[1], +m[2], +m[3])
}
function us(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`
}
/** Days in (start, end] — the form counts days AFTER the due date up to and including the payment date. */
function daysBetween(start: number, end: number): number { return Math.max(0, Math.round((end - start) / DAY)) }

/**
 * The 2025 form's rate periods. `after`/`before` are exclusive bounds exactly
 * as printed ("Number of days on line 20 after 4/15/2025 and before 7/1/2025").
 */
function periods2025(later: number[]) {
  return [
    { days_line: 21, penalty_line: 22, after: utc(2025, 4, 15), before: utc(2025, 7, 1), rate: 0.07 as number | null },
    { days_line: 23, penalty_line: 24, after: utc(2025, 6, 30), before: utc(2025, 10, 1), rate: 0.07 },
    { days_line: 25, penalty_line: 26, after: utc(2025, 9, 30), before: utc(2026, 1, 1), rate: 0.07 },
    { days_line: 27, penalty_line: 28, after: utc(2025, 12, 31), before: utc(2026, 4, 1), rate: 0.07 },
    { days_line: 29, penalty_line: 30, after: utc(2026, 3, 31), before: utc(2026, 7, 1), rate: later[0] ?? 0 },
    { days_line: 31, penalty_line: 32, after: utc(2026, 6, 30), before: utc(2026, 10, 1), rate: later[1] ?? 0 },
    { days_line: 33, penalty_line: 34, after: utc(2026, 9, 30), before: utc(2027, 1, 1), rate: later[2] ?? 0 },
    { days_line: 35, penalty_line: 36, after: utc(2026, 12, 31), before: utc(2027, 3, 16), rate: later[3] ?? 0 },
  ]
}

export function calc2220(inp: Form2220Inputs): Form2220Result {
  if (inp.tax_year !== 2025) {
    throw new TaxInputError('form2220.tax_year', inp.tax_year, 'Form 2220 is modeled for the 2025 form only (its penalty-rate periods are year-specific)')
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
  const L1 = Math.round(num(inp.total_tax))
  const L2a = Math.round(num(inp.phc_tax)), L2b = Math.round(num(inp.lookback_interest)), L2c = Math.round(num(inp.fuel_credit))
  const L2d = L2a + L2b + L2c
  const L3 = L1 - L2d
  const prior = inp.prior_year_tax === null || inp.prior_year_tax === undefined ? null : Math.round(num(inp.prior_year_tax))
  const L4 = prior && prior > 0 ? prior : null
  const L5 = L4 === null ? L3 : Math.min(L3, L4)
  const required = L3 >= 500

  const y = inp.tax_year
  const due = [utc(y, 4, 15), utc(y, 6, 15), utc(y, 9, 15), utc(y, 12, 15)]
  const penaltyEnd = utc(y + 1, 4, 15)  // 15th day of the 4th month after the close of the year
  const L10 = due.map(() => Math.round(L5 * 0.25))

  // Line 11: payments made in each installment period; later payments are
  // applied below to the underpayments they cure.
  const pays = (inp.payments || []).map(p => ({ t: parseIso(p.date), amount: num(p.amount) }))
    .filter(p => p.amount > 0).sort((a, b) => a.t - b.t)
  const L11 = due.map((d, i) => pays.filter(p => p.t <= d && (i === 0 || p.t > due[i - 1])).reduce((s, p) => s + p.amount, 0))

  // Part III, column by column, exactly as the form reads.
  const L12: Array<number | null> = [null], L13: Array<number | null> = [null], L14: Array<number | null> = [null]
  const L15: number[] = [], L16: Array<number | null> = [null], L17: number[] = [], L18: Array<number | null> = []
  for (let i = 0; i < 4; i++) {
    let l15: number
    if (i === 0) {
      l15 = L11[0]
    } else {
      const l12 = L18[i - 1] ?? 0
      const l13 = L11[i] + l12
      const l14 = (L16[i - 1] ?? 0) + L17[i - 1]
      L12.push(l12); L13.push(l13); L14.push(l14)
      l15 = Math.max(0, l13 - l14)
      if (i < 3) L16.push(l15 === 0 ? l14 - l13 : 0)
    }
    L15.push(l15)
    if (l15 <= L10[i]) {
      L17.push(L10[i] - l15)
      if (i < 3) L18.push(0)
    } else {
      L17.push(0)
      if (i < 3) L18.push(l15 - L10[i])
    }
  }

  // Line 19: the earlier of the date the underpayment was paid or the 15th
  // day of the 4th month after year end. Payments after an installment's due
  // date cure the earliest outstanding underpayment first.
  const late = pays.filter(p => p.t > due[0])
  const L19 = due.map(() => penaltyEnd)
  const outstanding = L17.slice()
  for (const p of late) {
    let left = p.amount
    for (let i = 0; i < 4 && left > 0; i++) {
      if (outstanding[i] <= 0 || p.t <= due[i]) continue
      const used = Math.min(left, outstanding[i])
      outstanding[i] -= used
      left -= used
      if (outstanding[i] <= 0) L19[i] = Math.min(L19[i], p.t)
    }
  }
  const L20 = due.map((d, i) => daysBetween(d, L19[i]))

  // Part IV. Each cell is rounded to whole dollars before the columns are added.
  const periods = periods2025(inp.later_rates || []).map(per => {
    const days = due.map((d, i) => {
      const start = Math.max(d, per.after)
      const end = Math.min(L19[i], per.before - DAY)
      return L17[i] > 0 ? daysBetween(start, end) : 0
    })
    const penalty = days.map((n, i) => Math.round(L17[i] * n / 365 * (per.rate ?? 0)))
    return { days_line: per.days_line, penalty_line: per.penalty_line, rate: per.rate, days, penalty }
  })
  const L37 = due.map((_, i) => periods.reduce((s, p) => s + p.penalty[i], 0))
  const L38 = required ? L37.reduce((s, v) => s + v, 0) : 0

  return {
    L1, L2a, L2b, L2c, L2d, L3, L4, L5, required,
    L9: due.map(us), L10, L11, L12, L13, L14, L15, L16, L17, L18,
    L19: L19.map(us), L20, periods, L37, L38,
  }
}
