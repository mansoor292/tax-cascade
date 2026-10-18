/**
 * Tax IDs inside tax_entity.meta are sealed on write and opened on read.
 * On 2026-10-18 the joint 1040's spouse SSN and a brokerage payer EIN were
 * found readable in meta, right beside the encrypted EIN column. The IDs
 * below are made up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { _testOnlySetCachedDek, evictDek } from './crypto.js'
import { encryptedFields, hydrate, sealTaxIds, openTaxIds, ENCRYPTED_ENTITY_FIELDS, SEALED_PREFIX } from './row_crypto.js'

const meta = {
  spouse_first: 'Pat',
  spouse_ssn: '000-12-3456',
  accounting_method: 'cash',
  owners: [{ name: 'Sam Owner', ssn: '000-65-4321', pct: 100 }],
  investment_accounts: [{ payer: 'Broker', payer_ein: '00-0000001' }],
  preparer: { name: 'Self', firm_ein: '' },
  open_items_2025: { ez_advisors_separate_ein: { status: 'resolved', note: 'separate EIN' } },
}
const IDS = ['000-12-3456', '000-65-4321', '00-0000001']

describe('sealed tax IDs in entity meta', () => {
  const dek = randomBytes(32)
  const userId = 'user-sealed-test'
  const env = { ...process.env }
  beforeAll(() => {
    process.env.TAX_API_KMS_KEY = 'test'
    process.env.TAX_API_BLIND_HMAC = 'test'
    _testOnlySetCachedDek(userId, dek)
  })
  afterAll(() => { evictDek(userId); process.env = env })

  it('seals every tax ID at any depth and nothing else', () => {
    const sealed = sealTaxIds(dek, meta)
    const text = JSON.stringify(sealed)
    for (const id of IDS) expect(text).not.toContain(id)
    expect(sealed.spouse_ssn.startsWith(SEALED_PREFIX)).toBe(true)
    expect(sealed.owners[0].ssn.startsWith(SEALED_PREFIX)).toBe(true)
    expect(sealed.owners[0].name).toBe('Sam Owner')
    expect(sealed.accounting_method).toBe('cash')
    expect(sealed.preparer.firm_ein).toBe('')
    expect(sealed.open_items_2025).toEqual(meta.open_items_2025)
    expect(openTaxIds(dek, sealed)).toEqual(meta)
  })

  it('does not seal twice', () => {
    const once = sealTaxIds(dek, meta)
    expect(sealTaxIds(dek, once)).toEqual(once)
  })

  it('a meta write stores sealed values and a read opens them', async () => {
    const out = await encryptedFields({} as any, userId, { meta }, ENCRYPTED_ENTITY_FIELDS)
    for (const id of IDS) expect(JSON.stringify(out.meta)).not.toContain(id)
    // An EIN-only write leaves meta alone.
    expect((await encryptedFields({} as any, userId, { ein: '00-0000002' }, ENCRYPTED_ENTITY_FIELDS)).meta).toBeUndefined()
    const row: any = { user_id: userId, meta: out.meta }
    await hydrate({} as any, row, ENCRYPTED_ENTITY_FIELDS)
    expect(row.meta).toEqual(meta)
  })
})
