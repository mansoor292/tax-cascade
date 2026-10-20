/**
 * Source documents (W-2s, 1099s, 1098s, K-1s) → engine inputs.
 *
 * Moved verbatim out of services/compute_return.ts (2026-10-20) so the golden
 * view (/api/golden) shows exactly what a compute would merge from the same
 * documents: one code path, as with the books (services/books.ts). The side
 * effects are the caller's: `mergedInputs` (caller-provided values win —
 * `setIfUnset` only fills a field left undefined) and `autoMergeLog`.
 */
export interface MergeContext {
  mergedInputs: Record<string, any>
  setIfUnset: (field: string, value: number, sourceType: string, count: number, confidence?: string) => void
  autoMergeLog: Array<{ field: string; value: number; sources: string[]; confidence?: string }>
}

/** Sum a key across documents' extracted key_values (first matching key wins per doc). */
export const sumDocs = (docs: any[], ...keys: string[]): number => {
  let total = 0
  for (const d of docs) {
    const kv = d.meta?.key_values || {}
    for (const k of keys) {
      const v = parseFloat(String(kv[k] ?? '').replace(/[$,]/g, '')) || 0
      if (v) { total += v; break }  // first matching key wins per doc
    }
  }
  return Math.round(total)
}

export const SUPPORTED_DOC_TYPES = [
  'w2', 'k1',
  '1099', '1099_int', '1099_div', '1099_b', '1099_r',
  '1099_misc', '1099_nec', '1099_k', '1099_g', '1099_sa', '1099_oid',
  '1098', '1098_e',
]

export function mergeDocuments(docs: any[], form_type: string, ctx: MergeContext): void {
  const { mergedInputs, setIfUnset, autoMergeLog } = ctx
  const sum = sumDocs
  const byType = (t: string) => docs.filter(d => d.doc_type === t)
  const isIndividual = form_type === '1040'

  if (isIndividual) {
    // W-2s → wages, withholding
    const w2s = byType('w2')
    setIfUnset('wages',       sum(w2s, 'wages', 'box_1'),      'W-2', w2s.length)
    setIfUnset('withholding', sum(w2s, 'federal_tax', 'box_2'), 'W-2', w2s.length)

    // 1099-INT → interest. Generic '1099' docs contribute only via an
    // explicit 'interest' key, never 'box_1': before the classifier
    // knew 1098s, a mortgage-interest 1098 landed as generic '1099'
    // and its box 1 ($22k of mortgage interest PAID) would have been
    // summed into taxable interest INCOME.
    const int99 = byType('1099_int')
    const gen99 = byType('1099')
    setIfUnset('taxable_interest',
      sum(int99, 'interest', 'box_1') + sum(gen99, 'interest'),
      '1099-INT', int99.length + gen99.length)

    // 1098-E → student loan interest deduction
    const e1098 = byType('1098_e')
    setIfUnset('student_loan_interest',
      sum(e1098, 'student_loan_interest', 'student_loan_interest_received', 'box_1'),
      '1098-E', e1098.length)
    // 1098 (mortgage interest) is deliberately NOT auto-placed: whether
    // it belongs on Schedule A (home) or Schedule E (rental) is a human
    // decision, so it only surfaces in the log as unplaced context.
    const m1098 = byType('1098')
    const mortgageInt = sum(m1098, 'mortgage_interest', 'box_1')
    if (mortgageInt) {
      autoMergeLog.push({
        field: 'itemized_deductions',
        value: 0,
        sources: [`${m1098.length} × 1098 NOT auto-placed — $${mortgageInt.toLocaleString()} mortgage interest needs a human call (Schedule A home vs Schedule E rental)`],
      })
    }

    // 1099-DIV → dividends
    const div99 = [...byType('1099_div'), ...byType('1099')]
    setIfUnset('ordinary_dividends', sum(div99, 'ordinary_dividends', 'box_1a'), '1099-DIV', div99.length)
    setIfUnset('qualified_dividends', sum(div99, 'qualified_dividends', 'box_1b'), '1099-DIV', div99.length)

    // 1099-B → capital gains (proceeds or gain/loss aggregation is complex — punt to net)
    const b99 = byType('1099_b')
    setIfUnset('capital_gains', sum(b99, 'net_gain_loss', 'gain_loss', 'proceeds'), '1099-B', b99.length)

    // 1099-R → IRA / pension distributions
    const r99 = byType('1099_r')
    setIfUnset('ira_distributions', sum(r99.filter(d => (d.meta?.key_values?.distribution_code || '').match(/[147]/)),
                                          'gross_distribution', 'box_1'), '1099-R (IRA)', r99.length)
    setIfUnset('pensions_annuities', sum(r99.filter(d => !(d.meta?.key_values?.distribution_code || '').match(/[147]/)),
                                           'gross_distribution', 'box_1'), '1099-R (pension)', r99.length)

    // 1099-NEC → self-employment income (Schedule C)
    const nec99 = byType('1099_nec')
    setIfUnset('net_se_income', sum(nec99, 'nonemployee_comp', 'box_1'), '1099-NEC', nec99.length)

    // 1099-MISC → rents, royalties, other → schedule1_income aggregate.
    // Suppressed if caller supplied structured schedule_e: Schedule E's
    // L41 total is injected into schedule1_income downstream, so the
    // 1099-MISC rental amounts already round-trip through that path.
    const misc99 = byType('1099_misc')
    if (!mergedInputs.schedule_e) {
      const miscIncome = sum(misc99, 'rents', 'box_1') + sum(misc99, 'royalties', 'box_2')
                       + sum(misc99, 'other_income', 'box_3')
      setIfUnset('schedule1_income', miscIncome, '1099-MISC', misc99.length)
    } else if (misc99.length) {
      autoMergeLog.push({
        field: 'schedule1_income',
        value: 0,
        sources: [`${misc99.length} × 1099-MISC skipped — schedule_e provided; fold rental/royalty totals into schedule_e.rental_properties to avoid double count`],
      })
    }

    // K-1 → ordinary_income, w2_wages
    const k1s = byType('k1')
    const k1Total = sum(k1s, 'ordinary_income', 'box_1')
    const k1W2 = sum(k1s, 'w2_wages')
    if (k1Total && !mergedInputs.k1_ordinary_income) {
      mergedInputs.k1_ordinary_income = k1Total
      autoMergeLog.push({ field: 'k1_ordinary_income', value: k1Total, sources: [`${k1s.length} × K-1`] })
    }
    if (k1Total && !mergedInputs.schedule1_income) {
      mergedInputs.schedule1_income = (mergedInputs.schedule1_income || 0) + k1Total
    }
    setIfUnset('k1_w2_wages', k1W2, 'K-1', k1s.length)
  }

  // 1120/1120-S: corps that hold brokerage accounts or receive 1099s
  // (e.g. an S-Corp with a treasury/contingency account) get portfolio
  // income reported on Schedule K lines 4, 5a, 7, 8a, 10, 16a.
  if (!isIndividual) {
    const int99  = [...byType('1099_int'), ...byType('1099')]
    const div99  = [...byType('1099_div'), ...byType('1099')]
    const oid99  = byType('1099_oid')
    const b99    = byType('1099_b')

    // Portfolio interest — 1099-INT Box 1 + 1099-OID Box 1 + §1276 recharacterized AMD
    const intBox1    = sum(int99, 'box1_interest', 'interest', 'box_1')
    const oidBox1    = sum(oid99, 'box1_oid', 'oid', 'box_1')
    const amd1276    = sum(b99,   'amd_recharacterized_per_1276')
    const interestTotal = intBox1 + oidBox1 + amd1276

    if (form_type === '1120S') {
      setIfUnset('schedule_k_interest',             interestTotal,                                               '1099-INT/OID/B', int99.length + oid99.length + b99.length)
      setIfUnset('schedule_k_dividends_ordinary',   sum(div99, 'box1a_ordinary_dividends', 'ordinary_dividends'), '1099-DIV',       div99.length)
      setIfUnset('schedule_k_dividends_qualified',  sum(div99, 'box1b_qualified_dividends', 'qualified_dividends'), '1099-DIV',     div99.length)
      // Net short/long-term gain — fact provides `net_short_term_gain_loss` (can be negative)
      setIfUnset('schedule_k_st_cap_gain', sum(b99, 'net_short_term_gain_loss_short', 'net_short_term_gain_loss'), '1099-B', b99.length)
      setIfUnset('schedule_k_lt_cap_gain', sum(b99, 'net_long_term_gain_loss'),                                    '1099-B', b99.length)
    } else if (form_type === '1120') {
      setIfUnset('interest_income', interestTotal,                                                  '1099-INT/OID/B', int99.length + oid99.length + b99.length)
      setIfUnset('dividends',       sum(div99, 'box1a_ordinary_dividends', 'ordinary_dividends'),   '1099-DIV',       div99.length)
      setIfUnset('capital_gains',   sum(b99,   'net_short_term_gain_loss_short', 'net_short_term_gain_loss'), '1099-B', b99.length)
    }
  }
}
