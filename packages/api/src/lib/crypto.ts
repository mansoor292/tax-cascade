/**
 * Per-user envelope encryption for customer data.
 *
 * Threat model (SOC 2 + accidental leakage + targeted breach):
 *   • DB dump / backup exfiltration → ciphertext only
 *   • Accidental log of a row → opaque bytes
 *   • Compromised support account → no blanket plaintext access
 *   • Single-user account compromise → that user's DEK only
 *
 * Design:
 *   • AWS KMS Customer Managed Key (CMK) is the root of trust.
 *   • Each user has a 32-byte Data Encryption Key (DEK), envelope-encrypted
 *     by the CMK and stored in `user_key.dek_encrypted`.
 *   • Column-level encryption uses AES-256-GCM with a fresh 12-byte IV per
 *     record. Ciphertext format: version(1) || iv(12) || ct(n) || tag(16).
 *   • DEKs are cached in-process (LRU, TTL) to avoid KMS round-trips on
 *     the hot path. Cache is per-process — KMS calls still happen on the
 *     first request per (user, pod).
 *
 * Crypto-shred: set `user_key.deleted_at` and null `dek_encrypted` — all
 * ciphertext for that user becomes permanently unrecoverable.
 *
 * Ciphertext compatibility: the leading version byte lets us rotate
 * algorithms (e.g. to XChaCha20-Poly1305) without breaking old records.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms'

// Read env lazily so tests (and deploy-time env injection) work without module reload.
const kmsKeyId    = () => process.env.TAX_API_KMS_KEY || ''
const awsRegion   = () => process.env.AWS_REGION || 'us-east-1'
const hmacSecret  = () => process.env.TAX_API_BLIND_HMAC || ''
const DEK_TTL_MS    = Number(process.env.TAX_API_DEK_TTL_MS || 10 * 60 * 1000)  // 10 min
const MAX_CACHED    = Number(process.env.TAX_API_DEK_CACHE_MAX || 500)
const CURRENT_VERSION = 1

interface CacheEntry { dek: Buffer; expiresAt: number }
const DEK_CACHE = new Map<string, CacheEntry>()

// Single client per process; it keeps HTTP connections warm. Lazy-init so
// tests and non-encrypted code paths don't pay the cost.
let _kms: KMSClient | null = null
function kms(): KMSClient {
  if (!_kms) _kms = new KMSClient({ region: awsRegion() })
  return _kms
}

function encryptionContext(userId: string): Record<string, string> {
  return { user_id: userId, purpose: 'tax-api-user-dek' }
}

function requireConfig(): void {
  if (!kmsKeyId()) throw new Error('TAX_API_KMS_KEY env var not set — cannot envelope-encrypt DEKs')
  if (!hmacSecret()) throw new Error('TAX_API_BLIND_HMAC env var not set — required for blind indexes')
}

function touchCache(userId: string, dek: Buffer): void {
  // Simple LRU: when at capacity, evict oldest entry (Map preserves insertion order).
  if (DEK_CACHE.size >= MAX_CACHED && !DEK_CACHE.has(userId)) {
    const oldest = DEK_CACHE.keys().next().value
    if (oldest) DEK_CACHE.delete(oldest)
  }
  DEK_CACHE.delete(userId)  // re-insert to move to end (most recent)
  DEK_CACHE.set(userId, { dek, expiresAt: Date.now() + DEK_TTL_MS })
}

/**
 * Call KMS GenerateDataKey for a new DEK.
 * Returns { plaintext, ciphertext, keyId }. The ciphertext is what we persist
 * in user_key.dek_encrypted; the plaintext is held only in memory (cache).
 */
async function kmsGenerateDataKey(userId: string): Promise<{ plaintext: Buffer; ciphertext: Buffer; keyId: string }> {
  const resp = await kms().send(new GenerateDataKeyCommand({
    KeyId: kmsKeyId(),
    KeySpec: 'AES_256',
    EncryptionContext: encryptionContext(userId),
  }))
  if (!resp.Plaintext || !resp.CiphertextBlob || !resp.KeyId) {
    throw new Error('KMS GenerateDataKey returned incomplete response')
  }
  return {
    plaintext:  Buffer.from(resp.Plaintext),
    ciphertext: Buffer.from(resp.CiphertextBlob),
    keyId:      resp.KeyId,
  }
}

async function kmsDecryptDataKey(userId: string, ciphertext: Buffer, keyId: string): Promise<Buffer> {
  const resp = await kms().send(new DecryptCommand({
    CiphertextBlob: ciphertext,
    EncryptionContext: encryptionContext(userId),
    KeyId: keyId,
  }))
  if (!resp.Plaintext) throw new Error('KMS Decrypt returned no plaintext')
  return Buffer.from(resp.Plaintext)
}

/**
 * Resolve a user's DEK. Creates one on first use (stored in user_key).
 * Subsequent calls hit the in-process cache; cache miss → KMS decrypt.
 */
export async function getDek(supabase: SupabaseClient, userId: string): Promise<Buffer> {
  requireConfig()
  const cached = DEK_CACHE.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached.dek

  const { data: existing } = await supabase.from('user_key')
    .select('dek_encrypted, kms_key_id, deleted_at')
    .eq('user_id', userId).maybeSingle()

  if (existing?.deleted_at) {
    throw new Error(`user_key.deleted_at is set for ${userId} — data has been crypto-shredded`)
  }

  let dek: Buffer
  if (!existing) {
    const gen = await kmsGenerateDataKey(userId)
    const { error } = await supabase.from('user_key').insert({
      user_id: userId,
      dek_encrypted: gen.ciphertext,
      kms_key_id: gen.keyId,
    })
    if (error) throw new Error(`user_key insert failed: ${error.message}`)
    dek = gen.plaintext
  } else {
    const ciphertext = Buffer.isBuffer(existing.dek_encrypted)
      ? existing.dek_encrypted
      : Buffer.from(existing.dek_encrypted as any, 'hex')  // Supabase may return \x-prefixed hex
    dek = await kmsDecryptDataKey(userId, ciphertext, existing.kms_key_id)
  }
  touchCache(userId, dek)
  return dek
}

/** Drop a user's DEK from the in-process cache. */
export function evictDek(userId: string): void {
  DEK_CACHE.delete(userId)
}

export function _testOnlySetCachedDek(userId: string, dek: Buffer): void {
  touchCache(userId, dek)
}

/**
 * AES-256-GCM encrypt. Accepts string, Buffer, or JSON-serializable object.
 * Returns: version(1) || iv(12) || ciphertext(n) || tag(16)
 */
export function encrypt(dek: Buffer, plaintext: string | Buffer | object): Buffer {
  if (dek.length !== 32) throw new Error(`Expected 32-byte DEK, got ${dek.length}`)
  const data = Buffer.isBuffer(plaintext)
    ? plaintext
    : typeof plaintext === 'string'
      ? Buffer.from(plaintext, 'utf8')
      : Buffer.from(JSON.stringify(plaintext), 'utf8')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dek, iv)
  const ct = Buffer.concat([cipher.update(data), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([CURRENT_VERSION]), iv, ct, tag])
}

export function decrypt(dek: Buffer, blob: Buffer): Buffer {
  if (dek.length !== 32) throw new Error(`Expected 32-byte DEK, got ${dek.length}`)
  if (!blob || blob.length < 1 + 12 + 16) throw new Error('Ciphertext too short')
  const version = blob[0]
  if (version !== CURRENT_VERSION) throw new Error(`Unsupported ciphertext version ${version}`)
  const iv  = blob.subarray(1, 13)
  const tag = blob.subarray(blob.length - 16)
  const ct  = blob.subarray(13, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

export function decryptJson<T = any>(dek: Buffer, blob: Buffer | null | undefined): T | null {
  if (!blob || blob.length === 0) return null
  return JSON.parse(decrypt(dek, blob).toString('utf8')) as T
}

export function decryptString(dek: Buffer, blob: Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null
  return decrypt(dek, blob).toString('utf8')
}

/**
 * Deterministic blind index for search (e.g. lookup a tax_entity by EIN).
 * Uses HMAC-SHA256 with a server-only secret so the DB never sees an EIN
 * that can be reversed offline. Normalizes input (digits only, lowercase)
 * so "12-3456789" and "123456789" hash identically.
 *
 * Tradeoff: deterministic index leaks equality (same plaintext = same hash).
 * That's the cost of being able to look up encrypted fields.
 */
export function blindIndex(value: string): string {
  const secret = hmacSecret()
  if (!secret) throw new Error('TAX_API_BLIND_HMAC env var not set')
  const normalized = value.replace(/\D/g, '').toLowerCase()
  return createHmac('sha256', secret).update(normalized).digest('hex')
}
