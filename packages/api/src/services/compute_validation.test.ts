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
