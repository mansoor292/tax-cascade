/**
 * QBO Balance Sheet → IRS Schedule L mapping
 *
 * Maps QBO account categories to Schedule L line items.
 * BOY = prior year EOY balance sheet, EOY = current year.
 *
 * QBO categories use the flat keys from the /financials endpoint
 * (e.g. "BankAccounts (Total)", "CurrentAssets (Total)").
 */

export interface ScheduleLData {
  [key: string]: number  // canonical Schedule L keys → values
}

/**
 * Build Schedule L canonical model from QBO balance sheet data.
 *
 * @param eoyBs - Current year-end balance sheet items (from /financials)
 * @param boyBs - Prior year-end balance sheet items (= BOY)
 */
export function buildScheduleL(
  eoyBs: Record<string, number>,
  boyBs?: Record<string, number>,
): ScheduleLData {
  const model: ScheduleLData = {}
  const boy = boyBs || {}
  const eoy = eoyBs

  const g = (items: Record<string, number>, key: string): number => {
    return Math.round(items[key] || 0)
  }
  const abs = (n: number) => Math.abs(n)

  // L1: Cash (bank accounts total)
  model['schedL.L1_cash_boy_b'] = abs(g(boy, 'BankAccounts (Total)'))
  model['schedL.L1_cash_eoy_d'] = abs(g(eoy, 'BankAccounts (Total)'))

  // L2a: Trade notes & accounts receivable
  model['schedL.L2a_trade_boy_b'] = abs(g(boy, 'AR (Total)'))
  model['schedL.L2a_trade_eoy_d'] = abs(g(eoy, 'AR (Total)'))

  // L6: Other current assets
  model['schedL.L6_othercurr_boy_b'] = abs(g(boy, 'OtherCurrentAssets (Total)'))
  model['schedL.L6_othercurr_eoy_d'] = abs(g(eoy, 'OtherCurrentAssets (Total)'))

  // L7: Loans to shareholders
  model['schedL.L7_loans_boy_b'] = abs(g(boy, 'Mansoor Loan'))
  model['schedL.L7_loans_eoy_d'] = abs(g(eoy, 'Mansoor Loan'))

  // L10a: Buildings and other depreciable assets (gross)
  model['schedL.L10a_bldg_boy_a'] = abs(g(boy, 'Original cost'))
  model['schedL.L10a_bldg_eoy_c'] = abs(g(eoy, 'Original cost'))

  // L10b: Accumulated depreciation
  model['schedL.L10b_dep_boy_a'] = abs(g(boy, 'Depreciation'))
  model['schedL.L10b_dep_boy_b'] = abs(g(boy, 'FixedAssets (Total)'))
  model['schedL.L10b_dep_eoy_c'] = abs(g(eoy, 'Depreciation'))
  model['schedL.L10b_dep_eoy_d'] = abs(g(eoy, 'FixedAssets (Total)'))

  // L13a: Intangible assets (gross) — goodwill
  // QBO doesn't separate gross vs accumulated cleanly, but we have:
  // "Accumulated Amortization of Goodwill" and "Amortization"
  const boyGoodwillGross = abs(g(boy, 'Accumulated Amortization of Goodwill')) + abs(g(boy, 'Amortization'))
  const eoyGoodwillGross = abs(g(eoy, 'Accumulated Amortization of Goodwill')) + abs(g(eoy, 'Amortization'))
  // Actually, the OtherAssets total includes intangibles
  // Use OtherAssets minus loans for a rough intangible figure

  // L13b: Accumulated amortization
  model['schedL.L13b_amort_boy_a'] = abs(g(boy, 'Accumulated Amortization of Goodwill'))
  model['schedL.L13b_amort_eoy_c'] = abs(g(eoy, 'Accumulated Amortization of Goodwill'))

  // L14: Other assets (federal tax, purchase loan fees, etc.)
  model['schedL.L14_other_boy_b'] = abs(g(boy, 'OtherAssets (Total)'))
  model['schedL.L14_other_eoy_d'] = abs(g(eoy, 'OtherAssets (Total)'))

  // L15: Total assets
  model['schedL.L15_total_boy_b'] = abs(g(boy, 'TotalAssets (Total)'))
  model['schedL.L15_total_eoy_d'] = abs(g(eoy, 'TotalAssets (Total)'))

  // L16: Accounts payable
  model['schedL.L16_ap_boy_b'] = abs(g(boy, 'AP (Total)'))
  model['schedL.L16_ap_eoy_d'] = abs(g(eoy, 'AP (Total)'))

  // L17: Mortgages/notes payable < 1 year (current liabilities minus AP minus other)
  // Use credit cards + other short-term
  model['schedL.L17_mortshort_boy_b'] = abs(g(boy, 'CreditCards (Total)'))
  model['schedL.L17_mortshort_eoy_d'] = abs(g(eoy, 'CreditCards (Total)'))

  // L18: Other current liabilities
  model['schedL.L18_othercurrliab_boy_b'] = abs(g(boy, 'OtherCurrentLiabilities (Total)'))
  model['schedL.L18_othercurrliab_eoy_d'] = abs(g(eoy, 'OtherCurrentLiabilities (Total)'))

  // L20: Mortgages/notes payable > 1 year
  model['schedL.L20_mortlong_boy_b'] = abs(g(boy, 'LongTermLiabilities (Total)'))
  model['schedL.L20_mortlong_eoy_d'] = abs(g(eoy, 'LongTermLiabilities (Total)'))

  // L23: Additional paid-in capital (Partner's Equity in QBO)
  model['schedL.L23_paidin_boy_b'] = abs(g(boy, "Partner's Equity"))
  model['schedL.L23_paidin_eoy_d'] = abs(g(eoy, "Partner's Equity"))

  // L25: Retained earnings — unappropriated
  model['schedL.L25_retained_boy_b'] = abs(g(boy, 'Retained Earnings'))
  model['schedL.L25_retained_eoy_d'] = abs(g(eoy, 'Retained Earnings'))

  // L27: Shareholder distributions (adjustment to equity)
  model['schedL.L26_adj_boy_b'] = abs(g(boy, 'Shareholder Distributions'))
  model['schedL.L26_adj_eoy_d'] = abs(g(eoy, 'Shareholder Distributions'))

  // L28: Total liabilities + equity
  model['schedL.L28_total_boy_b'] = abs(g(boy, 'TotalLiabilitiesAndEquity (Total)'))
  model['schedL.L28_total_eoy_d'] = abs(g(eoy, 'TotalLiabilitiesAndEquity (Total)'))

  return model
}
