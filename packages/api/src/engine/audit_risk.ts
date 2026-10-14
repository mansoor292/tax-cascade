/**
 * Audit-risk rater — a transparent stand-in for the IRS's DIF score.
 *
 * The IRS scores every return with its Discriminant Function System and keeps
 * the formula secret. What is public is what it reacts to: expense ratios far
 * from an industry's norm, categories it knows are abused (meals, travel and
 * vehicles, advertising, an unexplained "other"), returns that do not
 * reconcile with themselves, and — for owner-run companies — the specific
 * patterns its examiners are told to look for (no officer pay beside large S
 * corporation distributions, loans to shareholders, large year-over-year
 * swings).
 *
 * This is NOT the DIF and must never be presented as one. It is a rule list:
 * every flag names the rule, the figure it measured, the threshold it used
 * and the lines it read, so a preparer can see why a return looks unusual and
 * decide whether the documentation is there. The benchmarks are heuristics
 * drawn from published practitioner guidance, not IRS norms; a legitimate
 * ordinary-and-necessary expense is deductible whatever its ratio, and the
 * rater says so.
 *
 * Two kinds of check:
 *  - ratio   — "looks unusual"; documentation answers it.
 *  - integrity — the return disagrees with itself (a balance sheet that does
 *    not foot, M-1 that does not reach taxable income). These are what the
 *    IRS's automated math and matching programs catch regardless of any
 *    score, and they are always worth fixing before filing.
 */

export type Severity = 'high' | 'medium' | 'low'

export interface RiskFlag {
  code: string
  kind: 'ratio' | 'integrity' | 'pattern' | 'change'
  severity: Severity
  title: string
  /** The measured figure — a ratio as 0..1, or an amount. */
  value: number
  /** The threshold it was compared against, same unit as value. */
  threshold?: number
  /** Canonical keys (or input detail buckets) the rule read. */
  lines: string[]
  explanation: string
}

export interface RiskReport {
  form_type: string
  tax_year?: number
  score: number              // 0-100, sum of flag weights, capped
  band: 'low' | 'elevated' | 'high'
  metrics: Record<string, number>
  flags: RiskFlag[]
  disclaimer: string
}

export interface RiskContext {
  /** The prior year's field_values (filed return preferred), for change rules. */
  prior?: Record<string, any> | null
  /** The return's input_data — detail arrays itemize "other" lines. */
  inputs?: Record<string, any> | null
  /** NAICS code, used only to soften advertising norms for retail/e-commerce. */
  business_code?: string
}

const WEIGHT: Record<Severity, number> = { high: 25, medium: 12, low: 5 }

const DISCLAIMER =
  'Heuristic audit-risk screen. The IRS DIF formula is confidential; these rules and thresholds are ' +
  'practitioner benchmarks, not IRS norms. A flag means "document this", not "do not deduct it": an ' +
  'ordinary and necessary expense is deductible whatever its ratio.'

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(n) ? n : 0
}
/** First present key wins — engine and extractor spell some lines differently. */
const pick = (fv: Record<string, any>, ...keys: string[]): number => {
  for (const k of keys) if (fv[k] !== undefined && fv[k] !== null && fv[k] !== '') return num(fv[k])
  return 0
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`

/** Sum of an input detail array's items whose label matches. */
function detailSum(inputs: Record<string, any> | null | undefined, bucket: string, re: RegExp): number {
  const arr = inputs?.[`${bucket}_detail`]
  if (!Array.isArray(arr)) return 0
  return arr.reduce((t: number, it: any) => {
    const label = String(it?.label ?? it?.description ?? it?.name ?? '')
    return re.test(label) ? t + num(it?.amount ?? it?.value) : t
  }, 0)
}

const MEALS_RE = /meal|entertain|dining/i
const TRAVEL_RE = /travel|auto|vehicle|car\b|mileage|fuel|gas\b|parking|toll|airfare|hotel|lodging|rides?\b|uber|lyft/i

// ─── Form-specific line readers ────────────────────────────────────────────

interface BusinessLines {
  receipts: number
  cogs: number
  totalDeductions: number
  otherDeductions: number
  advertising: number
  officerComp: number
  salaries: number
  charitable: number
  lineKeys: { receipts: string; total: string; other: string; advertising: string; officer: string }
}

function read1120(fv: Record<string, any>): BusinessLines {
  return {
    receipts: pick(fv, 'income.L1c_balance', 'income.L1a_gross_receipts'),
    cogs: pick(fv, 'income.L2_cogs'),
    totalDeductions: pick(fv, 'deductions.L27_total_deductions', 'deductions.L27_total') + pick(fv, 'income.L2_cogs'),
    otherDeductions: pick(fv, 'deductions.L26_other_deductions', 'deductions.L26_other'),
    advertising: pick(fv, 'deductions.L22_advertising'),
    officerComp: pick(fv, 'deductions.L12_officer_comp'),
    salaries: pick(fv, 'deductions.L13_salaries'),
    charitable: pick(fv, 'deductions.L19_charitable'),
    lineKeys: { receipts: 'income.L1c_balance', total: 'deductions.L27_total_deductions', other: 'deductions.L26_other_deductions', advertising: 'deductions.L22_advertising', officer: 'deductions.L12_officer_comp' },
  }
}

function read1120S(fv: Record<string, any>): BusinessLines {
  return {
    receipts: pick(fv, 'income.L1c_balance', 'income.L1a_gross_receipts'),
    cogs: pick(fv, 'income.L2_cogs'),
    totalDeductions: pick(fv, 'deductions.L21_total') + pick(fv, 'income.L2_cogs'),
    otherDeductions: pick(fv, 'deductions.L20_other'),
    advertising: pick(fv, 'deductions.L16_advertising'),
    officerComp: pick(fv, 'deductions.L7_officer_comp'),
    salaries: pick(fv, 'deductions.L8_salaries'),
    charitable: pick(fv, 'schedK.L12a_charitable', 'schedK.L12a_cash_charity'),
    lineKeys: { receipts: 'income.L1c_balance', total: 'deductions.L21_total', other: 'deductions.L20_other', advertising: 'deductions.L16_advertising', officer: 'deductions.L7_officer_comp' },
  }
}

// ─── Shared business-return rules ──────────────────────────────────────────

function businessRatioFlags(b: BusinessLines, ctx: RiskContext, otherBucket: string, flags: RiskFlag[], metrics: Record<string, number>) {
  const { receipts } = b
  if (receipts <= 0) return
  const inputs = ctx.inputs

  // 1. Overall expense ratio (COGS + deductions over receipts).
  const expenseRatio = b.totalDeductions / receipts
  metrics.expense_ratio = expenseRatio
  if (expenseRatio > 0.80) {
    flags.push({
      code: 'EXPENSE_RATIO', kind: 'ratio', severity: expenseRatio > 0.95 ? 'high' : 'medium',
      title: 'Expenses are a very high share of receipts',
      value: expenseRatio, threshold: 0.80, lines: [b.lineKeys.total, 'income.L2_cogs', b.lineKeys.receipts],
      explanation: `Cost of goods sold plus deductions are ${pct(expenseRatio)} of receipts (${usd(b.totalDeductions)} of ${usd(receipts)}). Above 75–80% a mature business draws attention; keep support for the largest categories.`,
    })
  }

  // 2. Meals — from the itemization, since every form buries them in "other".
  const meals = detailSum(inputs, otherBucket, MEALS_RE)
  metrics.meals_ratio = meals / receipts
  if (meals / receipts > 0.02) {
    flags.push({
      code: 'MEALS', kind: 'ratio', severity: meals / receipts > 0.05 ? 'high' : 'medium',
      title: 'Meals are high relative to receipts',
      value: meals / receipts, threshold: 0.02, lines: [`${otherBucket}_detail`],
      explanation: `Meals/entertainment of ${usd(meals)} are ${pct(meals / receipts)} of receipts (typical 0.5–2%). Keep who/where/business purpose for each; only 50% of meals is deductible and entertainment none.`,
    })
  }

  // 3. Travel and vehicles.
  const travel = detailSum(inputs, otherBucket, TRAVEL_RE)
  metrics.travel_ratio = travel / receipts
  if (travel / receipts > 0.08) {
    flags.push({
      code: 'TRAVEL_AUTO', kind: 'ratio', severity: travel / receipts > 0.15 ? 'high' : 'medium',
      title: 'Travel and vehicle costs are high relative to receipts',
      value: travel / receipts, threshold: 0.08, lines: [`${otherBucket}_detail`],
      explanation: `Travel/vehicle items total ${usd(travel)}, ${pct(travel / receipts)} of receipts (typical 2–8%). Keep mileage logs and trip purposes; 100% business use of a vehicle is a known red flag.`,
    })
  }

  // 4. Advertising — retail/e-commerce (NAICS 44–45) runs higher by nature.
  const adRatio = b.advertising / receipts
  metrics.advertising_ratio = adRatio
  const retail = /^4[45]/.test(ctx.business_code || '')
  const adLimit = retail ? 0.20 : 0.10
  if (adRatio > adLimit) {
    flags.push({
      code: 'ADVERTISING', kind: 'ratio', severity: adRatio > adLimit + 0.05 ? 'high' : 'medium',
      title: 'Advertising is high relative to receipts',
      value: adRatio, threshold: adLimit, lines: [b.lineKeys.advertising, b.lineKeys.receipts],
      explanation: `Advertising of ${usd(b.advertising)} is ${pct(adRatio)} of receipts (service businesses typically 2–7%). Keep invoices and campaign records.`,
    })
  }

  // 5. "Other" deductions — share of total deductions, and whether itemized.
  const deductionsOnly = b.totalDeductions - b.cogs
  const otherShare = deductionsOnly > 0 ? b.otherDeductions / deductionsOnly : 0
  metrics.other_share = otherShare
  if (otherShare > 0.10) {
    const itemized = Array.isArray(inputs?.[`${otherBucket}_detail`]) && inputs![`${otherBucket}_detail`].length > 0
    flags.push({
      code: 'OTHER_DEDUCTIONS', kind: 'ratio', severity: itemized ? 'low' : 'medium',
      title: '"Other deductions" is a large share of expenses',
      value: otherShare, threshold: 0.10, lines: [b.lineKeys.other, `${otherBucket}_detail`],
      explanation: `${usd(b.otherDeductions)} (${pct(otherShare)} of deductions) sits on the catch-all line. ${itemized ? 'The statement itemizes it — move anything that has its own line (rent, taxes, wages, advertising) onto that line.' : 'There is no itemized statement in the return data; the form requires one, and an unexplained lump is what draws review.'}`,
    })
  }

  // 6. Charitable deductions far above norm for a business.
  if (b.charitable / receipts > 0.05) {
    flags.push({
      code: 'CHARITABLE', kind: 'ratio', severity: 'low',
      title: 'Charitable contributions are high relative to receipts',
      value: b.charitable / receipts, threshold: 0.05, lines: ['deductions.L19_charitable'],
      explanation: `Contributions of ${usd(b.charitable)}. Keep acknowledgment letters; a C corporation's deduction is capped at 10% of taxable income.`,
    })
  }
}

/** Year-over-year: a line that swings by both >50% and >$25,000 gets asked about. */
function changeFlags(fv: Record<string, any>, prior: Record<string, any> | null | undefined, keys: string[], flags: RiskFlag[]) {
  if (!prior) return
  for (const k of keys) {
    const now = num(fv[k]), was = num(prior[k])
    const delta = now - was
    if (Math.abs(delta) < 25000) continue
    const base = Math.max(Math.abs(was), 1)
    if (Math.abs(delta) / base < 0.5 && was !== 0) continue
    flags.push({
      code: 'YOY_SWING', kind: 'change', severity: Math.abs(delta) >= 250000 ? 'medium' : 'low',
      title: `Large change on ${k}`,
      value: delta, lines: [k],
      explanation: `${k} moved from ${usd(was)} to ${usd(now)}. Large unexplained swings are a classic selection factor — be ready to say why (e.g. a reclassification, a one-off contract).`,
    })
  }
}

/** Schedule L must foot on both sides, both columns. */
function scheduleLFlags(fv: Record<string, any>, flags: RiskFlag[]) {
  for (const col of ['boy_b', 'eoy_d']) {
    const assets = num(fv[`schedL.L15_total_${col}`])
    const le = num(fv[`schedL.L28_total_${col}`] ?? fv[`schedL.L27_total_${col}`])
    if (!assets && !le) continue
    if (Math.abs(assets - le) > 1) {
      flags.push({
        code: 'SCHED_L_UNBALANCED', kind: 'integrity', severity: 'high',
        title: `Schedule L does not balance (${col.startsWith('boy') ? 'beginning' : 'end'} of year)`,
        value: assets - le, lines: [`schedL.L15_total_${col}`, `schedL.L28_total_${col}`],
        explanation: `Total assets ${usd(assets)} vs liabilities and equity ${usd(le)}.`,
      })
    }
    // Component lines vs their own stated total — the check that caught a
    // shareholder loan counted twice.
    // Net-of-reserve column of every asset line (b at the start, d at the end).
    const ASSET_LINES = ['L1_cash', 'L2a_trade', 'L3_inv', 'L4_usgov', 'L5_taxexempt', 'L6_othercurr',
      'L7_loans', 'L8_mortgage', 'L9_otherinv', 'L10b_dep', 'L11_depletable_dep', 'L12_land', 'L13b_amort', 'L14_other']
    const assetLines = ASSET_LINES.map(l => `schedL.${l}_${col}`).filter(k => fv[k] !== undefined && fv[k] !== null)
    if (assetLines.length >= 2 && assets) {
      const sum = assetLines.reduce((t, k) => t + num(fv[k]), 0)
      if (Math.abs(sum - assets) > 1) {
        flags.push({
          code: 'SCHED_L_LINES_VS_TOTAL', kind: 'integrity', severity: 'high',
          title: `Schedule L asset lines do not add to total assets (${col.startsWith('boy') ? 'beginning' : 'end'} of year)`,
          value: sum - assets, lines: [...assetLines, `schedL.L15_total_${col}`],
          explanation: `The asset lines add to ${usd(sum)} against stated total assets of ${usd(assets)} — something is counted twice or on the wrong line.`,
        })
      }
    }
  }
}

// ─── Public entry ──────────────────────────────────────────────────────────

export function rateReturn(formType: string, fieldValues: Record<string, any>, ctx: RiskContext = {}, taxYear?: number): RiskReport {
  const fv = fieldValues || {}
  const flags: RiskFlag[] = []
  const metrics: Record<string, number> = {}

  if (formType === '1120' || formType === '1120S') {
    const b = formType === '1120' ? read1120(fv) : read1120S(fv)
    metrics.receipts = b.receipts
    businessRatioFlags(b, ctx, 'other_deductions', flags, metrics)
    scheduleLFlags(fv, flags)

    if (formType === '1120') {
      // M-1 line 10 must equal line 28.
      const m1 = num(fv['schedM1.L10_income_line28'])
      const l28 = pick(fv, 'tax.L28_ti_before_nol', 'tax.L28_taxable_income_before_nol', 'tax.taxable_income_before_nol')
      if (fv['schedM1.L10_income_line28'] !== undefined && l28 && Math.abs(m1 - l28) > 1) {
        flags.push({
          code: 'M1_NOT_TIED', kind: 'integrity', severity: 'high',
          title: 'Schedule M-1 does not reconcile to taxable income',
          value: m1 - l28, lines: ['schedM1.L10_income_line28', 'tax.L28_ti_before_nol'],
          explanation: `M-1 line 10 is ${usd(m1)} but line 28 is ${usd(l28)}.`,
        })
      }
      // Loans to shareholders on a C corporation: constructive dividend risk.
      const loans = num(fv['schedL.L7_loans_eoy_d'])
      if (loans > 0 && b.receipts > 0 && loans / b.receipts > 0.10) {
        flags.push({
          code: 'SHAREHOLDER_LOAN', kind: 'pattern', severity: 'medium',
          title: 'Large loan to a shareholder',
          value: loans, lines: ['schedL.L7_loans_eoy_d'],
          explanation: `${usd(loans)} owed by shareholders. Without a written note, interest at the applicable federal rate and actual repayments, the IRS can treat it as a dividend.`,
        })
      }
    } else {
      // Reasonable compensation: officer pay small beside distributions.
      const dist = pick(fv, 'schedK.L16d_distributions', 'schedM2.L7_distributions')
      const ordinary = pick(fv, 'tax.L22_ordinary_income', 'schedK.L1_ordinary')
      metrics.officer_comp = b.officerComp
      metrics.distributions = dist
      if (ordinary > 50000 && (b.officerComp === 0 || (dist > 0 && b.officerComp / (b.officerComp + dist) < 0.30))) {
        flags.push({
          code: 'REASONABLE_COMP', kind: 'pattern', severity: b.officerComp === 0 ? 'high' : 'medium',
          title: 'Officer pay is low relative to distributions',
          value: b.officerComp, lines: [b.lineKeys.officer, 'schedK.L16d_distributions', 'tax.L22_ordinary_income'],
          explanation: `Officer compensation ${usd(b.officerComp)} against distributions of ${usd(dist)} and ordinary income of ${usd(ordinary)}. S-corporation owners who work in the business must take reasonable wages before distributions; a low ratio is an examiner focus. Keep a basis for the salary level (comparable roles, hours).`,
        })
      }
      const loans = num(fv['schedL.L7_loans_eoy_d'])
      if (loans > 0 && b.receipts > 0 && loans / b.receipts > 0.10) {
        flags.push({
          code: 'SHAREHOLDER_LOAN', kind: 'pattern', severity: 'medium',
          title: 'Large loan to a shareholder',
          value: loans, lines: ['schedL.L7_loans_eoy_d'],
          explanation: `${usd(loans)} owed by shareholders. Without a note, interest and repayments it can be recharacterized as a distribution or wages.`,
        })
      }
      // M-2 ending AAA vs Schedule M-2 lines.
      const m2 = ['schedM2.L1_beg_balance', 'schedM2.L2_ordinary_income', 'schedM2.L3_other_additions']
        .reduce((t, k) => t + num(fv[k]), 0) - num(fv['schedM2.L4_loss']) - num(fv['schedM2.L5_other_reductions']) - num(fv['schedM2.L7_distributions'])
      if (fv['schedM2.L8_end_balance'] !== undefined && Math.abs(m2 - num(fv['schedM2.L8_end_balance'])) > 1) {
        flags.push({
          code: 'M2_NOT_TIED', kind: 'integrity', severity: 'medium',
          title: 'Schedule M-2 lines do not reach the ending balance',
          value: m2 - num(fv['schedM2.L8_end_balance']), lines: ['schedM2.L8_end_balance'],
          explanation: `Lines 1–7 give ${usd(m2)}; line 8 says ${usd(num(fv['schedM2.L8_end_balance']))}.`,
        })
      }
    }

    changeFlags(fv, ctx.prior, [
      b.lineKeys.receipts, b.lineKeys.officer, b.lineKeys.advertising, b.lineKeys.other,
      formType === '1120' ? 'deductions.L13_salaries' : 'deductions.L8_salaries',
    ], flags)
  } else if (formType === '1040') {
    const agi = pick(fv, 'income.L11b_agi', 'income.L11_agi')
    const wages = pick(fv, 'income.L1z_total_wages', 'income.L1a_w2_wages')
    const k1 = pick(fv, 'sched1.L5_rental_partnership_scorp')
    metrics.agi = agi
    // Income class: examination coverage rises steeply at the top.
    if (agi >= 1_000_000) {
      flags.push({
        code: 'HIGH_INCOME', kind: 'pattern', severity: agi >= 5_000_000 ? 'medium' : 'low',
        title: 'High income class',
        value: agi, threshold: 1_000_000, lines: ['income.L11b_agi'],
        explanation: `AGI of ${usd(agi)}. Returns above $1M are examined far more often than average regardless of content — make sure every figure is supported.`,
      })
    }
    // Pass-through income dwarfing wages: the S-corp reasonable-comp pattern from the owner's side.
    if (k1 > 250_000 && wages > 0 && k1 / (k1 + wages) > 0.85) {
      flags.push({
        code: 'PASSTHROUGH_VS_WAGES', kind: 'pattern', severity: 'low',
        title: 'Pass-through income far exceeds wages',
        value: k1 / (k1 + wages), threshold: 0.85, lines: ['sched1.L5_rental_partnership_scorp', 'income.L1z_total_wages'],
        explanation: `${usd(k1)} of K-1 income against ${usd(wages)} of wages. If it comes from an S corporation you work in, the corporation's officer pay is the item examiners test.`,
      })
    }
    // Itemized deductions far above norm for the income level. The standard
    // deduction is never a risk, so only an itemized return is measured.
    const itemized = ctx.inputs?.use_itemized || num(ctx.inputs?.itemized_deductions) > pick(fv, 'deductions.L12e_standard', 'deductions.L12_standard')
      ? pick(fv, 'deductions.L12e_standard', 'deductions.L12_standard') : 0
    if (agi > 0 && itemized / agi > 0.25 && itemized > 50_000) {
      flags.push({
        code: 'DEDUCTIONS_VS_AGI', kind: 'ratio', severity: 'medium',
        title: 'Deductions are high relative to AGI',
        value: itemized / agi, threshold: 0.25, lines: ['deductions.L12e_standard', 'income.L11b_agi'],
        explanation: `Deductions of ${usd(itemized)} are ${pct(itemized / agi)} of AGI. Keep acknowledgment letters and Form 1098s.`,
      })
    }
    // Schedule B payers must add to the face line — the IRS matches every 1099.
    const payers = Array.isArray(ctx.inputs?.taxable_interest_detail) ? ctx.inputs!.taxable_interest_detail.reduce((t: number, x: any) => t + num(x?.amount), 0) : null
    const k1int = num(ctx.inputs?.k1_portfolio?.interest)
    const line2b = pick(fv, 'income.L2b_taxable_int')
    if (payers !== null && Math.abs(payers + k1int - line2b) > 1) {
      flags.push({
        code: 'SCHED_B_NOT_TIED', kind: 'integrity', severity: 'medium',
        title: 'Interest payers do not add to line 2b',
        value: payers + k1int - line2b, lines: ['income.L2b_taxable_int', 'taxable_interest_detail'],
        explanation: `Payers and K-1 interest total ${usd(payers + k1int)}; line 2b is ${usd(line2b)}. Every 1099-INT is matched by the IRS.`,
      })
    }
    changeFlags(fv, ctx.prior, ['income.L1z_total_wages', 'income.L2b_taxable_int', 'income.L8_schedule1'], flags)
  }

  const score = Math.min(100, flags.reduce((t, f) => t + WEIGHT[f.severity], 0))
  const band = score >= 50 ? 'high' : score >= 20 ? 'elevated' : 'low'
  flags.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity])
  return { form_type: formType, tax_year: taxYear, score, band, metrics, flags, disclaimer: DISCLAIMER }
}
