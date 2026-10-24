/**
 * An amendment starts from the filed return (2026-10-22): its figures,
 * whatever names they are stored under, mapped back to the engine's inputs.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import { goldenValues, baseInputs, catalogValues, differsFromBase, carriedLines, carryFiledLines } from './amendment_base.js'
import { deriveSupportingSchedules } from './reconciliation.js'
import { calc1120S } from '../engine/tax_engine.js'

let n = 0
const e = (form: string, canonical: string, value: number, instance = ''): CatalogEntry => ({
  id: `e${++n}`, form, title: form, rev: '2024', instance, page: 1, section: '', line: '', label: '', desc: '',
  kind: 'amount', value, raw: String(value), method: 'geometry', canonical,
})

describe('amendment base', () => {
  it('reads stored figures under any alias as golden keys', () => {
    const v = goldenValues('1120S', { 'income.L1a_gross_receipts': 900, 'deductions.L7_officer_comp': 60, 'meta.name': 'x' as unknown as number })
    expect(v['income.L1a_gross_receipts']).toBe(900)
    expect(Object.values(v)).toContain(60)
    expect(Object.keys(v)).not.toContain('meta.name')
  })

  it('maps the filed figures back to the engine inputs, Schedule K included', () => {
    const inputs = baseInputs('1120S', { 'income.L1a_gross_receipts': 900, 'schedK.L4_interest': 12, 'schedK.L16d_distributions': 300 })
    expect(inputs).toMatchObject({ gross_receipts: 900, schedule_k_interest: 12, schedule_k_distributions: 300 })
    expect(inputs).not.toHaveProperty('tax_year')
  })

  it('takes a catalogued return once: no second printed copy, no K-1s', () => {
    const v = catalogValues([
      e('f1120s', 'income.L1a_gross_receipts', 900),
      e('f1120s', 'income.L1a_gross_receipts', 1, 'copy2'),
      e('f1120ssk', 'k1.L1_ordinary', 5),
    ])
    expect(v['income.L1a_gross_receipts']).toBe(900)
    expect(Object.keys(v)).toHaveLength(1)
  })

  it('names the lines the engine computes differently from how they were filed, and the lines it lost', () => {
    expect(differsFromBase({ a: 100, b: 50, c: 7, z: 0 }, { a: 100.4, b: 52, d: 1 })).toEqual(['b', 'c'])
  })

  // 2026-10-24: an amendment of the demo's filed 2022 1120-S kept only what
  // the engine computes — cost of goods sold detail, the charitable
  // contribution, Schedule L and the M-1/M-2 lines were gone. Demo figures.
  describe('the filed lines the engine does not compute', () => {
    const filed = {
      'income.L1a_gross_receipts': 2_300_000, 'income.L2_cogs': 1_201_000, 'deductions.L7_officer_comp': 42_000,
      'cogs.L2_purchases': 1_201_000, 'cogs.L6_total': 1_201_000, 'cogs.L8_cogs': 1_201_000,
      'schedK.L12a_cash_charity': 5_200, 'schedK.L16d_distributions': 995_000,
      'schedL.L25_retained_eoy_d': 9_610, 'schedL.L26_adj_eoy_d': 702_623, 'schedL.L28_total_eoy_d': 1_011_133,
      'schedM2.L1_beg_balance': 705, 'schedM2.L3_other_additions': 0, 'schedM2.L5_other_reductions': 5_200, 'schedM2.L7_distributions': 995_000,
      'f1125e.L2_total_compensation_officers': 42_000,
      'schedM1.L1_net_income_books': 1_051_800,
    }

    it('are carried as filed, except the M-2 lines Schedule K decides', () => {
      const carry = carriedLines('1120S', filed)
      expect(carry).toMatchObject({ 'cogs.L2_purchases': 1_201_000, 'schedK.L12a_cash_charity': 5_200, 'schedL.L26_adj_eoy_d': 702_623, 'schedM2.L1_beg_balance': 705, 'f1125e.L2_total_compensation_officers': 42_000 })
      expect(Object.keys(carry)).not.toContain('schedM2.L3_other_additions')
      expect(Object.keys(carry)).not.toContain('schedM2.L7_distributions')
      expect(carriedLines('1040', filed)).toEqual({})
    })

    it('survive the recompute, and the M-2 follows a Schedule K line the amendment adds', () => {
      const inputs = { ...baseInputs('1120S', filed), schedule_k_interest: 2_109, schedule_k_dividends_ordinary: 803, amend_carry: carriedLines('1120S', filed) }
      const engine = calc1120S(inputs as any)
      const fv = { ...(engine.field_values ?? {}) } as Record<string, any>
      carryFiledLines(fv, inputs.amend_carry, '1120S')
      deriveSupportingSchedules('1120S', fv, inputs, 2022, engine.computed)
      expect(fv['cogs.L2_purchases']).toBe(1_201_000)
      expect(fv['schedK.L12a_charitable']).toBe(5_200)          // the engine's own key for line 12a, from its input
      expect(fv['schedL.L26_adj_eoy_d']).toBe(702_623)
      expect(fv['f1125e.L2_total_compensation_officers']).toBe(42_000)
      expect(fv['schedK.L4_interest']).toBe(2_109)
      expect(fv['schedM2.L3_other_additions']).toBe(2_912)     // 2,109 + 803, not the filed 0
      expect(fv['schedM2.L7_distributions']).toBe(995_000)
      // M-1: the books figure as filed, not the engine's stand-in; its totals re-derived from it.
      expect(fv['schedM1.L1_net_income_books']).toBe(1_051_800)
      expect(fv['schedM1.L4_add']).toBe(1_051_800)
      expect(fv['schedM1.L8_income_K18']).toBe(1_051_800)
    })

    it('a return computed without books keeps an M-1 that adds up', () => {
      const engine = calc1120S({ gross_receipts: 100_000 } as any)
      const fv = { ...(engine.field_values ?? {}) } as Record<string, any>
      deriveSupportingSchedules('1120S', fv, {}, 2025, engine.computed)
      expect(fv['schedM1.L4_add']).toBe(fv['schedM1.L1_net_income_books'])
      expect(fv['schedM1.L8_income_K18']).toBe(fv['schedM1.L1_net_income_books'])
      expect(fv['schedM1.L8_income_K18']).toBe(100_000)
    })

    it('Schedule K line 18 subtracts the charitable contribution and section 179', () => {
      const fv = calc1120S({ gross_receipts: 100_000, charitable_contrib: 5_200, section_179: 1_000, schedule_k_interest: 2_109 } as any).field_values as Record<string, number>
      expect(fv['schedK.L18_income_loss']).toBe(fv['schedK.L1_ordinary'] + 2_109 - 1_000 - 5_200)
    })

    it('never overwrite a line the engine computed', () => {
      const fv: Record<string, unknown> = { 'income.L1a_gross_receipts': 2_250_000 }
      carryFiledLines(fv, { 'income.L1a_gross_receipts': 2_300_000, 'cogs.L2_purchases': 5 }, '1120S')
      expect(fv).toEqual({ 'income.L1a_gross_receipts': 2_250_000, 'cogs.L2_purchases': 5 })
    })
  })
})
