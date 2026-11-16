/**
 * Form 1065 preparation. Fictional partnership, figures chosen so each rule is
 * visible: two individual partners (general 60/limited 40), a corporate
 * partner in the three-partner case, guaranteed payments to the general
 * partner only.
 */
import { describe, it, expect } from 'vitest'
import { calc1065, allocate, type Form1065_Inputs } from './form1065.js'
import { classifyKey } from '../schema/validate.js'

const base: Form1065_Inputs = {
  tax_year: 2025,
  gross_receipts: 500_000, cost_of_goods_sold: 100_000,
  salaries_wages: 80_000, rents: 24_000, taxes_licenses: 6_000, depreciation: 10_000, other_deductions: 20_000,
  schedule_k_interest: 1_001, schedule_k_dividends_ordinary: 500, schedule_k_dividends_qualified: 400,
  section_179: 5_000, charitable_contrib: 3_000, distributions: 150_000,
  tax_exempt_interest: 200, nondeductible_expenses: 1_000,
  w2_wages: 80_000,
  partners: [
    { name: 'Alder Partner', partner_type: 'general', profit_pct: 60, guaranteed_payments_services: 60_000, capital_beginning: 100_000 },
    { name: 'Birch Partner', partner_type: 'limited', profit_pct: 40, capital_beginning: 50_000 },
  ],
}

describe('Form 1065 — page 1 and Schedule K', () => {
  it('computes ordinary business income with guaranteed payments on line 10', () => {
    const r = calc1065(base)
    const fv = r.field_values
    expect(fv['income.L3_gross_profit']).toBe(400_000)
    expect(fv['deductions.L10_guaranteed_payments']).toBe(60_000)
    expect(fv['deductions.L22_total_deductions']).toBe(200_000)
    expect(fv['tax.L23_ordinary_business_income']).toBe(200_000)
    expect(fv['schedK.L1_ordinary_income']).toBe(200_000)
    expect(fv['schedK.L4c_gp_total']).toBe(60_000)
    // Analysis line 1: K 1–11 (200,000 + 60,000 + 1,001 + 500) − K 12–13e (5,000 + 3,000)
    expect(fv['analysis.L1_net_income']).toBe(253_501)
  })

  it('splits every item so the K-1s add back to Schedule K exactly', () => {
    const r = calc1065(base)
    const sum = (k: keyof typeof r.k1s[0]) => r.k1s.reduce((t, p) => t + (p[k] as number), 0)
    expect(sum('ordinary_income')).toBe(200_000)
    expect(sum('interest_income')).toBe(1_001)            // 600.6 / 400.4 → 601 / 400
    expect(r.k1s.map(k => k.interest_income)).toEqual([601, 400])
    expect(sum('distributions')).toBe(150_000)
    expect(sum('section_179')).toBe(5_000)
  })

  it('allocates a loss by loss %, not profit %', () => {
    const r = calc1065({ ...base, gross_receipts: 100_000, partners: [
      { name: 'A', profit_pct: 60, loss_pct: 80, partner_type: 'general' },
      { name: 'B', profit_pct: 40, loss_pct: 20, partner_type: 'limited' },
    ] })
    const ord = r.field_values['schedK.L1_ordinary_income'] as number
    expect(ord).toBeLessThan(0)
    expect(r.k1s[0].ordinary_income).toBe(Math.round(ord * 0.8))
  })

  it('rejects percentages that do not add to 100 and GP totals that disagree', () => {
    expect(() => calc1065({ ...base, partners: [{ name: 'A', profit_pct: 60 }, { name: 'B', profit_pct: 30 }] })).toThrow(/add to 100/)
    expect(() => calc1065({ ...base, guaranteed_payments: 50_000 })).toThrow(/does not equal/)
  })
})

describe('Form 1065 — self-employment by partner type (owner decision 2026-11-16)', () => {
  it('general partner: ordinary share + guaranteed payments − §179; limited: services payments only', () => {
    const r = calc1065({ ...base, partners: [
      ...base.partners,
      { name: 'Cedar Corp', entity: 'corporation', partner_type: 'general', profit_pct: 0 },
    ] })
    const [gen, lim, corp] = r.k1s
    expect(gen.se_earnings).toBe(120_000 + 60_000 - 3_000)   // 60% of 200,000, GP, 60% of §179
    expect(lim.se_earnings).toBe(0)
    expect(corp.se_earnings).toBe(0)
    expect(r.field_values['schedK.L14a_se_earnings']).toBe(177_000)
  })

  it('an LLC member counts in full unless marked limited; an override wins', () => {
    const r = calc1065({ ...base, partners: [
      { name: 'M1', partner_type: 'llc_member', profit_pct: 50 },
      { name: 'M2', partner_type: 'llc_member', limited: true, profit_pct: 50, guaranteed_payments_services: 10_000, se_override: true },
    ] })
    expect(r.k1s[0].se_earnings).toBeGreaterThan(0)
    expect(r.k1s[1].se_earnings).toBe(r.k1s[1].ordinary_income + 10_000 - r.k1s[1].section_179)
  })
})

describe('Form 1065 — capital accounts and M-2 (tax basis)', () => {
  it('rolls each partner forward and M-2 ends where the partners end', () => {
    const r = calc1065(base)
    const [a] = r.k1s
    // net income for capital excludes the guaranteed payment the partner was paid
    expect(a.capital_net_income).toBe(Math.round(a.ordinary_income + a.interest_income + a.dividends_ordinary - a.section_179 - a.charitable))
    expect(a.capital_ending).toBe(a.capital_beginning + a.capital_net_income + a.capital_other_increase - a.capital_withdrawals)
    const ends = r.k1s.reduce((t, k) => t + k.capital_ending, 0)
    expect(r.field_values['schedM2.L9_end_balance']).toBe(ends)
    expect(r.field_values['schedM2.L1_beg_balance']).toBe(150_000)
    expect(r.field_values['schedM2.L4_other_increases']).toBe(200)
    expect(r.field_values['schedM2.L7_other_decreases']).toBe(1_000)
  })

  it('reports an M-1 that does not reach Analysis line 1 instead of forcing it', () => {
    const ok = calc1065({ ...base, net_income_books: 193_501 })
    expect(ok.field_values['schedM1.L9_income_analysis']).toBe(253_501)
    expect(ok.warnings.join(' ')).not.toMatch(/M-1/)
    const off = calc1065({ ...base, net_income_books: 190_000 })
    expect(off.warnings.join(' ')).toMatch(/Schedule M-1 does not reach/)
  })
})

describe('Form 1065 — data contract', () => {
  it('every line it writes is a golden schema key', () => {
    const fv = calc1065({ ...base, net_income_books: 193_501 }).field_values
    const rejected = Object.keys(fv).filter(k => classifyKey('1065', k) === 'rejected')
    expect(rejected).toEqual([])
  })

  it('allocate keeps whole dollars that add to the total', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100)
    expect(allocate(0, [50, 50])).toEqual([0, 0])
  })
})

describe('Form 1065 — audit-risk screen', () => {
  it('passes a clean return and flags guaranteed payments that create a loss', async () => {
    const { rateReturn } = await import('./audit_risk.js')
    const clean = rateReturn('1065', calc1065({ ...base, net_income_books: 193_501 }).field_values)
    expect(clean.flags.filter(f => f.kind === 'integrity')).toEqual([])
    const lossy = calc1065({ ...base, partners: [
      { name: 'A', partner_type: 'general', profit_pct: 50, guaranteed_payments_services: 300_000 },
      { name: 'B', partner_type: 'limited', profit_pct: 50 },
    ] })
    expect(rateReturn('1065', lossy.field_values).flags.map(f => f.code)).toContain('GP_CREATE_LOSS')
  })
  it('catches an M-1 that does not tie and a 1065 balance sheet that does not foot', async () => {
    const { rateReturn } = await import('./audit_risk.js')
    const fv = { ...calc1065(base).field_values, 'schedM1.L9_income_analysis': 1,
      'schedL.L1_cash_eoy_d': 100, 'schedL.L13_other_eoy_d': 50, 'schedL.L14_total_eoy_d': 200, 'schedL.L22_total_eoy_d': 200 }
    const codes = rateReturn('1065', fv).flags.map(f => f.code)
    expect(codes).toEqual(expect.arrayContaining(['M1_NOT_TIED', 'SCHED_L_LINES_VS_TOTAL']))
  })
})
