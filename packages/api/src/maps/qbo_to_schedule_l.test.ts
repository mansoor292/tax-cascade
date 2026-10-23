/**
 * The equity section has to foot, whatever the accounts are called.
 *
 * This mapper used to read equity by account name: "Partner's Equity",
 * "Retained Earnings", "Shareholder Distributions". A real company's
 * distributions account is called "Partner distributions", so $6.20M of
 * cumulative distributions matched nothing, the current year's "Net Income"
 * was never added either, and retained earnings went onto Schedule L
 * overstated by $4.97M. Lines 15 and 28 still agreed, because both come
 * straight from QuickBooks' own totals — so the balance sheet balanced in the
 * two boxes a reviewer checks and failed to foot everywhere else.
 *
 * The figures below are the Talbrook demo group's, standing in for a real 2025
 * file, with the balance sheet QuickBooks itself reports.
 */
import { describe, it, expect } from 'vitest'
import { buildScheduleL, fieldValuesForPdf } from './qbo_to_schedule_l.js'

const EOY_2025 = {
  'BankAccounts (Total)': 416_851.05,
  'OtherCurrentAssets (Total)': 1_505_342.84,
  'FixedAssets (Total)': 97_240.46,
  'TotalAssets (Total)': 2_019_434.35,
  'CreditCards (Total)': -3_993.34,        // overpaid card: a DEBIT balance
  'OtherCurrentLiabilities (Total)': 1_869_068.95,
  'Liabilities (Total)': 1_865_075.61,
  'Opening balance equity': 858.61,
  'Partner distributions': -6_200_133.57,  // named nothing this mapper knew
  'Retained Earnings': 5_122_431.88,       // prior years only
  'Net Income': 1_231_201.82,              // current year, a separate row
  'Equity (Total)': 154_358.74,
  'TotalLiabilitiesAndEquity (Total)': 2_019_434.35,
}

const EOY_2024 = {
  'BankAccounts (Total)': 214_965.72,
  'OtherCurrentAssets (Total)': 1_409_183.07,
  'FixedAssets (Total)': 96_302.78,
  'TotalAssets (Total)': 1_720_451.57,
  'CreditCards (Total)': -572.60,
  'OtherCurrentLiabilities (Total)': 1_672_786.55,
  'Liabilities (Total)': 1_672_213.95,
  'Opening balance equity': 858.61,
  'Partner distributions': -5_075_052.87,
  'Retained Earnings': 4_941_528.50,
  'Net Income': 180_903.38,
  'Equity (Total)': 48_237.62,
  'TotalLiabilitiesAndEquity (Total)': 1_720_451.57,
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
    // 5,122,431.88 + 1,231,201.82 - 6,200,133.57 = 153,500.13, within the
    // dollar of rounding that the residual deliberately absorbs.
    expect(m['schedL.L25_retained_eoy_d']).toBeCloseTo(153_500, -0.5)
    // 4,941,528.50 + 180,903.38 - 5,075,052.87 = 47,379.01
    expect(m['schedL.L25_retained_boy_b']).toBe(47_379)
    // The unadjusted account balance is what used to land here.
    expect(m['schedL.L25_retained_eoy_d']).not.toBe(5_122_431)
  })

  it('keeps an overpaid credit card as a debit rather than flipping its sign', () => {
    expect(m['schedL.L17_mortshort_eoy_d']).toBe(-3_993)
    expect(m['schedL.L17_mortshort_boy_b']).toBe(-573)
  })

  it('leaves adjustments to shareholders equity empty — distributions are not that line', () => {
    expect(m['schedL.L26_adj_eoy_d']).toBe(0)
  })

  it('still foots when the distributions account is named something else entirely', () => {
    const renamed = { ...EOY_2025 }
    delete (renamed as any)['Partner distributions']
    ;(renamed as any)['Owner draws — Adrian'] = -6_200_133.57
    const n = buildScheduleL(renamed, EOY_2024)
    expect(liabilitiesAndEquity(n, 'eoy_d')).toBe(n['schedL.L28_total_eoy_d'])
  })
})

describe('fieldValuesForPdf', () => {
  const qbo = { 'schedL.L7_loans_eoy_d': 500_000, 'schedL.L14_other_eoy_d': 1_395_967, 'schedL.L15_total_eoy_d': 1_667_557 }

  it('prints the saved Schedule L, not a fresh QBO mapping', () => {
    // A reviewed 2025 return printed L7 500,000 and L14 1,395,967 (the loan
    // counted twice) because the route spread QBO over the saved values.
    const saved = { 'tax.L31_total_tax': 28_663, 'schedL.L7_loans_eoy_d': 490_797, 'schedL.L14_other_eoy_d': 494_175 }
    const fv = fieldValuesForPdf(saved, qbo)
    expect(fv['schedL.L7_loans_eoy_d']).toBe(490_797)
    expect(fv['schedL.L14_other_eoy_d']).toBe(494_175)
    expect(fv['schedL.L15_total_eoy_d'], 'no QBO line mixed into a saved Schedule L').toBeUndefined()
  })

  it('uses QBO when the return has no Schedule L of its own', () => {
    const fv = fieldValuesForPdf({ 'tax.L31_total_tax': 1 }, qbo)
    expect(fv['schedL.L7_loans_eoy_d']).toBe(500_000)
    expect(fv['tax.L31_total_tax']).toBe(1)
  })
})
