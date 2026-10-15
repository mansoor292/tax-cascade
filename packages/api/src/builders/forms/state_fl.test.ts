/**
 * Florida F-1120 overlay on the Department's flat form. Synthetic corporation only.
 *
 * The form has no fields to read back, so these check the builder's refusals
 * and the layout contract it draws from. Where the digits actually land is
 * checked against the filed return by scripts/parity/pdf_parity.py.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildFlF1120 } from './state_fl.js'
import { FL_COMB, FL_CELLS, FL_TICKS, FL_AMOUNTS, FL_TEXT } from './state_fl_layout_2025.js'
import type { AttachmentContext } from './types.js'

function ctx(inputData: Record<string, any>, over: Partial<AttachmentContext> = {}): AttachmentContext {
  return {
    formType: '1120', taxYear: 2025, model: {}, computedData: {},
    entity: { name: 'Example Widgets Inc', ein: '00-0000001', address: '1 Main St', city: 'Anytown', state: 'FL', zip: '00000' },
    inputData, ...over,
  }
}

describe('FL F-1120 builder', () => {
  it('renders nothing without Florida data, and refuses an unverified year', async () => {
    expect(await buildFlF1120(ctx({}))).toBeNull()
    expect(await buildFlF1120(ctx({ state_fl_f1120: { L1: 1 } }, { taxYear: 2024 }))).toBeNull()
  })

  it('draws the six-page official form', async () => {
    const a = await buildFlF1120(ctx({ state_fl_f1120: { L1: 123456, L9: 50000, L17: -895, L_federal_return: '1120' } }))
    expect(a?.label).toBe('FL F-1120')
    const round = await PDFDocument.load(await a!.pdf.save())
    expect(round.getPageCount()).toBe(6)
    expect(a!.filled).toBeGreaterThanOrEqual(4)
  })

  it('refuses an amount wider than its boxes rather than dropping digits', async () => {
    // line 9 has five dollar boxes
    await expect(buildFlF1120(ctx({ state_fl_f1120: { L9: 1234567 } }))).rejects.toThrow(/L9/)
  })

  it('refuses an answer the form has no box for', async () => {
    await expect(buildFlF1120(ctx({ state_fl_f1120: { L_federal_return: '1065' } }))).rejects.toThrow(/L_federal_return/)
  })

  it('has a box row for every amount line 1-19 and the coupon, inside the page', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
      const row = FL_COMB[`L${n}`]
      expect(row, `L${n}`).toBeDefined()
      expect(row.cents).toHaveLength(2)
      for (const x of [...row.dollars, ...row.cents]) expect(x).toBeGreaterThan(0)
      // dollar boxes are evenly pitched and strictly left of the cents
      expect(Math.max(...row.dollars)).toBeLessThan(Math.min(...row.cents))
    }
    for (const k of ['coupon_amount_due', 'coupon_credit', 'coupon_refund']) expect(FL_COMB[k]).toBeDefined()
    expect(FL_CELLS.fein.xs).toHaveLength(9)
    expect(FL_CELLS.E_activity_code.xs).toHaveLength(6)
  })

  it('keys every schedule line once and keeps every position on its page', () => {
    for (let n = 1; n <= 26; n++) expect(FL_AMOUNTS[`schedI_L${n}`]).toBeDefined()
    for (let n = 1; n <= 25; n++) expect(FL_AMOUNTS[`schedV_L${n}`]).toBeDefined()
    for (const spec of [...Object.values(FL_AMOUNTS), ...Object.values(FL_TEXT), ...Object.values(FL_TICKS)]) {
      expect(spec.page).toBeGreaterThanOrEqual(1)
      expect(spec.page).toBeLessThanOrEqual(6)
      expect(spec.x).toBeGreaterThan(0)
      expect(spec.x).toBeLessThan(612)
      expect(spec.base).toBeGreaterThan(0)
      expect(spec.base).toBeLessThan(792)
    }
  })
})
