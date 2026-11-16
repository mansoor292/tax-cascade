/**
 * Single-member LLC as its own entity (owner decision 2026-11-16): its
 * Schedule C, and how the profit lands on the owner's 1040. Fictional figures.
 */
import { describe, it, expect } from 'vitest'
import { calcScheduleC, scheduleSE } from './schedule_c.js'
import { calc1040 } from './tax_engine.js'
import { classifyKey } from '../schema/validate.js'
import { corporateInputsToScheduleC } from '../maps/qbo_to_schedule_c.js'

describe('Schedule C', () => {
  it('computes line 31 with half of meals deductible', () => {
    const r = calcScheduleC({ gross_receipts: 200_000, cost_of_goods_sold: 20_000, advertising: 5_000, meals: 4_000, rents: 12_000,
      other_expenses_detail: [{ label: 'Software', amount: 3_000 }] })
    const fv = r.field_values
    expect(fv['schedC.L7_gross_income']).toBe(180_000)
    expect(fv['schedC.L24b_meals']).toBe(2_000)
    expect(fv['schedC.L27b_other_expenses']).toBe(3_000)
    expect(fv['schedC.L28_total_expenses']).toBe(22_000)
    expect(fv['schedC.L31_net_profit']).toBe(158_000)
    expect(Object.keys(fv).filter(k => classifyKey('SchC', k) === 'rejected')).toEqual([])
  })
})

describe('Schedule SE per person', () => {
  it('reduces the social security base by that person\'s own W-2 wages', () => {
    const none = scheduleSE(100_000, 0, 2025)
    expect(none.lines.L4a).toBe(92_350)
    expect(none.se_tax).toBe(Math.round(92_350 * 0.124) + Math.round(92_350 * 0.029))
    const withWages = scheduleSE(100_000, 150_000, 2025)
    // 176,100 − 150,000 = 26,100 left for the 12.4% part
    expect(withWages.lines.L9).toBe(26_100)
    expect(withWages.lines.L10).toBe(Math.round(26_100 * 0.124))
  })
  it('is zero under $400 of net earnings', () => {
    expect(scheduleSE(300, 0, 2025).se_tax).toBe(0)
  })
})

describe('1040 with a linked Schedule C', () => {
  const base = { filing_status: 'mfj', tax_year: 2025, is_sstb: false } as any
  it('puts the profit on Schedule 1 line 3 and figures SE for the owner, net of their wages', () => {
    const r = calc1040({ ...base,
      w2s: [{ owner: 'spouse', box1: 150_000, box2: 20_000, box3: 150_000, box5: 150_000 }],
      schedule_c: [{ name: 'Fictional Studio LLC', owner: 'spouse', net_profit: 100_000 }] })
    const fv = r.field_values!
    expect(fv['sched1.L3_business_income']).toBe(100_000)
    expect(fv['income.L8_schedule1']).toBe(100_000)
    expect(fv['f1040sse.L9_subtract']).toBe(26_100)
    const se = Math.round(26_100 * 0.124) + Math.round(92_350 * 0.029)
    expect(fv['sched2.L4_se_tax']).toBe(se)
    expect(fv['sched1.L15_se_tax_deduction']).toBe(Math.round(se * 0.5))
    expect(fv['f8995a.L2_qbi']).toBe(100_000 - Math.round(se * 0.5))
    expect(Object.keys(fv).filter(k => classifyKey('1040', k) === 'rejected')).toEqual([])
  })
  it('without a Schedule C nothing changes', () => {
    const fv = calc1040({ ...base, wages: 80_000 }).field_values!
    expect(fv['sched1.L3_business_income']).toBeUndefined()
    expect(fv['sched2.L4_se_tax']).toBeUndefined()
  })
})

describe('QuickBooks onto Schedule C', () => {
  it('carries expenses and refuses owner pay, charity and investment income', () => {
    const t = corporateInputsToScheduleC({ gross_receipts: 100, salaries_wages: 10, officer_compensation: 50, charitable_contrib: 5, schedule_k_interest: 3, other_deductions: 7, 'schedL.L1_cash_eoy_d': 9 })
    expect(t.inputs).toEqual({ gross_receipts: 100, wages: 10, other_expenses: 7 })
    expect(t.warnings.map(w => w.code)).toEqual(['NOT_SCHEDULE_C', 'NOT_SCHEDULE_C', 'NOT_SCHEDULE_C'])
  })
})
