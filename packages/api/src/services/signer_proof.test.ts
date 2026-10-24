/** A business signer's proof they belong to the business. Fictional names. */
import { describe, it, expect } from 'vitest'
import { entityNamesMatch, proofVerdict } from './signer_proof.js'

const ok = { diditStatus: 'Approved', einMatches: true, entityNameMatches: true, personMatches: true }

describe('proof of membership verdict', () => {
  it('accepted when the EIN is the client’s and the document names the signer', () => {
    expect(proofVerdict(ok)).toEqual({ status: 'approved', reason: null })
  })
  it('another business’s document is refused', () => {
    expect(proofVerdict({ ...ok, einMatches: false }).status).toBe('declined')
  })
  it('an altered document is refused', () => {
    expect(proofVerdict({ ...ok, diditStatus: 'Declined' }).status).toBe('declined')
  })
  it('held for review: no EIN read, someone else named, a different business name, unreadable parts', () => {
    expect(proofVerdict({ ...ok, einMatches: null }).status).toBe('review')
    expect(proofVerdict({ ...ok, personMatches: false }).reason).toMatch(/does not name the person/)
    expect(proofVerdict({ ...ok, entityNameMatches: false }).status).toBe('review')
    expect(proofVerdict({ ...ok, diditStatus: 'In Review' }).status).toBe('review')
  })
})

describe('business names', () => {
  it('ignore punctuation, case and the legal suffix', () => {
    expect(entityNamesMatch('Juniper Freight LLC', 'JUNIPER FREIGHT, L.L.C.')).toBe(true)
    expect(entityNamesMatch('Tallow & Pine Interiors', 'Tallow and Pine Interiors Inc')).toBe(true)
    expect(entityNamesMatch('Ostrander Millwork Inc', 'Ostrander Millwork Holdings Inc')).toBe(true)
  })
  it('differ when a significant word differs', () => {
    expect(entityNamesMatch('Juniper Freight LLC', 'Juniper Logistics LLC')).toBe(false)
    expect(entityNamesMatch('', 'Juniper Freight LLC')).toBe(false)
  })
})
