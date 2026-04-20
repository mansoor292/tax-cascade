/**
 * Row-level envelope encryption for sensitive columns across multiple
 * tables (tax_entity, tax_return, document, qbo_connection...).
 *
 * Write pattern: caller keeps the plaintext column in the payload and
 *   spreads `...await encryptedFields(supabase, userId, payload, {json, text})`
 *   into the insert/update. This dual-writes plaintext + `_enc` during the
 *   transition; a later cutover nulls plaintext and this helper continues
 *   to work unchanged (it only writes the _enc variants).
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
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, decryptJson, decryptString, getDek, bytea, byteaWrite } from './crypto.js'

export function encryptionEnabled(): boolean {
  return !!process.env.TAX_API_KMS_KEY
}

export interface FieldSpec {
  /** JSONB columns — encrypted payload is JSON.stringified */
  json?:  string[]
  /** Plain text columns — encrypted payload is the UTF-8 string */
  text?:  string[]
}

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
    if (v !== undefined && v !== null) out[`${f}_enc`] = byteaWrite(encrypt(dek, v))
  }
  for (const f of textFields) {
    const v = payload[f]
    if (v !== undefined && v !== null) out[`${f}_enc`] = byteaWrite(encrypt(dek, String(v)))
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
