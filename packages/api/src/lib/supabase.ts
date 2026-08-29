/**
 * The Supabase clients, created ONCE. Before this module existed, every
 * route file re-declared the URL/key env reads with a hardcoded anon-JWT
 * fallback literal and its own createClient() — 13 copies, plus 7 identical
 * getUser() implementations. The fallbacks dated from before
 * bootstrap_env.ts guaranteed env at module load; they were dead weight and
 * a leaked credential.
 *
 * THREE clients on purpose — do not collapse them:
 * - serviceClient(): service-role, bypasses RLS. Route data access.
 * - anonClient(): anon key. auth.signUp/signInWithPassword must NOT run as
 *   service-role; the /api key-auth middleware also uses it, preserving
 *   whatever RLS posture the api_key lookups have always run under.
 * - userClient(req): per-request anon client carrying the caller's JWT so
 *   PostgREST RLS applies (auth.uid() scoping on api_key writes in /auth).
 *   Swapping this for serviceClient() would silently bypass RLS.
 *
 * Env is read at first call, not module load — safe under the
 * bootstrap_env import ordering, and modules that tests import indirectly
 * (field_maps) stay importable without env as long as no query runs.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Request } from 'express'

function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL
  if (!url) {
    throw new Error('SUPABASE_URL is not set. bootstrap_env.ts must load env before any query runs.')
  }
  return url
}

function anonKey(): string {
  const key = process.env.SUPABASE_ANON_KEY
  if (!key) {
    throw new Error('SUPABASE_ANON_KEY is not set. There is deliberately no fallback literal — see CLAUDE.md.')
  }
  return key
}

let _service: SupabaseClient | null = null
export function serviceClient(): SupabaseClient {
  if (!_service) {
    // Falls back to the anon key so a misconfigured box degrades to
    // RLS-empty reads (loudly flagged by bootstrap_env) instead of a crash
    // loop — the same posture the per-route copies had, minus the literal.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || anonKey()
    _service = createClient(supabaseUrl(), key)
  }
  return _service
}

let _anon: SupabaseClient | null = null
export function anonClient(): SupabaseClient {
  if (!_anon) _anon = createClient(supabaseUrl(), anonKey())
  return _anon
}

/** Per-request client that carries the caller's JWT for RLS. */
export function userClient(req: Request): SupabaseClient {
  const token = req.headers.authorization?.replace('Bearer ', '') || ''
  return createClient(supabaseUrl(), anonKey(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/**
 * The user id for a request under the /api gate. The middleware in
 * server.ts resolves the API key / JWT and sets req.userId on every
 * success path before next(), so handlers read it — they never re-verify
 * the token (the seven per-route getUser() copies this replaces all
 * carried an unreachable re-verification branch).
 */
export function requestUserId(req: Request): string | null {
  return (req as any).userId || null
}
