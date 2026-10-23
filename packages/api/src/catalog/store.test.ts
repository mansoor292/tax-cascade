/**
 * Which catalog a stored document becomes. The year's 'filed_return' catalog
 * is the return as filed everywhere (Compare, the checks, the amendment base),
 * so an amended return must never land there: until 2026-10-23 a 1040-X sent
 * through the catalog route did, and could stand in for the original.
 */
import { describe, it, expect } from 'vitest'
import { kindForDocType } from './store.js'

describe('kindForDocType', () => {
  it('an amended return is its own kind', () => {
    expect(kindForDocType('prior_return_1040x')).toBe('amended_return')
    expect(kindForDocType('amended_return')).toBe('amended_return')
  })

  it('an original return, a transcript and a notice keep theirs', () => {
    expect(kindForDocType('prior_return_1120s')).toBe('filed_return')
    expect(kindForDocType('prior_return_1040')).toBe('filed_return')
    expect(kindForDocType('tax_transcript')).toBe('irs_transcript')
    expect(kindForDocType('irs_notice')).toBe('irs_notice')
    expect(kindForDocType(null)).toBe('other')
  })
})
