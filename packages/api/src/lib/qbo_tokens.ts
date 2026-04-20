/**
 * Encryption helpers for qbo_connection OAuth tokens.
 *
 * Writes are DUAL during transition: both plaintext (access_token /
 * refresh_token) and encrypted (access_token_enc / refresh_token_enc).
 * Reads prefer *_enc; fall back to plaintext if the row hasn't been
 * backfilled yet. A later cutover PR nulls the plaintext columns.
 *
 * If TAX_API_KMS_KEY isn't configured, the helpers pass through plaintext
 * only — encryption becomes a no-op. This keeps dev environments working
 * without KMS while prod and staging write encrypted from day one.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decryptString, getDek } from './crypto.js'

function encryptionEnabled(): boolean {
  return !!process.env.TAX_API_KMS_KEY
}

/**
 * Build the set of column updates for storing OAuth tokens. Returns both
 * plaintext and encrypted fields; caller spreads into the update/upsert
 * payload alongside other columns (realm_id, connected_at, etc.).
 *
 * If encryption is disabled, returns plaintext columns only.
 */
export async function buildTokenPayload(
  supabase: SupabaseClient,
  userId: string,
  tokens: { access_token: string; refresh_token: string },
): Promise<Record<string, any>> {
  const base: Record<string, any> = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
  }
  if (!encryptionEnabled()) return base
  const dek = await getDek(supabase, userId)
  base.access_token_enc  = encrypt(dek, tokens.access_token)
  base.refresh_token_enc = encrypt(dek, tokens.refresh_token)
  return base
}

/**
 * Read OAuth tokens from a qbo_connection row. Prefers encrypted columns;
 * falls back to plaintext if the encrypted bytes are missing or decryption
 * fails (corrupt ciphertext — log and fall through rather than fail the
 * request, since plaintext is still the source of truth during transition).
 *
 * Returns null if neither path yields a token (misconfigured row).
 */
export async function readTokensFromRow(
  supabase: SupabaseClient,
  row: { user_id: string; access_token?: string | null; refresh_token?: string | null; access_token_enc?: Buffer | null; refresh_token_enc?: Buffer | null },
): Promise<{ access_token: string; refresh_token: string } | null> {
  if (encryptionEnabled() && row.access_token_enc && row.refresh_token_enc) {
    try {
      const dek = await getDek(supabase, row.user_id)
      const at = decryptString(dek, toBuffer(row.access_token_enc))
      const rt = decryptString(dek, toBuffer(row.refresh_token_enc))
      if (at && rt) return { access_token: at, refresh_token: rt }
    } catch (e: any) {
      console.error(`qbo_tokens: decrypt failed for user ${row.user_id}, falling back to plaintext: ${e.message}`)
    }
  }
  if (row.access_token && row.refresh_token) {
    return { access_token: row.access_token, refresh_token: row.refresh_token }
  }
  return null
}

/**
 * Supabase returns bytea columns as Buffers when using the service-role key,
 * but as \x-prefixed hex strings when going through PostgREST under the anon
 * key. Normalize to Buffer.
 */
function toBuffer(v: Buffer | string): Buffer {
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'string' && v.startsWith('\\x')) return Buffer.from(v.slice(2), 'hex')
  if (typeof v === 'string') return Buffer.from(v, 'base64')
  return Buffer.from(v as any)
}
