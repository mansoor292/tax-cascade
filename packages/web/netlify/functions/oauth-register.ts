/**
 * POST /oauth/register  (via netlify.toml redirect → /.netlify/functions/oauth-register)
 *
 * Dynamic Client Registration (RFC 7591) stub. We accept any client — actual
 * access control happens at the API-key level after /oauth/token. This mirrors
 * the prior Express behavior at oauth.ts:70-81.
 */
import type { Context } from '@netlify/functions'
import crypto from 'node:crypto'
import { json, error } from './_shared/oauth.js'

export default async (req: Request, _ctx: Context): Promise<Response> => {
  if (req.method !== 'POST') return error('method_not_allowed', 'POST required', 405)

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body is fine */ }

  const clientName   = typeof body.client_name === 'string' ? body.client_name : 'MCP Client'
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []

  return json({
    client_id:                  `client_${crypto.randomUUID()}`,
    client_name:                clientName,
    redirect_uris:              redirectUris,
    grant_types:                ['authorization_code'],
    token_endpoint_auth_method: 'none',
    response_types:             ['code'],
  }, 201)
}
