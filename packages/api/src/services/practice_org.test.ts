/**
 * A practice reading through an org of its own (2026-10-27, the Better Choice
 * Lenders practice): an IRS request outside a claimed client's recorded
 * authorization is refused before it reaches the IRS. BCL's 8821s cover Form
 * 941 only, while its TaxNow record lists income forms too.
 */
import { describe, it, expect } from 'vitest'
import { formsOutsideScope } from './practice.js'

const q = (...forms: string[]) => forms.map(form => ({ form }))

describe('formsOutsideScope', () => {
  const bcl = { income: [], payroll: ['941'], imported: true }

  it('lets a claimed client ask for what its 8821 covers', () => {
    expect(formsOutsideScope(bcl, q('941', '941'))).toEqual([])
  })

  it('refuses every other form, once each', () => {
    expect(formsOutsideScope(bcl, q('941', '1120', '940', '1120'))).toEqual(['1120', '940'])
  })

  it('reads an S-corp scope as the 1120 module its transcripts live in', () => {
    expect(formsOutsideScope({ income: ['1120S'], payroll: [], imported: true }, q('1120'))).toEqual([])
  })

  it('leaves clients onboarded in Catipult to their own 8821', () => {
    expect(formsOutsideScope({ income: true, payroll: ['941'] }, q('1120'))).toEqual([])
    expect(formsOutsideScope(null, q('1120'))).toEqual([])
  })
})
