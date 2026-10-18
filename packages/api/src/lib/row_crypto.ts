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
import { encrypt, decryptJson, decryptString, getDek, bytea, byteaWrite } from './crypto.js'

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
  /** JSONB columns kept readable, with every tax ID inside sealed in place */
  sealed?: string[]
}

/**
 * Tax IDs inside a readable JSON column.
 *
 * tax_entity.meta stays plain JSON because the accounting method, preparer and
 * open items in it are read and merged all over the code. On 2026-10-18 it was
 * found to hold a spouse's full SSN and a payer EIN in cleartext (and owners'
 * last-4 placeholders), right beside the encrypted EIN column.
 *
 * Each value under a tax-ID key, at any depth, is now sealed on write as
 * `enc1:<base64 envelope>`, the Stripe-key format. hydrate() opens it again.
 * The key names are the ones the MCP masks on output (tax-mcp.ts TAX_ID_KEY),
 * plus `tin`.
 */
export const SEALED_PREFIX = 'enc1:'
export const TAX_ID_KEY = /^(ein|ssn|spouse_ssn|ein_or_ssn|tin)$|_(ein|ssn|tin)$/

/** Apply `fn` to every string held under a tax-ID key; returns a copy. */
export function mapTaxIds(node: any, fn: (v: string) => string, key?: string): any {
  if (typeof node === 'string') return key && TAX_ID_KEY.test(key) && node ? fn(node) : node
  if (Array.isArray(node)) return node.map(v => mapTaxIds(v, fn, key))
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(node)) out[k] = mapTaxIds(v, fn, k)
    return out
  }
  return node
}

export function sealTaxIds(dek: Buffer, node: any): any {
  return mapTaxIds(node, v => v.startsWith(SEALED_PREFIX) ? v : SEALED_PREFIX + encrypt(dek, v).toString('base64'))
}

export function openTaxIds(dek: Buffer, node: any): any {
  return mapTaxIds(node, v => {
    if (!v.startsWith(SEALED_PREFIX)) return v
    try {
      return decryptString(dek, Buffer.from(v.slice(SEALED_PREFIX.length), 'base64')) ?? v
    } catch (e: any) {
      console.error(`openTaxIds: decrypt failed: ${e.message} — left sealed`)
      return v
    }
  })
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
export const ENCRYPTED_ENTITY_FIELDS: FieldSpec = { text: ['ein'], sealed: ['meta'] }
/**
 * tax_fact answers (services/facts.ts). The value is JSON because a fact can
 * be a date, a flag, an amount or a list of loan rows; the note is free text
 * that routinely names people, lenders and amounts. Ciphertext-only like the
 * rest — tax_fact never had a plaintext era to fall back on.
 */
export const ENCRYPTED_FACT_FIELDS: FieldSpec = { json: ['value'], text: ['source_note'] }
/** return_catalog: every value read off a return, and the per-page detail
 *  (statement headings and unassigned text quote the return verbatim). */
export const ENCRYPTED_CATALOG_FIELDS: FieldSpec = { json: ['entries', 'pages'] }
/** review_run findings quote amounts and names from the return; review
 *  resolution notes are free text. */
export const ENCRYPTED_REVIEW_FIELDS: FieldSpec = { json: ['findings'] }
export const ENCRYPTED_RESOLUTION_FIELDS: FieldSpec = { text: ['note'] }
/** return_note: the open threads about a return name people and amounts. */
export const ENCRYPTED_NOTE_FIELDS: FieldSpec = { text: ['title', 'body'] }
/** entity_link: the evidence quotes returns and the detail names people. */
export const ENCRYPTED_LINK_FIELDS: FieldSpec = { text: ['evidence', 'detail'] }
/** version_set / return_version: package titles, change lists and notes
 *  quote amounts and the reasons for an amendment. */
export const ENCRYPTED_SET_FIELDS: FieldSpec = { text: ['title', 'description'] }
export const ENCRYPTED_VERSION_FIELDS: FieldSpec = { json: ['changes'], text: ['note'] }

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
export const FACT_ENC_COLS = 'value_enc, source_note_enc'
export const CATALOG_ENC_COLS = 'entries_enc, pages_enc'
export const REVIEW_ENC_COLS = 'findings_enc'
export const NOTE_ENC_COLS = 'title_enc, body_enc'
export const LINK_ENC_COLS = 'evidence_enc, detail_enc'
export const SET_ENC_COLS = 'title_enc, description_enc'
export const VERSION_ENC_COLS = 'changes_enc, note_enc'

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
  const sealedFields = fields.sealed || []
  const anyPresent = [...jsonFields, ...textFields, ...sealedFields].some(f => payload[f] !== undefined && payload[f] !== null)
  if (!anyPresent) return out
  const dek = await getDek(supabase, userId)
  for (const f of sealedFields) {
    const v = payload[f]
    if (v && typeof v === 'object') out[f] = sealTaxIds(dek, v)
  }
  for (const f of jsonFields) {
    const v = payload[f]
    if (v !== undefined && v !== null) {
      // Always JSON: encrypt() keeps a bare string as raw text, which a JSON
      // column can't read back (see decryptJson).
      out[`${f}_enc`] = byteaWrite(encrypt(dek, JSON.stringify(v)))
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
  const sealedFields = (fields.sealed || []).filter(f => row[f] && typeof row[f] === 'object' && JSON.stringify(row[f]).includes(SEALED_PREFIX))
  const anyEnc = [...jsonFields, ...textFields].some(f => row[`${f}_enc`])
  if (!anyEnc && !sealedFields.length) return

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
  for (const f of sealedFields) row[f] = openTaxIds(dek, row[f])
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
