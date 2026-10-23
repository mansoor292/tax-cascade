import { describe, it, expect } from 'vitest'
import { maskTaxId, maskTaxIdsInText } from './mask'

describe('maskTaxId', () => {
  it('masks an SSN preserving its separator shape', () => {
    expect(maskTaxId('123-45-6789')).toBe('•••-••-6789')
  })
  it('masks an EIN preserving its separator shape', () => {
    expect(maskTaxId('12-3456789')).toBe('••-•••6789')
  })
  it('masks entirely when fewer than four digits', () => {
    expect(maskTaxId('12a')).toBe('•••')
  })
  it('handles empty and nullish input', () => {
    expect(maskTaxId('')).toBe('')
    expect(maskTaxId(null)).toBe('')
    expect(maskTaxId(undefined)).toBe('')
  })
  it('masks an unseparated digit string', () => {
    expect(maskTaxId('123456789')).toBe('•••••6789')
  })
})

describe('maskTaxIdsInText', () => {
  it('masks an EIN, an SSN and a bare nine-digit run inside prose', () => {
    expect(maskTaxIdsInText('Schedule L statement, EXAMPLE VENTURES INC 12-3456789 line 14'))
      .toBe('Schedule L statement, EXAMPLE VENTURES INC ••-•••6789 line 14')
    expect(maskTaxIdsInText('SSN 123-45-6789 and 123 45 6789')).toBe('SSN •••-••-6789 and ••• •• 6789')
    expect(maskTaxIdsInText('TIN 123456789.')).toBe('TIN •••••6789.')
  })
  it('leaves amounts, dates, phone numbers and IRS document locators alone', () => {
    const prose = 'Due 2026-12-11; 1,175,000 vs 1,245,000; call 866-860-4259; DLN 99999-123-45678-9; 2097888; 123456789.50'
    expect(maskTaxIdsInText(prose)).toBe(prose)
  })
  it('handles empty and nullish input', () => {
    expect(maskTaxIdsInText('')).toBe('')
    expect(maskTaxIdsInText(null)).toBe('')
  })
})
