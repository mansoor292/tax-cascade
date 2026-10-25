/**
 * A practice reads an account only on its own 8821 (2026-10-25). Every 8821
 * names the platform's one CAF, so a TIN search hit is not proof that THIS
 * practice's 8821 went in.
 */
import { describe, it, expect } from 'vitest'
import { readableVerdict } from './practice.js'

const base = { accountId: 'acct-new', accountsAtSubmit: ['acct-a', 'acct-b'], heldElsewhere: false, submissionConfirmedAt: null }

describe('readableVerdict', () => {
  it('an account that appeared after the submission, held by nobody else, is readable', () => {
    expect(readableVerdict(base)).toBe('readable')
  })
  it('another practice holding the account means waiting for proof', () => {
    expect(readableVerdict({ ...base, heldElsewhere: true })).toBe('awaiting_proof')
  })
  it('an account the org already listed at submission means waiting for proof', () => {
    expect(readableVerdict({ ...base, accountId: 'acct-a' })).toBe('awaiting_proof')
  })
  it('a client submitted before the snapshot existed waits for proof', () => {
    expect(readableVerdict({ ...base, accountsAtSubmit: null })).toBe('awaiting_proof')
  })
  it('proof that this 8821 went in makes it readable even when another practice reads it too', () => {
    expect(readableVerdict({ ...base, accountId: 'acct-a', heldElsewhere: true, submissionConfirmedAt: '2026-10-25T12:00:00Z' })).toBe('readable')
  })
})
