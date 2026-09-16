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
 * Also validates Schedule L two ways: assets_total vs liabilities_equity_total
 * (the two boxes agreeing with each other), and each side's component lines
 * against their own stated total (the lines above the box agreeing with it).
 * The second check exists because the first one passes on a balance sheet
 * that visibly fails to foot — see the note above validateScheduleLComponents.
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

  validationErrors.push(...validateScheduleLComponents(inputs))

  return validationErrors
}

// ─── Schedule L: do the detail lines add up to their own total? ───
//
// Lines 15 and 28 matching each other proves nothing about the lines above
// them — both totals routinely arrive straight from the accounting system's
// own roll-up while only SOME of the component lines get mapped onto the
// form. The result is a Schedule L that balances in the two boxes a
// reviewer checks first and visibly fails to foot everywhere else.
//
// This ran silent long enough to matter: a 1120-S went out for filing whose
// equity section carried retained earnings but no offsetting distributions,
// so lines 16-27 exceeded their own line 28 by ~$3.96M while 15 == 28 to the
// dollar. Separately, a reviewer looking at a CORRECT balance sheet decided
// the total must be wrong, subtracted net fixed assets from it twice, and
// reported the result as the app's own figure — precisely because the app
// offered no footing check to appeal to. Both failures are this check.

/** Asset lines whose figure sits in the net column (b for BOY, d for EOY). */
const ASSET_NET_LINES = [
  'L1_cash', 'L3_inv', 'L4_usgov', 'L5_taxexempt', 'L6_othercurr',
  'L7_loans', 'L8_mortgage', 'L9_otherinv', 'L12_land', 'L14_other',
]

/**
 * Asset lines printed as a [gross, less-accumulated] pair. Only the net
 * carries into line 15, so the pair contributes one figure, not two.
 */
const ASSET_PAIRS: Array<[gross: string, contra: string]> = [
  ['L2a_trade', 'L2b_baddebt'],
  ['L10a_bldg', 'L10b_dep'],
  ['L11_depletable', 'L11_depletable_dep'],
  ['L13a_intang', 'L13b_amort'],
]

/** Liability + equity lines, all additive (L26 may legitimately be negative). */
const LE_NET_LINES = [
  'L16_ap', 'L17_mortshort', 'L18_othercurrliab', 'L19_loansfrom',
  'L20_mortlong', 'L21_otherliab', 'L22a_pref', 'L22b_common',
  'L23_paidin', 'L24_retapp', 'L25_retained', 'L26_adj',
]

/** Treasury stock is carried "less cost of" — it subtracts from line 28. */
const LE_CONTRA_LINES = ['L27_treasury']

/**
 * A side with only one or two lines filled is a partial balance sheet, where
 * the total legitimately exceeds what was itemized (a caller who knows the
 * total and the cash balance and nothing else). Three lines is the point at
 * which the caller is plainly attempting a complete side and a shortfall is
 * a real defect rather than an omission.
 */
const MIN_LINES_TO_CHECK = 3

function validateScheduleLComponents(inputs: Record<string, any>): ArithmeticMismatch[] {
  const out: ArithmeticMismatch[] = []

  for (const [period, netCol, grossCol] of [
    ['EOY', 'eoy_d', 'eoy_c'],
    ['BOY', 'boy_b', 'boy_a'],
  ] as const) {
    const num = (line: string, col: string): number | undefined => {
      const v = inputs[`schedL.${line}_${col}`]
      return typeof v === 'number' && isFinite(v) ? v : undefined
    }

    /** Sum one side, counting how many distinct form lines actually spoke. */
    const tally = (netLines: string[], contraLines: string[], pairs: typeof ASSET_PAIRS) => {
      let sum = 0
      let present = 0
      for (const line of netLines) {
        const v = num(line, netCol)
        if (v !== undefined) { sum += v; present++ }
      }
      for (const line of contraLines) {
        const v = num(line, netCol) ?? num(line, grossCol)
        if (v !== undefined) { sum -= v; present++ }
      }
      for (const [gross, contra] of pairs) {
        // Producers disagree about which column the net lands in, so take the
        // first of: the contra row's net column, the gross row's net column,
        // or gross minus accumulated off the gross columns.
        const net = num(contra, netCol) ?? num(gross, netCol)
        if (net !== undefined) { sum += net; present++; continue }
        const g = num(gross, grossCol)
        const c = num(contra, grossCol)
        if (g !== undefined || c !== undefined) { sum += (g ?? 0) - (c ?? 0); present++ }
      }
      return { sum: Math.round(sum * 100) / 100, present }
    }

    const sides = [
      { label: 'assets', totalLine: 'L15_total', ...tally(ASSET_NET_LINES, [], ASSET_PAIRS) },
      { label: 'liabilities + equity', totalLine: 'L28_total', ...tally(LE_NET_LINES, LE_CONTRA_LINES, []) },
    ]

    for (const side of sides) {
      const stated = num(side.totalLine, netCol)
      if (stated === undefined) continue
      if (side.present < MIN_LINES_TO_CHECK) continue
      const delta = side.sum - stated
      if (Math.abs(delta) > TOLERANCE) {
        out.push({
          field: `Schedule L ${period} ${side.label}`,
          claimed: stated,
          actual: side.sum,
          delta: Math.round(delta * 100) / 100,
          items: side.present,
        })
      }
    }
  }

  return out
}
