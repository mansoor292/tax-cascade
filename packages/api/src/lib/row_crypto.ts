/**
 * Row-level envelope encryption for sensitive columns across multiple
 * tables (tax_entity, tax_return, document, qbo_connection...).
 *
 * Write pattern: caller keeps the plaintext column in the payload and
 *   spreads `...await encryptedFields(supabase, userId, payload, {json, text})`
 *   into the insert/update. That spread now carries `field: null` alongside
 *   `field_enc`, so the readable copy is removed as the row is written. The
 *   dual-write it used to perform is behind TAX_API_WRITE_PLAINTEXT=1.
 *
 * Read pattern: caller awaits `hydrate(supabase, row, {json, text, userId})`
 *   right after a .select(). For each `*_enc` column that's populated, the
 *   decrypted value is written back onto the plain property name on the
 *   row in-memory — so downstream code reading `row.field_values` etc.
 *   sees the decrypted content and doesn't need refactoring.
 *
 * Fallback: if encryption isn't enabled (TAX_API_KMS_KEY unset) or
 * decryption fails for any reason, the plaintext column is left in place
 * and a warning is logged. Requests never fail due to crypto issues.
 *
 * Note that this fallback is why the stalled transition stayed invisible: with
 * the readable copy present, the system behaved identically whether or not
 * encryption was working. Post-cutover there is no plaintext to fall back to,
 * so a decrypt failure now surfaces as missing data rather than silence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, decryptJson, decryptString, getDek, bytea, byteaWrite } from './crypto.js'

export function encryptionEnabled(): boolean {
  return !!process.env.TAX_API_KMS_KEY
}

/**
 * Whether to keep writing the readable copy alongside the ciphertext.
 *
 * This was the transition setting, and it stayed on far longer than intended:
 * every encrypted column still had a plaintext twin, so a database dump gave
 * up cleartext returns and EINs despite the encryption being in place.
 *
 * Now off. Every caller spreads this function's result over its own payload
 * AFTER the plaintext keys, so returning `field: null` here removes the
 * readable copy at the point of writing, without touching 12 call sites.
 *
 * Only the fields actually being written are nulled — nulling every field in
 * the spec would wipe columns an UPDATE never intended to touch.
 *
 * Set TAX_API_WRITE_PLAINTEXT=1 to restore the old behaviour if a rollback is
 * ever needed; nothing reads the plaintext column any more, so this is a
 * safety valve rather than a supported mode.
 */
export function writePlaintext(): boolean {
  return process.env.TAX_API_WRITE_PLAINTEXT === '1'
}

export interface FieldSpec {
  /** JSONB columns — encrypted payload is JSON.stringified */
  json?:  string[]
  /** Plain text columns — encrypted payload is the UTF-8 string */
  text?:  string[]
}

/**
 * The per-table field specs, defined ONCE. These used to be re-declared in
 * every route file (returns, scenarios, documents, intake, entities — the
 * doc spec even existed in two different orders), which is exactly how a
 * fifth encrypted column gets added to one copy and not another.
 */
export const ENCRYPTED_RETURN_FIELDS: FieldSpec = {
  json: ['input_data', 'computed_data', 'field_values', 'verification'],
}
export const ENCRYPTED_DOC_FIELDS: FieldSpec = { json: ['meta', 'textract_data'] }
export const ENCRYPTED_ENTITY_FIELDS: FieldSpec = { text: ['ein'] }

/**
 * Ciphertext sibling columns for selects that name columns explicitly.
 * hydrate() only acts when it can SEE a `*_enc` column on the row, so a
 * select that lists `field_values` without `field_values_enc` silently
 * returns the (now null) plaintext copy. Derived from the spec so the two
 * can never drift.
 */
export function encCols(spec: FieldSpec): string {
  return [...(spec.json || []), ...(spec.text || [])].map(f => `${f}_enc`).join(', ')
}
// Written out as literals (not encCols(...) calls) so supabase-js's select()
// template-literal type parser still sees a string literal; the test suite
// asserts these equal encCols(spec), so they cannot drift from the specs.
export const RETURN_ENC_COLS = 'input_data_enc, computed_data_enc, field_values_enc, verification_enc'
export const DOC_ENC_COLS = 'meta_enc, textract_data_enc'

/**
 * Produce `*_enc` columns for any fields in `payload` that are set. Caller
 * is expected to include the plaintext column in their payload too (dual-
 * write). Returns an object safe to spread into an insert/update payload.
 */
export async function encryptedFields(
  supabase: SupabaseClient,
  userId: string,
  payload: Record<string, any>,
  fields: FieldSpec,
): Promise<Record<string, any>> {
  if (!encryptionEnabled()) return {}
  if (!userId) return {}
  const out: Record<string, any> = {}
  const jsonFields = fields.json || []
  const textFields = fields.text || []
  const anyPresent = [...jsonFields, ...textFields].some(f => payload[f] !== undefined && payload[f] !== null)
  if (!anyPresent) return out
  const dek = await getDek(supabase, userId)
  for (const f of jsonFields) {
    const v = payload[f]
    if (v !== undefined && v !== null) {
      out[`${f}_enc`] = byteaWrite(encrypt(dek, v))
      if (!writePlaintext()) out[f] = null
    }
  }
  for (const f of textFields) {
    const v = payload[f]
    if (v !== undefined && v !== null) {
      out[`${f}_enc`] = byteaWrite(encrypt(dek, String(v)))
      if (!writePlaintext()) out[f] = null
    }
  }
  return out
}

/**
 * Mutate `row` in place: for every `*_enc` column that's populated, decrypt
 * and write the plaintext back onto the plain property name. Existing code
 * that reads `row.field_values` etc. continues to work without changes.
 *
 * Safe to call even if row has no _enc columns set (no-op).
 * `userId` defaults to `row.user_id` but can be overridden (tax_return rows
 * don't have their own user_id column — resolve via tax_entity first).
 */
export async function hydrate(
  supabase: SupabaseClient,
  row: any,
  fields: FieldSpec & { userId?: string },
): Promise<void> {
  if (!row) return
  if (!encryptionEnabled()) return
  const uid = fields.userId ?? row.user_id
  if (!uid) return
  const jsonFields = fields.json || []
  const textFields = fields.text || []
  const anyEnc = [...jsonFields, ...textFields].some(f => row[`${f}_enc`])
  if (!anyEnc) return

  let dek: Buffer
  try {
    dek = await getDek(supabase, uid)
  } catch (e: any) {
    console.error(`hydrate: getDek failed for ${uid}: ${e.message} — using plaintext`)
    return
  }
  for (const f of jsonFields) {
    const enc = row[`${f}_enc`]
    if (!enc) continue
    try {
      row[f] = decryptJson(dek, bytea(enc))
    } catch (e: any) {
      console.error(`hydrate: decryptJson failed for ${f}: ${e.message} — using plaintext`)
    }
  }
  for (const f of textFields) {
    const enc = row[`${f}_enc`]
    if (!enc) continue
    try {
      row[f] = decryptString(dek, bytea(enc))
    } catch (e: any) {
      console.error(`hydrate: decryptString failed for ${f}: ${e.message} — using plaintext`)
    }
  }
}

/**
 * Convenience for lists: hydrate each row. Uses the same DEK-cache
 * lookup once per unique user_id encountered.
 */
export async function hydrateAll<T extends Record<string, any>>(
  supabase: SupabaseClient,
  rows: T[] | null | undefined,
  fields: FieldSpec & { userIdFrom?: (row: T) => string | undefined },
): Promise<T[]> {
  if (!rows?.length) return rows || []
  for (const row of rows) {
    const uid = fields.userIdFrom ? fields.userIdFrom(row) : row.user_id
    await hydrate(supabase, row, { ...fields, userId: uid })
  }
  return rows
}
