/**
 * An amendment starts from the filed return (2026-10-22): its figures,
 * whatever names they are stored under, mapped back to the engine's inputs.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import { goldenValues, baseInputs, catalogValues, differsFromBase } from './amendment_base.js'

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

  it('names the lines the engine computes differently from how they were filed', () => {
    expect(differsFromBase({ a: 100, b: 50, c: 7 }, { a: 100.4, b: 52, d: 1 })).toEqual(['b'])
  })
})
