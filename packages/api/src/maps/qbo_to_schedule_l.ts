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

  // L2a: Trade notes & accounts receivable — GROSS goes in cols a/c (white).
  // Cols b/d on the 2a row are shaded/gray (net is shown on 2b row b/d
  // as gross - allowance). Don't write to 2a b/d.
  model['schedL.L2a_trade_boy_a'] = abs(g(boy, 'AR (Total)'))
  model['schedL.L2a_trade_eoy_c'] = abs(g(eoy, 'AR (Total)'))

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
  const _boyGoodwillGross = abs(g(boy, 'Accumulated Amortization of Goodwill')) + abs(g(boy, 'Amortization'))
  const _eoyGoodwillGross = abs(g(eoy, 'Accumulated Amortization of Goodwill')) + abs(g(eoy, 'Amortization'))
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

  // L17: Mortgages/notes payable < 1 year — credit cards + other short-term.
  // NOT abs(): a credit card that has been overpaid carries a debit balance,
  // and taking its absolute value turns a $4,006 asset into a $4,006
  // liability, moving the balance sheet by twice the amount. Keep the sign
  // the books give it.
  model['schedL.L17_mortshort_boy_b'] = g(boy, 'CreditCards (Total)')
  model['schedL.L17_mortshort_eoy_d'] = g(eoy, 'CreditCards (Total)')

  // L18: Other current liabilities
  model['schedL.L18_othercurrliab_boy_b'] = abs(g(boy, 'OtherCurrentLiabilities (Total)'))
  model['schedL.L18_othercurrliab_eoy_d'] = abs(g(eoy, 'OtherCurrentLiabilities (Total)'))

  // L20: Mortgages/notes payable > 1 year
  model['schedL.L20_mortlong_boy_b'] = abs(g(boy, 'LongTermLiabilities (Total)'))
  model['schedL.L20_mortlong_eoy_d'] = abs(g(eoy, 'LongTermLiabilities (Total)'))

  // ── Equity ──
  //
  // Reading named accounts here was the bug that mattered most. QBO spreads
  // equity across a contributed-capital account, "Retained Earnings" (prior
  // years only), the current year's "Net Income", and a distributions contra
  // account whose name is whatever the bookkeeper chose. This mapper looked
  // for "Shareholder Distributions"; one company's account is called "Partner
  // distributions", so $5.25M of cumulative distributions and $1.3M of
  // current-year income both went missing. Retained earnings was then
  // overstated by $3.96M — and because lines 15 and 28 were taken from QBO's
  // own totals, the two boxes still agreed and nothing looked wrong.
  //
  // So take contributed capital by name, and derive retained earnings as the
  // remainder of QBO's own equity roll-up. The section then foots whatever
  // the accounts are called, because Equity (Total) already reflects all of
  // them — including any this mapper has never heard of.
  const paidIn = (items: Record<string, number>) =>
    g(items, 'Opening balance equity') + g(items, "Partner's Equity")
    + g(items, 'Capital stock') + g(items, 'Common stock')

  model['schedL.L23_paidin_boy_b'] = paidIn(boy)
  model['schedL.L23_paidin_eoy_d'] = paidIn(eoy)

  // L26: Adjustments to shareholders' equity. Distributions do NOT belong
  // here — on an S corporation they reduce retained earnings. This line stays
  // empty unless something genuinely belongs on it.
  model['schedL.L26_adj_boy_b'] = 0
  model['schedL.L26_adj_eoy_d'] = 0

  // L28: Total liabilities + equity
  model['schedL.L28_total_boy_b'] = g(boy, 'TotalLiabilitiesAndEquity (Total)')
  model['schedL.L28_total_eoy_d'] = g(eoy, 'TotalLiabilitiesAndEquity (Total)')

  // L25: Retained earnings — everything in equity that is not contributed
  // capital, taken as the residual so the section foots to the dollar.
  //
  // Deriving it as Equity(Total) - paidIn is the same figure but leaves each
  // line rounded independently, which puts the column out by a dollar often
  // enough to matter on a form that must add up. Any rounding difference
  // belongs in retained earnings, so put it there deliberately.
  for (const [col, items] of [['boy_b', boy], ['eoy_d', eoy]] as const) {
    const others = ['L16_ap', 'L17_mortshort', 'L18_othercurrliab', 'L20_mortlong', 'L23_paidin', 'L26_adj']
      .reduce((t, l) => t + (model[`schedL.${l}_${col}`] ?? 0), 0)
    void items
    model[`schedL.L25_retained_${col}`] = model[`schedL.L28_total_${col}`] - others
  }

  return model
}
