/**
 * Shared helpers for the OAuth Netlify Functions.
 *
 * Auth codes are HS256-signed JWTs — fully stateless, so we don't care that
 * Function invocations land on different instances.
 */
import { SignJWT, jwtVerify } from 'jose'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL      = process.env.SUPABASE_URL      || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const OAUTH_CODE_SECRET = process.env.OAUTH_CODE_SECRET || ''
const API_BASE_URL      = process.env.API_BASE_URL      || 'https://fin.catipult.ai'

export const ISSUER = API_BASE_URL

export function supabaseAnon() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not configured')
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

function requireSecret(): Uint8Array {
  if (!OAUTH_CODE_SECRET) throw new Error('OAUTH_CODE_SECRET not configured')
  return new TextEncoder().encode(OAUTH_CODE_SECRET)
}

export interface AuthCodePayload {
  api_key:         string
  code_challenge:  string   // S256 challenge
  redirect_uri:    string
  client_id:       string
  user_id:         string
}

/** Sign a 5-minute auth code. */
export async function signAuthCode(payload: AuthCodePayload): Promise<string> {
  return await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('mcp-oauth-code')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(requireSecret())
}

/** Verify + decode an auth code. Throws if invalid/expired/wrong issuer. */
export async function verifyAuthCode(code: string): Promise<AuthCodePayload> {
  const { payload } = await jwtVerify(code, requireSecret(), {
    issuer:   ISSUER,
    audience: 'mcp-oauth-code',
  })
  const p = payload as unknown as AuthCodePayload
  if (!p.api_key || !p.code_challenge || !p.redirect_uri) {
    throw new Error('invalid_code_payload')
  }
  return p
}

/** PKCE S256 verify: SHA-256(code_verifier) base64url equals code_challenge. */
export function verifyPkceS256(code_verifier: string, code_challenge: string): boolean {
  const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url')
  return hash === code_challenge
}

/** Find-or-create the user's persistent MCP API key. */
export async function findOrCreateApiKey(userId: string): Promise<string> {
  const supabase = supabaseAnon()
  const { data: existing } = await supabase.from('api_key')
    .select('key_value').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle()
  if (existing?.key_value) return existing.key_value

  const key = `txk_${crypto.randomBytes(12).toString('hex')}`
  const { error } = await supabase.from('api_key').insert({
    user_id:   userId,
    key_value: key,
    name:      'Claude MCP (auto-created)',
    is_active: true,
  })
  if (error) throw new Error(`api_key insert failed: ${error.message}`)
  return key
}

/** Common JSON response helper. */
export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

export function error(code: string, description: string, status = 400) {
  return json({ error: code, error_description: description }, status)
}
