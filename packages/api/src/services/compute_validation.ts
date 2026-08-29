/**
 * Arithmetic validation for compute inputs — pure, no I/O.
 *
 * When a caller passes both `<bucket>_detail: [{label, amount}]` and the
 * scalar `<bucket>` (e.g. other_deductions_detail + other_deductions),
 * reject with a loud diagnostic if the sum of detail items doesn't match
 * the scalar. Prevents the class of silent failures where the LLM manually
 * totaled a line-item list and got it wrong (e.g. $38,994 claimed vs
 * $69,008 actual, producing phantom profit).
 *
 * Also validates Schedule L balance: assets_total vs liabilities_equity_total.
 */

export interface ArithmeticMismatch {
  field: string
  claimed: number
  actual: number
  delta: number
  items?: number
}

const TOLERANCE = 1 // $1 rounding allowance

export function validateInputArithmetic(inputs: Record<string, any>): ArithmeticMismatch[] {
  const validationErrors: ArithmeticMismatch[] = []

  for (const [key, value] of Object.entries(inputs)) {
    if (!key.endsWith('_detail')) continue
    if (!Array.isArray(value)) continue
    const scalarKey = key.slice(0, -'_detail'.length)
    const scalar = inputs[scalarKey]
    if (typeof scalar !== 'number') continue // no scalar to validate against
    let sum = 0
    for (const item of value) {
      const amt = parseFloat(String(item?.amount ?? item?.value ?? '0'))
      if (!isNaN(amt)) sum += amt
    }
    const delta = sum - scalar
    if (Math.abs(delta) > TOLERANCE) {
      validationErrors.push({
        field: scalarKey,
        claimed: scalar,
        actual: Math.round(sum * 100) / 100,
        delta: Math.round(delta * 100) / 100,
        items: value.length,
      })
    }
  }

  // Schedule L balance check: assets side vs L&E side.
  // The two totals are rolled up on lines 15 and 28 on 1120/1120S
  // Schedule L. Canonical keys: schedL.L15_total_eoy_d (assets) and
  // schedL.L28_total_eoy_d (L&E). Same for BOY (_boy_b).
  const schedLPairs: Array<['boy' | 'eoy', string, string]> = [
    ['eoy', 'schedL.L15_total_eoy_d', 'schedL.L28_total_eoy_d'],
    ['boy', 'schedL.L15_total_boy_b', 'schedL.L28_total_boy_b'],
  ]
  for (const [period, assetsKey, liabEquityKey] of schedLPairs) {
    const a = inputs[assetsKey]
    const l = inputs[liabEquityKey]
    if (typeof a === 'number' && typeof l === 'number' && Math.abs(a - l) > TOLERANCE) {
      validationErrors.push({
        field: `Schedule L ${period.toUpperCase()}`,
        claimed: a,
        actual: l,
        delta: a - l,
      })
    }
  }

  return validationErrors
}
