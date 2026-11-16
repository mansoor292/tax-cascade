/**
 * QuickBooks → Form 1065 inputs, by translating the corporate mapper's packet.
 *
 * The P&L buckets and the balance sheet are classified once, in
 * qbo_to_inputs.ts, for the 1120 and 1120-S. A partnership's books are the
 * same books: what differs is the line each bucket lands on and two things a
 * partnership does not have. So this module runs on that mapper's output
 * rather than growing a third copy of its account rules.
 *
 * The two differences that matter:
 *  - A partnership has no officers. Pay booked to a partner is a guaranteed
 *    payment (Form 1065 line 10, K-1 box 4), not wages, and it must be given
 *    per partner. A corporate "officer compensation" bucket is therefore NOT
 *    carried; it is reported as a decision for the caller.
 *  - Schedule L is numbered differently (loans to partners are 7a, buildings
 *    9a/9b, intangibles 12a/12b, total assets 14, partners' capital 21 in
 *    place of the corporate equity lines 22–27, total 22).
 */

const LINE_1120_TO_1065: Record<string, string> = {
  L1_cash: 'L1_cash', L2a_trade: 'L2a_trade', L2b_baddebt: 'L2b_baddebt', L3_inv: 'L3_inv',
  L4_usgov: 'L4_usgov', L5_taxexempt: 'L5_taxexempt', L6_othercurr: 'L6_othercurr',
  L7_loans: 'L7a_loans_partners', L8_mortgage: 'L7b_mortgage', L9_otherinv: 'L8_otherinv',
  L10a_bldg: 'L9a_bldg', L10b_dep: 'L9b_dep', L11a_depletable: 'L10a_depletable', L11b_depletion: 'L10b_depletion',
  L12_land: 'L11_land', L13a_intang: 'L12a_intang', L13b_amort: 'L12b_amort', L14_other: 'L13_other',
  L15_total: 'L14_total', L16_ap: 'L15_ap', L17_mortshort: 'L16_mortshort', L18_othercurrliab: 'L17_othercurrliab',
  L19_loansfrom: 'L19a_loansfrom', L20_mortlong: 'L19b_mortlong', L21_otherliab: 'L20_otherliab', L28_total: 'L22_total',
}
/** Corporate equity lines that together are the partners' capital (line 21). */
const EQUITY = ['L22a_pref', 'L22b_common', 'L22_capstock', 'L23_paidin', 'L24_retapp', 'L25_retained', 'L26_adj']

/** Corporate input names the 1065 reads under another name, or folds into one. */
const RENAME: Record<string, string> = {
  interest_expense: 'interest',
  pension_plans: 'retirement_plans',
  interest_income: 'schedule_k_interest',
  dividends: 'schedule_k_dividends_ordinary',
  capital_gains: 'schedule_k_lt_cap_gain',
}
/** No 1065 line of their own: folded into other deductions (line 21). */
const FOLD_INTO_OTHER = ['advertising']

export interface Translated1065 {
  inputs: Record<string, number>
  warnings: Array<{ code: string; message: string; fix_hint?: string; affected_lines?: string[] }>
}

export function corporateInputsTo1065(corp: Record<string, unknown>): Translated1065 {
  const inputs: Record<string, number> = {}
  const warnings: Translated1065['warnings'] = []
  const add = (k: string, v: number) => { if (v) inputs[k] = Math.round((inputs[k] ?? 0) + v) }
  const capital: Record<string, number> = {}

  for (const [k, raw] of Object.entries(corp)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const m = /^schedL\.(L\d+[a-z]?_[a-z]+)_(boy_a|boy_b|eoy_c|eoy_d)$/.exec(k)
    if (m) {
      const [, line, col] = m
      if (EQUITY.includes(line)) { capital[col] = (capital[col] ?? 0) + raw; continue }
      if (line === 'L27_treasury') { capital[col] = (capital[col] ?? 0) - raw; continue }
      const to = LINE_1120_TO_1065[line]
      if (to) add(`schedL.${to}_${col}`, raw)
      continue
    }
    if (k.includes('.')) continue // the corporate M-1/M-2/K keys do not carry over (schedule_k_* inputs do)
    if (k === 'officer_compensation') {
      warnings.push({
        code: 'PARTNER_PAY_NOT_WAGES',
        message: `The books show ${Math.round(raw).toLocaleString('en-US')} of officer pay. A partnership has no officers: pay to a partner is a guaranteed payment (line 10, K-1 box 4), given per partner.`,
        fix_hint: 'Set partners[].guaranteed_payments_services for the partner(s) paid; pay to non-partner employees belongs in salaries_wages.',
        affected_lines: ['deductions.L10_guaranteed_payments', 'deductions.L9_salaries'],
      })
      continue
    }
    if (FOLD_INTO_OTHER.includes(k)) { add('other_deductions', raw); continue }
    add(RENAME[k] ?? k, raw)
  }
  for (const [col, v] of Object.entries(capital)) add(`schedL.L21_capital_${col}`, v)
  return { inputs, warnings }
}
