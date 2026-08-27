/**
 * Golden tests for the tax engine.
 *
 * Every expected value here is derived by hand from published IRS rules and
 * the TY2025 tables (Rev. Proc. 2024-40), NOT by running the engine and
 * recording whatever it said. A test written the second way passes forever
 * and proves nothing — it locks in bugs instead of catching them.
 *
 * Where an expectation is arithmetic, the arithmetic is shown.
 */
import { describe, it, expect } from 'vitest'
import { calc1120S, calc1120, calc1040, calcCascade } from './tax_engine.js'

// ── Form 1120-S ────────────────────────────────────────────────────────────

describe('calc1120S', () => {
  const base = {
    gross_receipts: 1_000_000,
    returns_allowances: 0,
    cost_of_goods_sold: 400_000,
    officer_compensation: 100_000,
    salaries_wages: 200_000,
    tax_year: 2025,
  } as any

  it('ordinary income is gross profit less deductions', () => {
    const r = calc1120S({ ...base, shareholders: [{ name: 'Owner', pct: 100 }] })
    // 1,000,000 − 400,000 = 600,000 gross profit
    // 100,000 + 200,000 = 300,000 deductions
    expect(r.computed.gross_profit).toBe(600_000)
    expect(r.computed.total_deductions).toBe(300_000)
    expect(r.computed.ordinary_income_loss).toBe(300_000)
  })

  it('allocates K-1 ordinary income pro rata by ownership', () => {
    const r = calc1120S({
      ...base,
      shareholders: [{ name: 'A', pct: 60 }, { name: 'B', pct: 40 }],
    })
    expect(r.computed.k1s.map(k => k.ordinary_income)).toEqual([180_000, 120_000])
    // The allocation must be exhaustive — no income may go unallocated.
    const allocated = r.computed.k1s.reduce((s, k) => s + k.ordinary_income, 0)
    expect(allocated).toBe(r.computed.ordinary_income_loss)
  })

  it('levies no entity-level tax — an S-corp is a pass-through', () => {
    const r = calc1120S({ ...base, shareholders: [{ name: 'Owner', pct: 100 }] })
    expect(r.liabilities.tax_due).toBe(0)
  })

  it('passes a loss through as a negative K-1 rather than clamping to zero', () => {
    const r = calc1120S({
      ...base, cost_of_goods_sold: 900_000,
      shareholders: [{ name: 'Owner', pct: 100 }],
    })
    // 1,000,000 − 900,000 = 100,000 gross profit; 300,000 deductions
    expect(r.computed.ordinary_income_loss).toBe(-200_000)
    expect(r.computed.k1s[0].ordinary_income).toBe(-200_000)
  })
})

// ── Form 1120 ──────────────────────────────────────────────────────────────

describe('calc1120', () => {
  const base = {
    gross_receipts: 1_000_000,
    cost_of_goods_sold: 400_000,
    officer_compensation: 100_000,
    salaries_wages: 200_000,
    tax_year: 2025,
  } as any

  it('applies the flat 21% corporate rate (§11(b))', () => {
    const r = calc1120(base)
    expect(r.computed.taxable_income).toBe(300_000)
    expect(r.computed.income_tax).toBe(63_000)   // 300,000 × 0.21
  })

  it('caps the NOL deduction at 80% of taxable income (§172(a)(2))', () => {
    const r = calc1120({ ...base, nol_deduction: 500_000 })
    // cap = 80% × 300,000 = 240,000 — not the full 500,000 requested
    expect(r.computed.nol_applied).toBe(240_000)
    expect(r.computed.taxable_income).toBe(60_000)
    expect(r.computed.income_tax).toBe(12_600)   // 60,000 × 0.21
  })

  it('carries the disallowed NOL forward rather than discarding it', () => {
    const r = calc1120({ ...base, nol_deduction: 500_000 })
    expect(r.computed.nol_carryforward_remaining).toBe(260_000)  // 500,000 − 240,000
  })

  it('generates an NOL from a loss year and owes no tax', () => {
    const r = calc1120({ ...base, cost_of_goods_sold: 900_000 })
    // 100,000 gross profit − 300,000 deductions = (200,000)
    expect(r.computed.nol_generated).toBe(200_000)
    expect(r.computed.taxable_income).toBe(0)
    expect(r.computed.income_tax).toBe(0)
  })

  it('never produces negative taxable income', () => {
    const r = calc1120({ ...base, nol_deduction: 10_000_000 })
    expect(r.computed.taxable_income).toBeGreaterThanOrEqual(0)
  })
})

// ── Form 1040 ──────────────────────────────────────────────────────────────

describe('calc1040 (TY2025)', () => {
  const base = {
    filing_status: 'mfj' as const,
    tax_year: 2025,
    wages: 0, taxable_interest: 0, ordinary_dividends: 0, qualified_dividends: 0,
    ira_distributions: 0, pensions_annuities: 0, social_security: 0,
    capital_gains: 0, schedule1_income: 0,
    student_loan_interest: 0, educator_expenses: 0,
    itemized_deductions: 0, use_itemized: false,
    qbi_from_k1: 0, k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
    withholding: 0, estimated_payments: 0,
  }

  it('uses the TY2025 MFJ standard deduction of $30,000', () => {
    const r = calc1040({ ...base, wages: 100_000 })
    expect(r.computed.agi).toBe(100_000)
    expect(r.computed.taxable_income).toBe(70_000)   // 100,000 − 30,000
  })

  it('computes ordinary tax from the 12% MFJ bracket', () => {
    const r = calc1040({ ...base, wages: 100_000 })
    // Taxable 70,000 sits in the MFJ 12% band (23,850 → 96,950):
    //   2,385 + 0.12 × (70,000 − 23,850) = 2,385 + 5,538 = 7,923
    expect(r.computed.income_tax).toBe(7_923)
  })

  it('charges no Additional Medicare Tax below the MFJ threshold', () => {
    const r = calc1040({ ...base, wages: 200_000 })
    expect(r.computed.additional_medicare || 0).toBe(0)
  })

  it('charges 0.9% Additional Medicare Tax above $250,000 MFJ (§3101(b)(2))', () => {
    const r = calc1040({ ...base, wages: 300_000 })
    expect(r.computed.additional_medicare).toBe(450)   // 0.9% × 50,000
  })

  it('charges 3.8% NIIT on investment income above the MFJ threshold (§1411)', () => {
    // MAGI 400,000, of which 100,000 is investment income. Excess over the
    // 250,000 threshold is 150,000, so NIIT applies to the LESSER — the
    // 100,000 of net investment income. 3.8% × 100,000 = 3,800.
    const r = calc1040({ ...base, wages: 300_000, taxable_interest: 100_000 })
    expect(r.computed.niit).toBe(3_800)
  })

  it('charges no NIIT when MAGI is below the threshold', () => {
    const r = calc1040({ ...base, wages: 100_000, taxable_interest: 20_000 })
    expect(r.computed.niit || 0).toBe(0)
  })

  it('takes itemized deductions only when they are elected', () => {
    const standard = calc1040({ ...base, wages: 200_000, itemized_deductions: 50_000 })
    const itemized = calc1040({ ...base, wages: 200_000, itemized_deductions: 50_000, use_itemized: true })
    expect(standard.computed.taxable_income).toBe(170_000)   // 200,000 − 30,000
    expect(itemized.computed.taxable_income).toBe(150_000)   // 200,000 − 50,000
  })
})

// ── Cascade: 1120-S → K-1 → 1040 ───────────────────────────────────────────

describe('calcCascade', () => {
  const sCorp = {
    gross_receipts: 1_000_000,
    cost_of_goods_sold: 400_000,
    officer_compensation: 100_000,
    salaries_wages: 200_000,
    tax_year: 2025,
    shareholders: [{ name: 'Owner', pct: 100 }],
  } as any

  const individual = {
    filing_status: 'mfj' as const,
    tax_year: 2025,
    wages: 100_000, taxable_interest: 0, ordinary_dividends: 0, qualified_dividends: 0,
    ira_distributions: 0, pensions_annuities: 0, social_security: 0,
    capital_gains: 0, schedule1_income: 0,
    student_loan_interest: 0, educator_expenses: 0,
    itemized_deductions: 0, use_itemized: false,
    qbi_from_k1: 0, withholding: 0, estimated_payments: 0,
  } as any

  it('ties the K-1 leaving the business to the amount arriving on the 1040', () => {
    const r = calcCascade(sCorp, individual)
    // This is the whole point of the cascade — a break here means money
    // vanishes or is double-counted between two returns.
    expect(r.delta.k1_to_individual).toBe(r.s_corp.computed.k1s[0].ordinary_income)
    expect(r.delta.s_corp_income).toBe(300_000)
    expect(r.delta.k1_to_individual).toBe(300_000)
  })

  it('surfaces the surtaxes separately instead of burying them in income tax', () => {
    const r = calcCascade(sCorp, individual)
    expect(r.delta).toHaveProperty('additional_medicare')
    expect(r.delta).toHaveProperty('niit')
    // total_tax is Form 1040 line 24 and must be at least income tax plus surtaxes.
    expect(r.delta.total_tax).toBeGreaterThanOrEqual(
      r.delta.individual_tax + r.delta.additional_medicare + r.delta.niit,
    )
  })

  it('excludes S-corp K-1 income from Additional Medicare Tax', () => {
    // Wages 100,000 + K-1 ordinary income 300,000 = 400,000 of total income,
    // but Additional Medicare Tax reaches only wages and self-employment
    // income (§3101(b)(2), §1401(b)(2)). S-corp pass-through income is
    // neither — that is the entire point of the salary/distribution split.
    // So the correct answer is zero, and no diagnostic should fire.
    const r = calcCascade(sCorp, individual)
    expect(r.individual.computed.additional_medicare || 0).toBe(0)
    expect(r.delta.additional_medicare).toBe(0)
    expect(r.warnings.some(w => w.code === 'ADDMED_ZERO_DESPITE_HIGH_WAGES')).toBe(false)
  })

  it('does charge Additional Medicare Tax once WAGES cross the threshold', () => {
    // Same K-1, but wages of 300,000 — now 50,000 sits above the MFJ
    // threshold and 0.9% is due. This is the companion to the test above:
    // together they pin down exactly which income the surtax reaches.
    const r = calcCascade(sCorp, { ...individual, wages: 300_000 })
    expect(r.delta.additional_medicare).toBe(450)   // 0.9% × 50,000
  })

  it('warns rather than silently reporting a zero surtax on high wages', () => {
    // The guard exists so a regression in calc1040 cannot quietly drop
    // $1–2k of tax. With wages above the threshold the surtax must be
    // non-zero; if it ever is zero, the engine must say so out loud.
    const r = calcCascade(sCorp, { ...individual, wages: 300_000 })
    const silentlyZero = r.delta.additional_medicare === 0
      && !r.warnings.some(w => w.code === 'ADDMED_ZERO_DESPITE_HIGH_WAGES')
    expect(silentlyZero).toBe(false)
  })

  it('is deterministic — identical inputs give identical output', () => {
    const a = calcCascade(sCorp, individual)
    const b = calcCascade(sCorp, individual)
    expect(JSON.stringify(a.delta)).toBe(JSON.stringify(b.delta))
  })
})
