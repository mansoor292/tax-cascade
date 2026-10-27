/** The signer's identity check: when it counts as verified. Fictional names. */
import { describe, it, expect } from 'vitest'
import { envFor, lookupRetryable, nameMatches, normalizeSsn, restartBlocked, returnOrigin, verdict } from './signer_idv.js'

const lookup = (identification_number: string, match_type = 'full_match') => ({ status: 'Approved', match_type, validations: { identification_number, full_name: 'full_match' }, services_used: ['usa_states_credit_bureau'] })

describe('signer identity verdict', () => {
  it('verified only when Didit approves, the names agree and the SSN is confirmed', () => {
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: lookup('full_match'), ssnMatchesTaxpayer: null })).toEqual({ status: 'approved', reason: null })
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: lookup('full_match'), ssnMatchesTaxpayer: true }).status).toBe('approved')
  })
  it('an SSN the records do not confirm is not verified', () => {
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: lookup('no_match', 'no_match'), ssnMatchesTaxpayer: null }).status).toBe('declined')
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: lookup('partial_match', 'partial_match'), ssnMatchesTaxpayer: null }).status).toBe('review')
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: null, ssnMatchesTaxpayer: null }).status).toBe('review')
  })
  it('an individual’s signer must give the taxpayer’s own SSN', () => {
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: lookup('full_match'), ssnMatchesTaxpayer: false }).status).toBe('declined')
  })
  it('the ID must carry the name that was signed', () => {
    expect(verdict({ diditStatus: 'Approved', nameMatchesSigner: false, lookup: lookup('full_match'), ssnMatchesTaxpayer: null }).status).toBe('review')
  })
  it('Didit’s own refusals and abandoned checks', () => {
    expect(verdict({ diditStatus: 'Declined', nameMatchesSigner: true, lookup: null, ssnMatchesTaxpayer: null }).status).toBe('declined')
    expect(verdict({ diditStatus: 'Abandoned', nameMatchesSigner: false, lookup: null, ssnMatchesTaxpayer: null }).reason).toMatch(/did not finish/)
    expect(verdict({ diditStatus: 'In Review', nameMatchesSigner: true, lookup: null, ssnMatchesTaxpayer: null }).status).toBe('review')
  })
})

describe('signer identity inputs', () => {
  it('names: first and last from the ID, middle names may differ', () => {
    expect(nameMatches('Pat Q. Example', { first_name: 'PAT', last_name: 'EXAMPLE' })).toBe(true)
    expect(nameMatches('Pat Example', { first_name: 'Pat', last_name: 'Example Sample' })).toBe(true)
    expect(nameMatches('Pat Example', { full_name: 'Pat Quinn Example' })).toBe(true)
    expect(nameMatches('Dana Example', { first_name: 'Pat', last_name: 'Example' })).toBe(false)
    expect(nameMatches('José Muñoz', { first_name: 'JOSE', last_name: 'MUNOZ' })).toBe(true)
  })
  it('SSNs: nine digits, never an impossible one', () => {
    expect(normalizeSsn('123-45-6789')).toBe('123456789')
    expect(normalizeSsn('123 45 6789')).toBe('123456789')
    for (const bad of ['12345678', '000-12-3456', '666123456', '900123456', '123-00-4567', '123-45-0000', 'abc']) expect(normalizeSsn(bad)).toBeNull()
  })
  it('the demo practice runs in the sandbox, every other practice live — but a test client always in the sandbox', () => {
    expect(envFor({ provider: 'fixture' })).toBe('sandbox')
    expect(envFor({ provider: 'taxnow' })).toBe('live')
    expect(envFor({ provider: 'taxnow' }, { test: false })).toBe('live')
    expect(envFor({ provider: 'taxnow' }, { test: true })).toBe('sandbox')
  })
  it('Didit returns the signer only to our own pages', () => {
    expect(returnOrigin('https://fin.catipult.ai')).toBe('https://fin.catipult.ai')
    expect(returnOrigin('https://p5173.dev.catalogshub.com')).toBe('https://p5173.dev.catalogshub.com')
    expect(returnOrigin('https://evil.example')).toBe(process.env.API_BASE_URL || 'https://fin.catipult.ai')
    expect(returnOrigin(undefined)).toBe(process.env.API_BASE_URL || 'https://fin.catipult.ai')
  })
})

// 2026-10-27: a live test signer came back from Didit approved, was shown the
// form again, resubmitted, and the new session replaced the approved one. The
// SSN they typed was made up; a lookup Didit refuses must end the check with a
// reason, not leave it "started" forever.
describe('a check that may still finish', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  it('is never replaced once Didit has it, nor while Didit reviews it', () => {
    for (const didit_status of ['Approved', 'In Progress', 'Resubmitted', 'Awaiting User']) expect(restartBlocked({ status: 'started', didit_status, started_at: at(2) })).toMatch(/still finishing/)
    expect(restartBlocked({ status: 'started', didit_status: 'In Review', started_at: at(120) })).toMatch(/closer look/)
  })
  it('may be started again when the signer never got going, or left it for half an hour', () => {
    for (const didit_status of ['Not Started', 'Abandoned', 'Expired']) expect(restartBlocked({ status: 'started', didit_status, started_at: at(1) })).toBeNull()
    expect(restartBlocked({ status: 'started', didit_status: 'In Progress', started_at: at(31) })).toBeNull()
    expect(restartBlocked({ status: 'declined', didit_status: 'Approved', started_at: at(1) })).toBeNull()
  })
  it('a lookup Didit refuses ends as a decline that says why; only outages are retried', () => {
    const v = verdict({ diditStatus: 'Approved', nameMatchesSigner: true, lookup: null, ssnMatchesTaxpayer: null, lookupRefused: true })
    expect(v.status).toBe('declined')
    expect(v.reason).toMatch(/SSN entered could not be checked/)
    expect([400, 404, 422].map(lookupRetryable)).toEqual([false, false, false])
    expect([429, 500, 502, 503].map(lookupRetryable)).toEqual([true, true, true, true])
  })
})
