/**
 * POST /oauth/token  (via netlify.toml redirect → /.netlify/functions/oauth-token)
 *
 * OAuth 2.1 token endpoint. Claude.ai calls this server-to-server after it
 * has an authorization code. We verify the signed JWT code, verify PKCE,
 * and return the access token (which is the user's persistent MCP API key).
 */
import type { Context } from '@netlify/functions'
import { verifyAuthCode, verifyPkceS256, json, error } from './_shared/oauth.js'

/** Accept either form-encoded or JSON bodies — OAuth spec allows both. */
async function readBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const parsed = await req.json().catch(() => ({}))
    return (parsed && typeof parsed === 'object') ? (parsed as Record<string, string>) : {}
  }
  const text = await req.text()
  const params = new URLSearchParams(text)
  const out: Record<string, string> = {}
  for (const [k, v] of params) out[k] = v
  return out
}

export default async (req: Request, _ctx: Context): Promise<Response> => {
  if (req.method !== 'POST') return error('method_not_allowed', 'POST required', 405)

  const body = await readBody(req)
  const {
    grant_type, code, code_verifier, redirect_uri, client_id: _clientId,
  } = body

  if (grant_type !== 'authorization_code') {
    return error('unsupported_grant_type', `grant_type "${grant_type}" is not supported`)
  }
  if (!code || !code_verifier) {
    return error('invalid_request', 'code and code_verifier are required')
  }

  let payload
  try {
    payload = await verifyAuthCode(code)
  } catch {
    return error('invalid_grant', 'Invalid or expired authorization code')
  }

  if (redirect_uri && redirect_uri !== payload.redirect_uri) {
    return error('invalid_grant', 'redirect_uri mismatch')
  }

  if (!verifyPkceS256(code_verifier, payload.code_challenge)) {
    return error('invalid_grant', 'PKCE verification failed')
  }

  return json({
    access_token: payload.api_key,
    token_type:   'Bearer',
    expires_in:   31536000,    // 1 year (MCP API keys don't expire)
    scope:        'tax-api',
  })
}
