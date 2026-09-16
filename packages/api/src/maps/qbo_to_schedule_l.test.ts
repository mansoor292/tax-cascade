/**
 * The equity section has to foot, whatever the accounts are called.
 *
 * This mapper used to read equity by account name: "Partner's Equity",
 * "Retained Earnings", "Shareholder Distributions". A real company's
 * distributions account is called "Partner distributions", so $5.25M of
 * cumulative distributions matched nothing, the current year's "Net Income"
 * was never added either, and retained earnings went onto Schedule L
 * overstated by $3.96M. Lines 15 and 28 still agreed, because both come
 * straight from QuickBooks' own totals — so the balance sheet balanced in the
 * two boxes a reviewer checks and failed to foot everywhere else.
 *
 * The figures below are a real 2025 file, with the balance sheet QuickBooks
 * itself reports.
 */
import { describe, it, expect } from 'vitest'
import { buildScheduleL } from './qbo_to_schedule_l.js'

const EOY_2025 = {
  'BankAccounts (Total)': 520_571.20,
  'OtherCurrentAssets (Total)': 1_577_531.57,
  'FixedAssets (Total)': 131_745.45,
  'TotalAssets (Total)': 2_229_848.22,
  'CreditCards (Total)': -4_006.33,        // overpaid card: a DEBIT balance
  'OtherCurrentLiabilities (Total)': 1_809_277.84,
  'Liabilities (Total)': 1_805_271.51,
  'Opening balance equity': 858.61,
  'Partner distributions': -5_250_580.43,  // named nothing this mapper knew
  'Retained Earnings': 4_376_223.28,       // prior years only
  'Net Income': 1_298_075.25,              // current year, a separate row
  'Equity (Total)': 424_576.71,
  'TotalLiabilitiesAndEquity (Total)': 2_229_848.22,
}

const EOY_2024 = {
  'BankAccounts (Total)': 292_999.32,
  'OtherCurrentAssets (Total)': 1_439_575.06,
  'FixedAssets (Total)': 130_933.72,
  'TotalAssets (Total)': 1_863_508.10,
  'CreditCards (Total)': -572.60,
  'OtherCurrentLiabilities (Total)': 1_780_569.84,
  'Liabilities (Total)': 1_779_997.24,
  'Opening balance equity': 858.61,
  'Partner distributions': -4_293_571.03,
  'Retained Earnings': 4_130_989.78,
  'Net Income': 245_233.50,
  'Equity (Total)': 83_510.86,
  'TotalLiabilitiesAndEquity (Total)': 1_863_508.10,
}

/** Sum the liabilities-and-equity lines the way the form does. */
function liabilitiesAndEquity(m: Record<string, number>, col: 'boy_b' | 'eoy_d'): number {
  const lines = [
    'L16_ap', 'L17_mortshort', 'L18_othercurrliab', 'L20_mortlong',
    'L23_paidin', 'L25_retained', 'L26_adj',
  ]
  return lines.reduce((t, l) => t + (m[`schedL.${l}_${col}`] ?? 0), 0)
}

describe('buildScheduleL — equity', () => {
  const m = buildScheduleL(EOY_2025, EOY_2024)

  it('foots at the end of the year', () => {
    expect(liabilitiesAndEquity(m, 'eoy_d')).toBe(m['schedL.L28_total_eoy_d'])
  })

  it('foots at the beginning of the year', () => {
    expect(liabilitiesAndEquity(m, 'boy_b')).toBe(m['schedL.L28_total_boy_b'])
  })

  it('carries retained earnings net of distributions, not the gross account balance', () => {
    // 4,376,223.28 + 1,298,075.25 - 5,250,580.43 = 423,718.10, within the
    // dollar of rounding that the residual deliberately absorbs.
    expect(m['schedL.L25_retained_eoy_d']).toBeCloseTo(423_718, -0.5)
    expect(m['schedL.L25_retained_boy_b']).toBe(82_652)
    // The unadjusted account balance is what used to land here.
    expect(m['schedL.L25_retained_eoy_d']).not.toBe(4_376_223)
  })

  it('keeps an overpaid credit card as a debit rather than flipping its sign', () => {
    expect(m['schedL.L17_mortshort_eoy_d']).toBe(-4_006)
    expect(m['schedL.L17_mortshort_boy_b']).toBe(-573)
  })

  it('leaves adjustments to shareholders equity empty — distributions are not that line', () => {
    expect(m['schedL.L26_adj_eoy_d']).toBe(0)
  })

  it('still foots when the distributions account is named something else entirely', () => {
    const renamed = { ...EOY_2025 }
    delete (renamed as any)['Partner distributions']
    ;(renamed as any)['Owner draws — Mansoor'] = -5_250_580.43
    const n = buildScheduleL(renamed, EOY_2024)
    expect(liabilitiesAndEquity(n, 'eoy_d')).toBe(n['schedL.L28_total_eoy_d'])
  })
})
