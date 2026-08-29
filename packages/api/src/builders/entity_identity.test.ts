import { describe, it, expect } from 'vitest'
import { entityIdentityFields } from './entity_identity.js'

describe('entityIdentityFields', () => {
  it('splits a joint 1040 name with shared surname', () => {
    const f = entityIdentityFields(
      { name: 'Alex & Sam Rivera', ein: '123-45-6789' }, '1040', {},
    )
    expect(f['meta.first_name']).toBe('Alex')
    expect(f['meta.spouse_first']).toBe('Sam')
    expect(f['meta.last_name']).toBe('Rivera')
    expect(f['meta.spouse_last']).toBe('Rivera')
    expect(f['meta.ssn']).toBe('123-45-6789')
  })

  it('splits an apartment off a 1040 address', () => {
    const f = entityIdentityFields(
      { name: 'Jo Doe', address: '12 Main St Apt 4B' }, '1040', {},
    )
    expect(f['meta.address']).toBe('12 Main St')
    expect(f['meta.apt']).toBe('4B')
  })

  it('splits a suite off a corporate address and builds city_state_zip', () => {
    const f = entityIdentityFields(
      { name: 'Acme Corp', ein: '12-3456789', address: '500 Ocean Dr Suite 210', city: 'Miami', state: 'FL', zip: '33139' },
      '1120S', {},
    )
    expect(f['meta.entity_name']).toBe('Acme Corp')
    expect(f['meta.ein']).toBe('12-3456789')
    expect(f['meta.address']).toBe('500 Ocean Dr')
    expect(f['meta.suite']).toBe('210')
    expect(f['meta.city_state_zip']).toBe('Miami, FL, 33139')
    expect(f['meta.country']).toBe('United States')
  })

  it('auto-fills total_assets from Schedule L EOY when meta lacks it', () => {
    const f = entityIdentityFields(
      { name: 'Acme Corp' }, '1120', { 'schedL.L15_total_eoy_d': 750_000 },
    )
    expect(f['meta.total_assets']).toBe(750_000)
    const g = entityIdentityFields(
      { name: 'Acme Corp', meta: { total_assets: 1 } }, '1120', { 'schedL.L15_total_eoy_d': 750_000 },
    )
    expect(g['meta.total_assets']).toBe(1)
  })

  it('returns empty for a missing entity', () => {
    expect(entityIdentityFields(null, '1120', {})).toEqual({})
  })
})
