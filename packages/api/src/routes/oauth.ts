/**
 * OAuth 2.1 for the MCP connector — the Netlify Functions, ported home.
 *
 * History matters here. An Express OAuth stack lived in mcp/oauth.ts once
 * and was deleted for two good reasons: its in-memory auth-code store could
 * not survive the pm2 cluster (a code issued by worker 0 was invisible to
 * worker 1), and netlify.toml shadowed its every route in production. The
 * replacement was stateless HS256-JWT codes in Netlify Functions — correct,
 * but it left OAuth on a second vendor whose edge sat between Anthropic's
 * connector proxy and this origin. When Netlify was cut out of the serving
 * path (2026-09-02), the functions moved here VERBATIM in mechanism:
 * auth codes are still stateless signed JWTs (cluster-safe by construction),
 * the access token is still the user's persistent txk_ API key, and
 * OAUTH_CODE_SECRET is the same secret (carried into SSM), so in-flight
 * codes and every existing connection survived the move. There is still
 * exactly ONE OAuth implementation — this one. Do not resurrect a stateful
 * variant, and do not let a second copy exist anywhere.
 *
 * Routes (mounted at app level, all public):
 *   POST /oauth/token       — code + PKCE → access token (the API key)
 *   POST /oauth/register    — RFC 7591 dynamic client registration stub
 *   POST /oauth/issue-code  — consent screen exchanges a Supabase session
 *                             JWT for a signed 5-minute auth code
 *   POST /.netlify/functions/oauth-issue-code — legacy alias; SPA bundles
 *                             built before the cutover still call this path
 */
import { Router, type Request, type Response } from 'express'
import { SignJWT, jwtVerify } from 'jose'
import crypto from 'node:crypto'
import { anonClient, jwtClient } from '../lib/supabase.js'

const router = Router()

const ISSUER = process.env.API_BASE_URL || 'https://fin.catipult.ai'

function requireSecret(): Uint8Array {
  const s = process.env.OAUTH_CODE_SECRET || ''
  if (!s) throw new Error('OAUTH_CODE_SECRET not configured')
  return new TextEncoder().encode(s)
}

interface AuthCodePayload {
  api_key:        string
  code_challenge: string
  redirect_uri:   string
  client_id:      string
  user_id:        string
}

async function signAuthCode(payload: AuthCodePayload): Promise<string> {
  return await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('mcp-oauth-code')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(requireSecret())
}

async function verifyAuthCode(code: string): Promise<AuthCodePayload> {
  const { payload } = await jwtVerify(code, requireSecret(), {
    issuer: ISSUER, audience: 'mcp-oauth-code',
  })
  const p = payload as unknown as AuthCodePayload
  if (!p.api_key || !p.code_challenge || !p.redirect_uri) throw new Error('invalid_code_payload')
  return p
}

function verifyPkceS256(code_verifier: string, code_challenge: string): boolean {
  const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url')
  return hash === code_challenge
}

/** Find-or-create the user's persistent MCP API key, as the user (RLS). */
async function findOrCreateApiKey(userId: string, userJwt: string): Promise<string> {
  const supabase = jwtClient(userJwt)
  const { data: existing, error: selErr } = await supabase.from('api_key')
    .select('key_value').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle()
  if (selErr) throw new Error(`api_key select failed: ${selErr.message}`)
  if (existing?.key_value) return existing.key_value

  const key = `txk_${crypto.randomBytes(12).toString('hex')}`
  const { error: insErr } = await supabase.from('api_key').insert({
    user_id: userId, key_value: key, name: 'Claude MCP (auto-created)', is_active: true,
  })
  if (insErr) throw new Error(`api_key insert failed: ${insErr.message}`)
  return key
}

const oauthError = (code: string, description: string, status = 400) =>
  ({ status, body: { error: code, error_description: description } })

// ─── POST /oauth/token ───
router.post('/oauth/token', async (req, res) => {
  // OAuth spec: body may be form-encoded or JSON; express.json +
  // express.urlencoded upstream have parsed either into req.body.
  const { grant_type, code, code_verifier, redirect_uri } = (req.body || {}) as Record<string, string>

  if (grant_type !== 'authorization_code') {
    const e = oauthError('unsupported_grant_type', `grant_type "${grant_type}" is not supported`)
    return res.status(e.status).json(e.body)
  }
  if (!code || !code_verifier) {
    const e = oauthError('invalid_request', 'code and code_verifier are required')
    return res.status(e.status).json(e.body)
  }

  let payload: AuthCodePayload
  try {
    payload = await verifyAuthCode(code)
  } catch {
    const e = oauthError('invalid_grant', 'Invalid or expired authorization code')
    return res.status(e.status).json(e.body)
  }

  if (redirect_uri && redirect_uri !== payload.redirect_uri) {
    const e = oauthError('invalid_grant', 'redirect_uri mismatch')
    return res.status(e.status).json(e.body)
  }
  if (!verifyPkceS256(code_verifier, payload.code_challenge)) {
    const e = oauthError('invalid_grant', 'PKCE verification failed')
    return res.status(e.status).json(e.body)
  }

  return res.json({
    access_token: payload.api_key,
    token_type:   'Bearer',
    expires_in:   31536000,   // 1 year (MCP API keys don't expire)
    scope:        'tax-api',
  })
})

// ─── POST /oauth/register ───
router.post('/oauth/register', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const clientName   = typeof body.client_name === 'string' ? body.client_name : 'MCP Client'
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  return res.status(201).json({
    client_id:                  `client_${crypto.randomUUID()}`,
    client_name:                clientName,
    redirect_uris:              redirectUris,
    grant_types:                ['authorization_code'],
    token_endpoint_auth_method: 'none',
    response_types:             ['code'],
  })
})

// ─── POST /oauth/issue-code (+ legacy Netlify path) ───
async function issueCode(req: Request, res: Response) {
  const {
    code_challenge, code_challenge_method, redirect_uri, state, client_id, supabase_jwt,
  } = (req.body || {}) as Record<string, string>

  if (!code_challenge || !redirect_uri || !supabase_jwt) {
    const e = oauthError('invalid_request', 'code_challenge, redirect_uri, supabase_jwt are required')
    return res.status(e.status).json(e.body)
  }
  if (code_challenge_method !== 'S256') {
    const e = oauthError('invalid_request', 'Only S256 code_challenge_method is supported')
    return res.status(e.status).json(e.body)
  }

  const { data: userResp, error: userErr } = await anonClient().auth.getUser(supabase_jwt)
  if (userErr || !userResp?.user) {
    const e = oauthError('invalid_grant', 'Invalid or expired Supabase session', 401)
    return res.status(e.status).json(e.body)
  }

  try {
    const userId = userResp.user.id
    const api_key = await findOrCreateApiKey(userId, supabase_jwt)
    const code = await signAuthCode({
      api_key, code_challenge, redirect_uri, client_id: client_id || '', user_id: userId,
    })
    return res.json({ code, redirect_uri, state: state || '' })
  } catch (err: any) {
    const e = oauthError('server_error', err?.message || 'issue-code failed', 500)
    return res.status(e.status).json(e.body)
  }
}
router.post('/oauth/issue-code', issueCode)
router.post('/.netlify/functions/oauth-issue-code', issueCode)

export default router
