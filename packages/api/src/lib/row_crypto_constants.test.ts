/**
 * Drift guard for the encrypted-field specs. The specs and the derived
 * `*_ENC_COLS` select fragments must stay in lockstep — a column present in
 * the spec but missing from an explicit select makes hydrate() silently
 * no-op (it only acts on `*_enc` columns it can see on the row).
 */
import { describe, it, expect } from 'vitest'
import {
  ENCRYPTED_RETURN_FIELDS,
  ENCRYPTED_DOC_FIELDS,
  ENCRYPTED_ENTITY_FIELDS,
  RETURN_ENC_COLS,
  DOC_ENC_COLS,
  encCols,
} from './row_crypto.js'

describe('encrypted field specs', () => {
  it('the literal ENC_COLS constants match the specs exactly', () => {
    // The constants are literals (not encCols() calls) only because
    // supabase-js's select() type parser needs a string literal; this is
    // what stops them drifting from the specs.
    expect(RETURN_ENC_COLS).toBe(encCols(ENCRYPTED_RETURN_FIELDS))
    expect(DOC_ENC_COLS).toBe(encCols(ENCRYPTED_DOC_FIELDS))
  })

  it('covers the known encrypted columns', () => {
    expect(ENCRYPTED_RETURN_FIELDS.json).toEqual(
      ['input_data', 'computed_data', 'field_values', 'verification'],
    )
    expect(new Set(ENCRYPTED_DOC_FIELDS.json)).toEqual(new Set(['meta', 'textract_data']))
    expect(ENCRYPTED_ENTITY_FIELDS.text).toEqual(['ein'])
  })

  it('encCols handles mixed json+text specs', () => {
    expect(encCols({ json: ['a'], text: ['b'] })).toBe('a_enc, b_enc')
    expect(encCols({})).toBe('')
  })
})
