import { describe, it, expect } from 'vitest'
import { maskTaxId } from './mask'

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
