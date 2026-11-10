/**
 * Key scopes: a read-only key answers every GET and is refused at every
 * route that writes to QuickBooks or Stripe. See scopes.ts for why.
 */
import { describe, it, expect, vi } from 'vitest'
import { hasWriteScope, scopesFromRow, normalizeScopes, requireWrite, ALL_SCOPES } from './scopes.js'

describe('hasWriteScope', () => {
  it('allows * and write', () => {
    expect(hasWriteScope(['*'])).toBe(true)
    expect(hasWriteScope(['write'])).toBe(true)
    expect(hasWriteScope(['read', 'write'])).toBe(true)
  })

  it('refuses read-only, empty, and missing scope lists', () => {
    expect(hasWriteScope(['read'])).toBe(false)
    expect(hasWriteScope([])).toBe(false)
    expect(hasWriteScope(undefined)).toBe(false)
    expect(hasWriteScope(null)).toBe(false)
    expect(hasWriteScope('*' as any)).toBe(false)
  })
})

describe('scopesFromRow', () => {
  it('reads the stored list', () => {
    expect(scopesFromRow({ scopes: ['read'] })).toEqual(['read'])
  })

  it('grants everything when the column is missing or empty (pre-migration rows)', () => {
    expect(scopesFromRow({})).toEqual(ALL_SCOPES)
    expect(scopesFromRow({ scopes: [] })).toEqual(ALL_SCOPES)
    expect(scopesFromRow({ scopes: null })).toEqual(ALL_SCOPES)
    expect(scopesFromRow(null)).toEqual(ALL_SCOPES)
  })
})

describe('normalizeScopes', () => {
  it('defaults to * when nothing is asked for', () => {
    expect(normalizeScopes(undefined)).toEqual(['*'])
    expect(normalizeScopes(null)).toEqual(['*'])
  })

  it('accepts the three known values and de-duplicates', () => {
    expect(normalizeScopes(['read'])).toEqual(['read'])
    expect(normalizeScopes(['read', 'write', 'read'])).toEqual(['read', 'write'])
    expect(normalizeScopes(['*'])).toEqual(['*'])
  })

  it('refuses unknown values, empty lists, and non-arrays', () => {
    expect(() => normalizeScopes(['admin'])).toThrow(/unknown scope "admin"/)
    expect(() => normalizeScopes([])).toThrow(/non-empty array/)
    expect(() => normalizeScopes('read')).toThrow(/non-empty array/)
    expect(() => normalizeScopes([1])).toThrow(/unknown scope 1/)
  })
})

describe('requireWrite', () => {
  function run(apiKeyScopes: unknown) {
    const req: any = apiKeyScopes === undefined ? {} : { apiKeyScopes }
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    const next = vi.fn()
    requireWrite(req, res, next)
    return { res, next }
  }

  it('passes a writer through untouched', () => {
    for (const scopes of [['*'], ['write'], ['read', 'write']]) {
      const { res, next } = run(scopes)
      expect(next, JSON.stringify(scopes)).toHaveBeenCalledOnce()
      expect(res.status).not.toHaveBeenCalled()
    }
  })

  it('answers 403 with the one message for a read-only key', () => {
    const { res, next } = run(['read'])
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write scope required' })
  })

  it('fails closed when no scopes were set on the request at all', () => {
    const { res, next } = run(undefined)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })
})
