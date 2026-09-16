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
      other_deductions: 38994,
      other_deductions_detail: [{ label: 'rent', amount: 30000 }, { label: 'fees', amount: 39008 - 30000 + 30000 }],
    })
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('other_deductions')
    expect(errs[0].claimed).toBe(38994)
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
   * A real TY2025 1120-S. Both periods foot exactly on the asset side, and a
   * reviewer nonetheless reported total assets as 1,966,358 / 1,601,640 —
   * which is this balance sheet with the NET fixed-asset line (already net of
   * accumulated depreciation) subtracted a second time. These numbers must
   * stay silent; the day they flag, the check is wrong, not the return.
   */
  const realAssetSide = {
    'schedL.L1_cash_boy_b': 292_999,
    'schedL.L1_cash_eoy_d': 520_571,
    'schedL.L6_othercurr_boy_b': 1_439_575,
    'schedL.L6_othercurr_eoy_d': 1_577_532,
    'schedL.L10b_dep_boy_b': 130_934,
    'schedL.L10b_dep_eoy_d': 131_745,
    'schedL.L15_total_boy_b': 1_863_508,
    'schedL.L15_total_eoy_d': 2_229_848,
  }

  it('stays silent on an asset side that foots exactly', () => {
    expect(validateInputArithmetic(realAssetSide)).toEqual([])
  })

  it('would flag the double-subtracted total a reviewer reported instead', () => {
    const errs = validateInputArithmetic({
      ...realAssetSide,
      'schedL.L15_total_eoy_d': 1_966_358,   // 2,229,848 − 131,745 − 131,745
      'schedL.L15_total_boy_b': 1_601_640,   // 1,863,508 − 130,934 − 130,934
    })
    expect(errs.map(e => e.field)).toEqual([
      'Schedule L EOY assets', 'Schedule L BOY assets',
    ])
    expect(errs[0].delta).toBe(263_490)   // exactly twice the net fixed assets
    expect(errs[1].delta).toBe(261_868)
  })

  it('catches the equity section that balances on line 28 but does not foot', () => {
    // Retained earnings carried with no offsetting distributions: 15 == 28 to
    // the dollar while lines 16-27 overshoot line 28 by $3.96M.
    const errs = validateInputArithmetic({
      ...realAssetSide,
      'schedL.L17_mortshort_eoy_d': 4_006,
      'schedL.L18_othercurrliab_eoy_d': 1_809_278,
      'schedL.L25_retained_eoy_d': 4_376_223,
      'schedL.L28_total_eoy_d': 2_229_848,
    })
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('Schedule L EOY liabilities + equity')
    expect(errs[0].delta).toBe(3_959_659)
  })

  it('leaves a partial balance sheet alone — fewer than three lines is not a claim', () => {
    expect(validateInputArithmetic({
      'schedL.L1_cash_eoy_d': 520_571,
      'schedL.L6_othercurr_eoy_d': 1_577_532,
      'schedL.L15_total_eoy_d': 2_229_848,   // 131,745 of fixed assets not itemized
    })).toEqual([])
  })

  it('reads a gross/less-accumulated pair off the gross columns too', () => {
    // Same fixed assets, expressed as cost less accumulated depreciation
    // rather than as a net figure: 400,000 − 268,255 = 131,745.
    expect(validateInputArithmetic({
      'schedL.L1_cash_eoy_d': 520_571,
      'schedL.L6_othercurr_eoy_d': 1_577_532,
      'schedL.L10a_bldg_eoy_c': 400_000,
      'schedL.L10b_dep_eoy_c': 268_255,
      'schedL.L15_total_eoy_d': 2_229_848,
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
