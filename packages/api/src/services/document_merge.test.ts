/**
 * Source documents → engine inputs (moved out of compute_return.ts
 * 2026-10-20). Pins the rules the compute path and the golden view share.
 */
import { describe, it, expect } from 'vitest'
import { mergeDocuments } from './document_merge.js'

const doc = (doc_type: string, key_values: Record<string, string | number>) => ({ doc_type, meta: { key_values } })
function run(docs: any[], form_type: string, given: Record<string, any> = {}) {
  const mergedInputs: Record<string, any> = { ...given }
  const autoMergeLog: Array<{ field: string; value: number; sources: string[]; confidence?: string }> = []
  const setIfUnset = (field: string, value: number, sourceType: string, count: number, confidence?: string) => {
    if (value && (mergedInputs[field] === undefined || mergedInputs[field] === null)) {
      mergedInputs[field] = value
      autoMergeLog.push({ field, value, sources: [`${count} × ${sourceType}`], confidence })
    }
  }
  mergeDocuments(docs, form_type, { mergedInputs, setIfUnset, autoMergeLog })
  return { inputs: mergedInputs, log: autoMergeLog }
}

describe('source documents → engine inputs', () => {
  it('a 1040: W-2s, 1099s and K-1s land on their inputs; amounts parse', () => {
    const { inputs } = run([
      doc('w2', { box_1: '$100,000.00', box_2: '15,000' }), doc('w2', { wages: 20000 }),
      doc('1099_int', { box_1: '1,234' }), doc('1099_div', { box_1a: 500, box_1b: 300 }),
      doc('1099_b', { net_gain_loss: -2000 }), doc('k1', { box_1: 50000, w2_wages: 120000 }),
    ], '1040')
    expect(inputs).toMatchObject({ wages: 120000, withholding: 15000, taxable_interest: 1234, ordinary_dividends: 500, qualified_dividends: 300, capital_gains: -2000, k1_ordinary_income: 50000, schedule1_income: 50000, k1_w2_wages: 120000 })
  })

  it('caller-provided values win, explicit 0 included', () => {
    const { inputs, log } = run([doc('w2', { box_1: 100000 })], '1040', { wages: 0 })
    expect(inputs.wages).toBe(0)
    expect(log).toEqual([])
  })

  it('a 1098 is never auto-placed, only logged; a generic 1099 box 1 is not interest', () => {
    const { inputs, log } = run([doc('1098', { box_1: 22000 }), doc('1099', { box_1: 22000 })], '1040')
    expect(inputs.taxable_interest).toBeUndefined()
    expect(log.find(l => l.field === 'itemized_deductions')?.sources[0]).toContain('NOT auto-placed')
  })

  it('brokerage 1099s go to Schedule K on an S corp and to page 1 on a C corp', () => {
    expect(run([doc('1099_int', { box_1: 900 }), doc('1099_oid', { box_1: 100 })], '1120S').inputs.schedule_k_interest).toBe(1000)
    expect(run([doc('1099_int', { box_1: 900 })], '1120').inputs.interest_income).toBe(900)
  })
})
