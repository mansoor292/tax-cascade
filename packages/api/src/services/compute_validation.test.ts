import { describe, it, expect } from 'vitest'
import { validateInputArithmetic } from './compute_validation.js'

describe('validateInputArithmetic', () => {
  it('passes when detail sums to scalar within $1', () => {
    expect(validateInputArithmetic({
      other_deductions: 100,
      other_deductions_detail: [{ label: 'a', amount: 60 }, { label: 'b', amount: 40.5 }],
    })).toEqual([])
  })

  it('flags a detail sum that misses the scalar', () => {
    const errs = validateInputArithmetic({
      other_deductions: 34092,
      other_deductions_detail: [{ label: 'rent', amount: 30000 }, { label: 'fees', amount: 34098 - 30000 + 30000 }],
    })
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('other_deductions')
    expect(errs[0].claimed).toBe(34092)
  })

  it('reads amount from `value` as a fallback and parses numeric strings', () => {
    expect(validateInputArithmetic({
      travel: 150,
      travel_detail: [{ value: '100' }, { amount: '50' }],
    })).toEqual([])
    // A '$'-prefixed amount does NOT parse (parseFloat('$50') is NaN) and is
    // skipped — documenting the current behavior, not endorsing it.
    const errs = validateInputArithmetic({
      travel: 150,
      travel_detail: [{ value: '100' }, { amount: '$50' }],
    })
    expect(errs).toHaveLength(1)
  })

  it('skips buckets with no scalar to validate against', () => {
    expect(validateInputArithmetic({
      misc_detail: [{ amount: 999 }],
    })).toEqual([])
  })

  it('flags an unbalanced Schedule L on both periods', () => {
    const errs = validateInputArithmetic({
      'schedL.L15_total_eoy_d': 500_000,
      'schedL.L28_total_eoy_d': 400_000,
      'schedL.L15_total_boy_b': 100,
      'schedL.L28_total_boy_b': 100.5, // within tolerance
    })
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('Schedule L EOY')
    expect(errs[0].delta).toBe(100_000)
  })
})

describe('validateInputArithmetic — Schedule L components foot to their own total', () => {
  /**
   * A TY2025 1120-S (the Talbrook demo group's figures, standing in for the
   * real return's). Both periods foot exactly on the asset side, and a
   * reviewer nonetheless reported total assets as 1,894,247 / 1,508,215 —
   * which is this balance sheet with the NET fixed-asset line (already net of
   * accumulated depreciation) subtracted a second time. These numbers must
   * stay silent; the day they flag, the check is wrong, not the return.
   */
  const realAssetSide = {
    'schedL.L1_cash_boy_b': 214_965,
    'schedL.L1_cash_eoy_d': 425_714,
    'schedL.L6_othercurr_boy_b': 1_388_526,
    'schedL.L6_othercurr_eoy_d': 1_564_348,
    'schedL.L10b_dep_boy_b': 95_276,
    'schedL.L10b_dep_eoy_d': 95_815,
    'schedL.L15_total_boy_b': 1_698_767,   // 214,965 + 1,388,526 + 95,276
    'schedL.L15_total_eoy_d': 2_085_877,   // 425,714 + 1,564,348 + 95,815
  }

  it('stays silent on an asset side that foots exactly', () => {
    expect(validateInputArithmetic(realAssetSide)).toEqual([])
  })

  it('would flag the double-subtracted total a reviewer reported instead', () => {
    const errs = validateInputArithmetic({
      ...realAssetSide,
      'schedL.L15_total_eoy_d': 1_894_247,   // 2,085,877 − 95,815 − 95,815
      'schedL.L15_total_boy_b': 1_508_215,   // 1,698,767 − 95,276 − 95,276
    })
    expect(errs.map(e => e.field)).toEqual([
      'Schedule L EOY assets', 'Schedule L BOY assets',
    ])
    expect(errs[0].delta).toBe(191_630)   // exactly twice the net fixed assets
    expect(errs[1].delta).toBe(190_552)
  })

  it('catches the equity section that balances on line 28 but does not foot', () => {
    // Retained earnings carried with no offsetting distributions: 15 == 28 to
    // the dollar while lines 16-27 overshoot line 28 by $5.06M.
    const errs = validateInputArithmetic({
      ...realAssetSide,
      'schedL.L17_mortshort_eoy_d': 3_993,
      'schedL.L18_othercurrliab_eoy_d': 1_869_069,
      'schedL.L25_retained_eoy_d': 5_272_287,
      'schedL.L28_total_eoy_d': 2_085_877,
    })
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('Schedule L EOY liabilities + equity')
    expect(errs[0].delta).toBe(5_059_472)   // 3,993 + 1,869,069 + 5,272,287 − 2,085,877
  })

  it('leaves a partial balance sheet alone — fewer than three lines is not a claim', () => {
    expect(validateInputArithmetic({
      'schedL.L1_cash_eoy_d': 425_714,
      'schedL.L6_othercurr_eoy_d': 1_564_348,
      'schedL.L15_total_eoy_d': 2_085_877,   // 95,815 of fixed assets not itemized
    })).toEqual([])
  })

  it('reads a gross/less-accumulated pair off the gross columns too', () => {
    // Same fixed assets, expressed as cost less accumulated depreciation
    // rather than as a net figure: 400,000 − 304,185 = 95,815.
    expect(validateInputArithmetic({
      'schedL.L1_cash_eoy_d': 425_714,
      'schedL.L6_othercurr_eoy_d': 1_564_348,
      'schedL.L10a_bldg_eoy_c': 400_000,
      'schedL.L10b_dep_eoy_c': 304_185,
      'schedL.L15_total_eoy_d': 2_085_877,
    })).toEqual([])
  })

  it('subtracts treasury stock rather than adding it', () => {
    const base = {
      'schedL.L16_ap_eoy_d': 100_000,
      'schedL.L22b_common_eoy_d': 50_000,
      'schedL.L25_retained_eoy_d': 900_000,
      'schedL.L27_treasury_eoy_d': 50_000,
    }
    expect(validateInputArithmetic({ ...base, 'schedL.L28_total_eoy_d': 1_000_000 })).toEqual([])
    expect(validateInputArithmetic({ ...base, 'schedL.L28_total_eoy_d': 1_100_000 })).toHaveLength(1)
  })
})
