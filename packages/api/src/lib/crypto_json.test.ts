/**
 * JSON columns must round-trip every JSON value, including a bare string —
 * tax_fact answers like "cash" or "2021-10-25" read back as null in
 * production because encrypt() stored them as raw text and decryptJson
 * threw on JSON.parse (2026-10-17).
 */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt, decryptJson } from './crypto.js'

describe('decryptJson', () => {
  const dek = randomBytes(32)
  it('round-trips values written as JSON', () => {
    for (const v of ['cash', '2021-10-25', 42, true, null, [{ a: 1 }], { b: 'x' }]) {
      expect(decryptJson(dek, encrypt(dek, JSON.stringify(v)))).toEqual(v)
    }
  })
  it('reads a string stored raw by an older writer', () => {
    expect(decryptJson(dek, encrypt(dek, 'cash'))).toBe('cash')
  })
  it('objects encrypted directly still parse', () => {
    expect(decryptJson(dek, encrypt(dek, { k: [1, 2] }))).toEqual({ k: [1, 2] })
  })
})
