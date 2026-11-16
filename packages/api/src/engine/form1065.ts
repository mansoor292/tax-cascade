/**
 * Form 1065 — U.S. Return of Partnership Income, prepared (not just read).
 *
 * Until 2026-11-16 a partnership entered Cati only as a filed import; the one
 * engine piece was calc1065K1s, which split totals a caller typed in. The
 * owner decided preparation is supported, so this computes the return the way
 * calc1120S computes an S corporation's: page 1 down to ordinary business
 * income (line 23), Schedule K, the Analysis of Net Income (Loss) per Return,
 * Schedules M-1 and M-2, and one K-1 per partner with its capital account.
 *
 * Decisions (owner, 2026-11-16):
 *  - Items are allocated by ownership percentage only: income items by
 *    profit %, an item that is a net LOSS by loss %, distributions by
 *    capital % unless a partner's own distributions are given. Special
 *    allocations and §704(c) are out of scope — a partnership agreement that
 *    needs them is not one this engine prepares.
 *  - Self-employment earnings (Schedule K line 14a, K-1 box 14A) default by
 *    partner type: guaranteed payments for services always count; a general
 *    partner, an LLC member-manager, or an LLC member not marked limited
 *    also counts its share of ordinary income and capital guaranteed
 *    payments, less its §179 share. A limited partner counts its services
 *    payments only. Partners that are not individuals have none. A partner's
 *    `se_override` wins.
 *
 * Allocation rounds with the largest-remainder method so every partner's K-1
 * adds back to the Schedule K line exactly. A K-1 set that does not tie to
 * Schedule K is the first thing a matching program would see.
 *
 * Capital accounts are on the tax basis the IRS requires (K-1 item L, M-2):
 * current-year net income is the partner's share of Analysis line 1 less its
 * guaranteed payments (paid out, not left in capital); tax-exempt income is an
 * other increase and nondeductible expenses an other decrease.
 */

import { TaxInputError } from './tax_engine.js'

export type PartnerType = 'general' | 'limited' | 'llc_member_manager' | 'llc_member'
export type PartnerEntity = 'individual' | 'corporation' | 's_corporation' | 'partnership' | 'trust' | 'estate' | 'exempt_org' | 'nominee'

export interface Partner1065Input {
  name: string
  tin?: string
  address?: string
  partner_type?: PartnerType             // default 'general'
  /** An LLC member who is a limited partner in substance (no management role). */
  limited?: boolean
  entity?: PartnerEntity                 // default 'individual'
  /** Individual partners: material participation (Analysis line 2, active vs passive). */
  active?: boolean                       // default true
  foreign?: boolean
  profit_pct: number
  loss_pct?: number
  capital_pct?: number
  profit_pct_beginning?: number
  loss_pct_beginning?: number
  capital_pct_beginning?: number
  guaranteed_payments_services?: number
  guaranteed_payments_capital?: number
  /** Item L. */
  capital_beginning?: number
  capital_contributed?: number
  /** This partner's distributions; when no partner gives one, totals are split by capital %. */
  distributions?: number
  /** Item K1 — share of liabilities at year end. */
  liabilities_nonrecourse?: number
  liabilities_qualified_nonrecourse?: number
  liabilities_recourse?: number
  /** Force self-employment treatment on or off. */
  se_override?: boolean
}

export interface Form1065_Inputs {
  tax_year?: number
  // Page 1 income
  gross_receipts?: number
  returns_allowances?: number
  cost_of_goods_sold?: number
  ordinary_income_other_partnerships?: number
  net_farm_profit?: number
  net_gain_4797?: number
  other_income?: number
  // Page 1 deductions
  salaries_wages?: number
  /** Line 10. Defaults to the partners' guaranteed payments; both given must agree. */
  guaranteed_payments?: number
  repairs_maintenance?: number
  bad_debts?: number
  rents?: number
  taxes_licenses?: number
  interest?: number
  depreciation?: number
  depreciation_1125a?: number
  depletion?: number
  retirement_plans?: number
  employee_benefits?: number
  energy_efficient?: number
  other_deductions?: number
  // Schedule K — separately stated items (partnership totals)
  net_rental_real_estate?: number
  other_gross_rental?: number
  other_rental_expenses?: number
  schedule_k_interest?: number
  schedule_k_dividends_ordinary?: number
  schedule_k_dividends_qualified?: number
  schedule_k_royalties?: number
  schedule_k_st_cap_gain?: number
  schedule_k_lt_cap_gain?: number
  schedule_k_net_1231_gain?: number
  schedule_k_other_income?: number
  section_179?: number
  charitable_contrib?: number
  charitable_noncash?: number
  investment_interest?: number
  schedule_k_other_deductions?: number
  tax_exempt_interest?: number
  other_tax_exempt_income?: number
  nondeductible_expenses?: number
  distributions?: number
  distributions_property?: number
  foreign_taxes?: number
  // §199A (K-1 box 20 code Z)
  w2_wages?: number
  ubia?: number
  is_sstb?: boolean
  // M-1 / M-2 facts only the books know
  net_income_books?: number
  capital_contributed_property?: number
  partners: Partner1065Input[]
}

export interface K1_1065 {
  name: string
  tin?: string
  address?: string
  partner_type: PartnerType
  entity: PartnerEntity
  general: boolean
  foreign: boolean
  profit_pct: number
  loss_pct: number
  capital_pct: number
  profit_pct_beginning: number
  loss_pct_beginning: number
  capital_pct_beginning: number
  ordinary_income: number
  rental_real_estate: number
  other_rental: number
  guaranteed_payments_services: number
  guaranteed_payments_capital: number
  interest_income: number
  dividends_ordinary: number
  dividends_qualified: number
  royalties: number
  st_cap_gain: number
  lt_cap_gain: number
  net_1231_gain: number
  other_income: number
  section_179: number
  charitable: number
  charitable_noncash: number
  investment_interest: number
  other_deductions: number
  se_earnings: number
  tax_exempt_interest: number
  other_tax_exempt: number
  nondeductible: number
  distributions: number
  distributions_property: number
  foreign_taxes: number
  qbi_income: number
  w2_wages: number
  ubia: number
  is_sstb: boolean
  capital_beginning: number
  capital_contributed: number
  capital_net_income: number
  capital_other_increase: number
  capital_withdrawals: number
  capital_ending: number
  liabilities_nonrecourse: number
  liabilities_qualified_nonrecourse: number
  liabilities_recourse: number
}

export interface Form1065_Result {
  computed: Record<string, number>
  field_values: Record<string, number | string>
  k1s: K1_1065[]
  warnings: string[]
  citations: string[]
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(x) ? x : 0
}
const r = (x: number) => Math.round(x)

/**
 * Split `total` by `weights` (percentages) so the parts are whole dollars and
 * add back to the rounded total exactly — largest remainder gets the cents.
 */
export function allocate(total: number, weights: number[]): number[] {
  const t = r(total)
  const sum = weights.reduce((s, w) => s + w, 0)
  if (!t || !sum) return weights.map(() => 0)
  const exact = weights.map(w => t * w / sum)
  const base = exact.map(e => Math.trunc(e))
  let left = t - base.reduce((s, b) => s + b, 0)
  const order = exact.map((e, i) => ({ i, frac: Math.abs(e - base[i]) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  const step = Math.sign(left)
  for (let k = 0; left !== 0 && k < order.length * 2; k++) { base[order[k % order.length].i] += step; left -= step }
  return base
}

function isIndividual(p: Partner1065Input): boolean {
  return (p.entity ?? 'individual') === 'individual'
}
function isGeneral(p: Partner1065Input): boolean {
  const t = p.partner_type ?? 'general'
  return t === 'general' || t === 'llc_member_manager'
}
/** Counts ordinary income for SE (owner decision 2026-11-16, see header). */
function seFullShare(p: Partner1065Input): boolean {
  if (p.se_override !== undefined) return p.se_override
  if (!isIndividual(p)) return false
  const t = p.partner_type ?? 'general'
  if (t === 'general' || t === 'llc_member_manager') return true
  if (t === 'llc_member') return !p.limited
  return false
}

export function calc1065(inp: Form1065_Inputs): Form1065_Result {
  const warnings: string[] = []
  const partners = Array.isArray(inp.partners) ? inp.partners : []
  if (!partners.length) throw new TaxInputError('partners', inp.partners, 'a partnership return needs its partners: [{ name, profit_pct, partner_type }]')
  if (partners.length < 2) warnings.push('One partner listed. A partnership has at least two partners; a single-member LLC without an election is reported on its owner\'s return, not a Form 1065.')
  const pct = (k: 'profit_pct' | 'loss_pct' | 'capital_pct') => partners.map(p => n(k === 'profit_pct' ? p.profit_pct : p[k] ?? p.profit_pct))
  for (const k of ['profit_pct', 'loss_pct', 'capital_pct'] as const) {
    const s = pct(k).reduce((a, b) => a + b, 0)
    if (Math.abs(s - 100) > 0.01) throw new TaxInputError(`partners[].${k}`, s, `the partners' ${k.replace('_pct', '')} percentages must add to 100 (got ${s})`)
  }
  const profit = pct('profit_pct'), loss = pct('loss_pct'), capital = pct('capital_pct')
  /** An item follows profit % when it is income, loss % when it is a loss. */
  const share = (total: number) => allocate(total, total < 0 ? loss : profit)

  // ── Guaranteed payments ────────────────────────────────────────────
  const gpS = partners.map(p => r(n(p.guaranteed_payments_services)))
  const gpC = partners.map(p => r(n(p.guaranteed_payments_capital)))
  const gpPartners = gpS.reduce((a, b) => a + b, 0) + gpC.reduce((a, b) => a + b, 0)
  let gpLine10 = gpPartners
  if (inp.guaranteed_payments !== undefined && inp.guaranteed_payments !== null) {
    const stated = r(n(inp.guaranteed_payments))
    if (gpPartners && Math.abs(stated - gpPartners) > 1) {
      throw new TaxInputError('guaranteed_payments', stated, `${stated} does not equal the partners' guaranteed payments (${gpPartners}) — give them per partner, or make the two agree`)
    }
    if (!gpPartners && stated) {
      warnings.push('Guaranteed payments were given as a total with no partner named; they are deducted on line 10 but cannot appear on any K-1. Give them per partner.')
    }
    gpLine10 = stated
  }

  // ── Page 1 ─────────────────────────────────────────────────────────
  const L1a = r(n(inp.gross_receipts)), L1b = r(n(inp.returns_allowances))
  const L1c = L1a - L1b
  const L2 = r(n(inp.cost_of_goods_sold))
  const L3 = L1c - L2
  const L4 = r(n(inp.ordinary_income_other_partnerships))
  const L5 = r(n(inp.net_farm_profit))
  const L6 = r(n(inp.net_gain_4797))
  const L7 = r(n(inp.other_income))
  const L8 = L3 + L4 + L5 + L6 + L7
  const L16a = r(n(inp.depreciation)), L16b = r(n(inp.depreciation_1125a))
  const L16c = L16a - L16b
  const ded: Record<string, number> = {
    'deductions.L9_salaries': r(n(inp.salaries_wages)),
    'deductions.L10_guaranteed_payments': gpLine10,
    'deductions.L11_repairs': r(n(inp.repairs_maintenance)),
    'deductions.L12_bad_debts': r(n(inp.bad_debts)),
    'deductions.L13_rent': r(n(inp.rents)),
    'deductions.L14_taxes': r(n(inp.taxes_licenses)),
    'deductions.L15_interest': r(n(inp.interest)),
    'deductions.L16c_depreciation_net': L16c,
    'deductions.L17_depletion': r(n(inp.depletion)),
    'deductions.L18_retirement': r(n(inp.retirement_plans)),
    'deductions.L19_employee_benefits': r(n(inp.employee_benefits)),
    'deductions.L20_energy_efficient': r(n(inp.energy_efficient)),
    'deductions.L21_other_deductions': r(n(inp.other_deductions)),
  }
  const L22 = Object.values(ded).reduce((a, b) => a + b, 0)
  const L23 = L8 - L22

  // ── Schedule K totals ──────────────────────────────────────────────
  const K = {
    L1: L23,
    L2: r(n(inp.net_rental_real_estate)),
    L3a: r(n(inp.other_gross_rental)),
    L3b: r(n(inp.other_rental_expenses)),
    L4a: gpS.reduce((a, b) => a + b, 0),
    L4b: gpC.reduce((a, b) => a + b, 0),
    L5: r(n(inp.schedule_k_interest)),
    L6a: r(n(inp.schedule_k_dividends_ordinary)),
    L6b: r(n(inp.schedule_k_dividends_qualified)),
    L7: r(n(inp.schedule_k_royalties)),
    L8: r(n(inp.schedule_k_st_cap_gain)),
    L9a: r(n(inp.schedule_k_lt_cap_gain)),
    L10: r(n(inp.schedule_k_net_1231_gain)),
    L11: r(n(inp.schedule_k_other_income)),
    L12: r(n(inp.section_179)),
    L13a: r(n(inp.charitable_contrib)),
    L13b: r(n(inp.charitable_noncash)),
    L13c: r(n(inp.investment_interest)),
    L13e: r(n(inp.schedule_k_other_deductions)),
    L18a: r(n(inp.tax_exempt_interest)),
    L18b: r(n(inp.other_tax_exempt_income)),
    L18c: r(n(inp.nondeductible_expenses)),
    L19a: r(n(inp.distributions)),
    L19b: r(n(inp.distributions_property)),
    L21: r(n(inp.foreign_taxes)),
  }
  const L3c = K.L3a - K.L3b
  const L4c = K.L4a + K.L4b
  if (K.L6b > K.L6a) warnings.push(`Qualified dividends (${K.L6b}) exceed ordinary dividends (${K.L6a}).`)

  // ── Per-partner allocation ─────────────────────────────────────────
  const a = {
    ordinary: share(K.L1), rentalRe: share(K.L2), otherRental: share(L3c),
    interest: share(K.L5), divOrd: share(K.L6a), divQual: share(K.L6b), royalties: share(K.L7),
    st: share(K.L8), lt: share(K.L9a), s1231: share(K.L10), other: share(K.L11),
    s179: allocate(K.L12, loss), cash: allocate(K.L13a, loss), noncash: allocate(K.L13b, loss),
    invInt: allocate(K.L13c, loss), otherDed: allocate(K.L13e, loss),
    taxEx: allocate(K.L18a, profit), otherTaxEx: allocate(K.L18b, profit), nondeductible: allocate(K.L18c, loss),
    foreign: allocate(K.L21, profit),
    w2: allocate(n(inp.w2_wages), profit), ubia: allocate(n(inp.ubia), profit),
  }
  // Distributions: each partner's own figure when any is given, else by capital %.
  const ownDist = partners.some(p => p.distributions !== undefined && p.distributions !== null)
  const dist = ownDist ? partners.map(p => r(n(p.distributions))) : allocate(K.L19a, capital)
  if (ownDist) {
    const sum = dist.reduce((x, y) => x + y, 0)
    if (inp.distributions !== undefined && Math.abs(sum - K.L19a) > 1) {
      throw new TaxInputError('distributions', K.L19a, `${K.L19a} does not equal the partners' distributions (${sum})`)
    }
    K.L19a = sum
  }
  const distProp = allocate(K.L19b, capital)

  // Self-employment earnings (K line 14a) and gross nonfarm income (14c).
  const se = partners.map((p, i) => {
    if (!isIndividual(p) && p.se_override === undefined) return 0
    return seFullShare(p) ? a.ordinary[i] + gpS[i] + gpC[i] - a.s179[i] : gpS[i]
  })
  const fullSe = partners.map(seFullShare)
  const nonfarmBase = L3 + L7
  const nonfarm = allocate(nonfarmBase, partners.map((_, i) => (fullSe[i] ? profit[i] : 0)))
  const K14a = se.reduce((x, y) => x + y, 0)
  const K14c = nonfarm.reduce((x, y) => x + y, 0) + K.L4a

  // ── Analysis of Net Income (Loss) per Return ───────────────────────
  const incomeItems = K.L1 + K.L2 + L3c + L4c + K.L5 + K.L6a + K.L7 + K.L8 + K.L9a + K.L10 + K.L11
  const deductionItems = K.L12 + K.L13a + K.L13b + K.L13c + K.L13e + K.L21
  const analysisL1 = incomeItems - deductionItems
  const partnerNet = partners.map((_, i) =>
    a.ordinary[i] + a.rentalRe[i] + a.otherRental[i] + gpS[i] + gpC[i] + a.interest[i] + a.divOrd[i] + a.royalties[i] + a.st[i] + a.lt[i] + a.s1231[i] + a.other[i]
    - a.s179[i] - a.cash[i] - a.noncash[i] - a.invInt[i] - a.otherDed[i] - a.foreign[i])
  const bucket = (p: Partner1065Input): string => {
    const e = p.entity ?? 'individual'
    if (e === 'individual') return p.active === false ? 'individual_passive' : 'individual_active'
    if (e === 'corporation' || e === 's_corporation') return 'corporate'
    if (e === 'partnership') return 'partnership'
    if (e === 'exempt_org') return 'exempt_org'
    return 'nominee'
  }
  const analysis: Record<string, number> = {}
  partners.forEach((p, i) => {
    const k = `analysis.L2${isGeneral(p) || (p.partner_type === 'llc_member' && !p.limited) ? 'a_general' : 'b_limited'}_${bucket(p)}`
    analysis[k] = (analysis[k] ?? 0) + partnerNet[i]
  })

  // ── Capital accounts (item L, Schedule M-2), tax basis ─────────────
  const capitalNetIncome = partners.map((_, i) => partnerNet[i] - gpS[i] - gpC[i])
  const otherInc = partners.map((_, i) => a.taxEx[i] + a.otherTaxEx[i])
  const otherDec = a.nondeductible
  const capBeg = partners.map(p => r(n(p.capital_beginning)))
  const capContrib = partners.map(p => r(n(p.capital_contributed)))
  const withdrawals = partners.map((_, i) => dist[i] + distProp[i])
  const capEnd = partners.map((_, i) => capBeg[i] + capContrib[i] + capitalNetIncome[i] + otherInc[i] - otherDec[i] - withdrawals[i])
  partners.forEach((p, i) => {
    if (capEnd[i] < 0) warnings.push(`${p.name}'s capital account ends negative (${capEnd[i]}). A negative tax-basis capital account must be reported as such; check distributions and the beginning balance.`)
  })
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0)
  const m2 = {
    L1: sum(capBeg),
    L2a: sum(capContrib),
    L2b: r(n(inp.capital_contributed_property)),
    L3: sum(capitalNetIncome),
    L4: sum(otherInc),
    L6a: K.L19a,
    L6b: K.L19b,
    L7: sum(otherDec),
  }
  const m2L5 = m2.L1 + m2.L2a + m2.L2b + m2.L3 + m2.L4
  const m2L8 = m2.L6a + m2.L6b + m2.L7
  const m2L9 = m2L5 - m2L8

  // ── Schedule M-1 ───────────────────────────────────────────────────
  // Book income is a fact only the books hold; given it, lines 5, 8 and 9 are
  // derived and line 9 must equal Analysis line 1.
  const fv: Record<string, number | string> = {
    'income.L1a_gross_receipts': L1a, 'income.L1b_returns': L1b, 'income.L1c_balance': L1c,
    'income.L2_cogs': L2, 'income.L3_gross_profit': L3, 'income.L4_other_partnerships': L4,
    'income.L5_net_farm': L5, 'income.L6_net_gain_4797': L6, 'income.L7_other_income': L7,
    'income.L8_total_income': L8,
    ...ded,
    'deductions.L16a_depreciation': L16a, 'deductions.L16b_depreciation_1125a': L16b,
    'deductions.L22_total_deductions': L22,
    'tax.L23_ordinary_business_income': L23,
    'schedK.L1_ordinary_income': K.L1, 'schedK.L2_net_rental_re': K.L2,
    'schedK.L3a_other_gross_rental': K.L3a, 'schedK.L3b_other_rental_expenses': K.L3b, 'schedK.L3c_other_net_rental': L3c,
    'schedK.L4a_gp_services': K.L4a, 'schedK.L4b_gp_capital': K.L4b, 'schedK.L4c_gp_total': L4c,
    'schedK.L5_interest': K.L5, 'schedK.L6a_ordinary_dividends': K.L6a, 'schedK.L6b_qualified_dividends': K.L6b,
    'schedK.L7_royalties': K.L7, 'schedK.L8_st_capital_gain': K.L8, 'schedK.L9a_lt_capital_gain': K.L9a,
    'schedK.L10_net_1231_gain': K.L10, 'schedK.L11_other_income': K.L11, 'schedK.L12_section_179': K.L12,
    'schedK.L13a_cash_contributions': K.L13a, 'schedK.L13b_noncash_contributions': K.L13b,
    'schedK.L13c_investment_interest': K.L13c, 'schedK.L13e_other_deductions': K.L13e,
    'schedK.L14a_se_earnings': K14a, 'schedK.L14c_nonfarm_income': K14c,
    'schedK.L18a_tax_exempt_interest': K.L18a, 'schedK.L18b_other_tax_exempt': K.L18b, 'schedK.L18c_nondeductible': K.L18c,
    'schedK.L19a_cash_distributions': K.L19a, 'schedK.L19b_property_distributions': K.L19b,
    'schedK.L20a_investment_income': K.L5 + K.L6a + K.L7, 'schedK.L20b_investment_expenses': 0,
    'schedK.L21_foreign_taxes': K.L21,
    'analysis.L1_net_income': analysisL1,
    ...analysis,
    'schedM2.L1_beg_balance': m2.L1, 'schedM2.L2a_contributed_cash': m2.L2a, 'schedM2.L2b_contributed_property': m2.L2b,
    'schedM2.L3_net_income': m2.L3, 'schedM2.L4_other_increases': m2.L4, 'schedM2.L5_add_1_4': m2L5,
    'schedM2.L6a_distributions_cash': m2.L6a, 'schedM2.L6b_distributions_property': m2.L6b,
    'schedM2.L7_other_decreases': m2.L7, 'schedM2.L8_add_6_7': m2L8, 'schedM2.L9_end_balance': m2L9,
    'meta.num_k1s': partners.length,
  }
  if (inp.net_income_books !== undefined && inp.net_income_books !== null) {
    const books = r(n(inp.net_income_books))
    // Books deduct guaranteed payments; the analysis adds them back (line 3).
    // Whatever is left between book and return income is a reconciling item
    // only the preparer can name, so it is reported, not invented.
    const m1L5 = books + L4c
    fv['schedM1.L1_net_income_books'] = books
    fv['schedM1.L3_guaranteed_payments'] = L4c
    fv['schedM1.L5_add_1_4'] = m1L5
    fv['schedM1.L8_add_6_7'] = 0
    fv['schedM1.L9_income_analysis'] = m1L5
    if (Math.abs(m1L5 - analysisL1) > 1) {
      warnings.push(`Schedule M-1 does not reach Analysis line 1: book income ${books} + guaranteed payments ${L4c} = ${m1L5}, but net income per return is ${analysisL1}. Give the reconciling items (schedM1.L2/L4/L6/L7) — line 9 must equal Analysis line 1.`)
    }
  }

  const k1s: K1_1065[] = partners.map((p, i) => ({
    name: p.name, tin: p.tin, address: p.address,
    partner_type: p.partner_type ?? 'general', entity: p.entity ?? 'individual',
    general: isGeneral(p), foreign: !!p.foreign,
    profit_pct: profit[i], loss_pct: loss[i], capital_pct: capital[i],
    profit_pct_beginning: n(p.profit_pct_beginning ?? profit[i]),
    loss_pct_beginning: n(p.loss_pct_beginning ?? loss[i]),
    capital_pct_beginning: n(p.capital_pct_beginning ?? capital[i]),
    ordinary_income: a.ordinary[i], rental_real_estate: a.rentalRe[i], other_rental: a.otherRental[i],
    guaranteed_payments_services: gpS[i], guaranteed_payments_capital: gpC[i],
    interest_income: a.interest[i], dividends_ordinary: a.divOrd[i], dividends_qualified: a.divQual[i],
    royalties: a.royalties[i], st_cap_gain: a.st[i], lt_cap_gain: a.lt[i], net_1231_gain: a.s1231[i],
    other_income: a.other[i], section_179: a.s179[i], charitable: a.cash[i], charitable_noncash: a.noncash[i],
    investment_interest: a.invInt[i], other_deductions: a.otherDed[i],
    se_earnings: se[i],
    tax_exempt_interest: a.taxEx[i], other_tax_exempt: a.otherTaxEx[i], nondeductible: a.nondeductible[i],
    distributions: dist[i], distributions_property: distProp[i], foreign_taxes: a.foreign[i],
    // §199A: ordinary business income less the partner's guaranteed payments
    // is already net of them at the partnership; the payments themselves are
    // not QBI (§199A(c)(4)).
    qbi_income: a.ordinary[i], w2_wages: a.w2[i], ubia: a.ubia[i], is_sstb: !!inp.is_sstb,
    capital_beginning: capBeg[i], capital_contributed: capContrib[i], capital_net_income: capitalNetIncome[i],
    capital_other_increase: otherInc[i] - otherDec[i], capital_withdrawals: withdrawals[i], capital_ending: capEnd[i],
    liabilities_nonrecourse: r(n(p.liabilities_nonrecourse)),
    liabilities_qualified_nonrecourse: r(n(p.liabilities_qualified_nonrecourse)),
    liabilities_recourse: r(n(p.liabilities_recourse)),
  }))

  return {
    computed: {
      balance_1c: L1c, gross_profit: L3, total_income: L8, total_deductions: L22,
      ordinary_income_loss: L23, guaranteed_payments: L4c, net_income_per_return: analysisL1,
      se_earnings: K14a, capital_end: m2L9, partners: partners.length,
    },
    field_values: fv,
    k1s,
    warnings,
    citations: [
      'Form 1065 Instructions: line 8 = lines 3–7; line 22 = lines 9–21; line 23 = line 8 − line 22',
      'IRC §707(c): guaranteed payments deducted by the partnership, income to the partner',
      'IRC §704(b) / Reg. 1.704-1: items follow the partners\' profit and loss shares (no special allocations)',
      'IRC §1402(a)(13): a limited partner\'s distributive share is not SE income; guaranteed payments for services are',
      'IRC §199A(c)(4): guaranteed payments are not qualified business income',
      'Form 1065 Instructions, item L: partner capital accounts on the tax basis',
    ],
  }
}
