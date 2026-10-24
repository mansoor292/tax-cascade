/** The signer's identity check: when it counts as verified. Fictional names. */
import { describe, it, expect } from 'vitest'
import { envFor, nameMatches, normalizeSsn, returnOrigin, verdict } from './signer_idv.js'

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
  it('the demo practice runs in the sandbox, every other practice live', () => {
    expect(envFor({ provider: 'fixture' })).toBe('sandbox')
    expect(envFor({ provider: 'taxnow' })).toBe('live')
  })
  it('Didit returns the signer only to our own pages', () => {
    expect(returnOrigin('https://fin.catipult.ai')).toBe('https://fin.catipult.ai')
    expect(returnOrigin('https://p5173.dev.catalogshub.com')).toBe('https://p5173.dev.catalogshub.com')
    expect(returnOrigin('https://evil.example')).toBe(process.env.API_BASE_URL || 'https://fin.catipult.ai')
    expect(returnOrigin(undefined)).toBe(process.env.API_BASE_URL || 'https://fin.catipult.ai')
  })
})
