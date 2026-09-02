/**
 * Grounding check for Gemini gap-fill.
 *
 * The anchor case is real (SOP-03, 2026-09-02): on a 2023 1040 whose OCR
 * had no line-16 value, Gemini returned 53,908 — derived as line 18
 * (54,586) minus Schedule 2 other taxes (678), a number that appears
 * nowhere on the filed PDF. groundFilled must reject exactly that class
 * of value while keeping values the document actually contains.
 */
import { describe, it, expect } from 'vitest'
import { groundFilled, groundingSet } from './gemini_gap_fill.js'

const CHRISTY_KVS = [
  { key: '15 Subtract line 14 from line 11 ... taxable income', value: '236,260.' },
  { key: '18 Add lines 16 and 17 18', value: '54,586.' },
  { key: '22 Subtract line 21 from line 18 ... 22', value: '54,586.' },
  { key: '23 Other taxes ... Schedule 2, line 21 23', value: '678.' },
  { key: '24 Add lines 22 and 23. This is your total tax 24', value: '55,264.' },
  { key: '25 Losses ...', value: '( 0. )' },
]

describe('groundingSet', () => {
  it('collects every number token, normalized to rounded magnitudes', () => {
    const set = groundingSet(CHRISTY_KVS)
    expect(set.has(236260)).toBe(true)
    expect(set.has(54586)).toBe(true)
    expect(set.has(678)).toBe(true)
    expect(set.has(55264)).toBe(true)
    expect(set.has(53908)).toBe(false)
  })

  it('handles parenthesized negatives, currency symbols, and multi-number values', () => {
    const set = groundingSet([
      { key: 'loss', value: '(1,500.)' },
      { key: 'mixed', value: 'Add lines 4, 7 through 16: $2,098' },
    ])
    expect(set.has(1500)).toBe(true)
    expect(set.has(2098)).toBe(true)
  })

  it('survives null/empty values', () => {
    expect(groundingSet([{ key: 'x', value: '' }, { key: 'y', value: null as any }]).size).toBe(0)
  })
})

describe('groundFilled', () => {
  it('rejects the SOP-03 fabricated line 16 and keeps document-present values', () => {
    const { grounded, rejected } = groundFilled(
      {
        'tax.L16_income_tax': 53908,     // Gemini's invention — not on the PDF
        'tax.L15_taxable_income': 236260, // present on the PDF
        'tax.L23_other_taxes': 678,       // present on the PDF
      },
      CHRISTY_KVS,
    )
    expect(rejected).toEqual({ 'tax.L16_income_tax': 53908 })
    expect(grounded).toEqual({ 'tax.L15_taxable_income': 236260, 'tax.L23_other_taxes': 678 })
  })

  it('always accepts zero (blank-line convention — zeros are not printed on the form)', () => {
    const { grounded, rejected } = groundFilled({ 'income.L6b_ss_taxable': 0 }, CHRISTY_KVS)
    expect(grounded).toEqual({ 'income.L6b_ss_taxable': 0 })
    expect(rejected).toEqual({})
  })

  it('grounds negatives by magnitude (parenthesized OCR, signed fill)', () => {
    const { grounded } = groundFilled(
      { 'income.L8_schedule1': -1500 },
      [{ key: 'Schedule 1 line 10', value: '(1,500.)' }],
    )
    expect(grounded).toEqual({ 'income.L8_schedule1': -1500 })
  })
})
