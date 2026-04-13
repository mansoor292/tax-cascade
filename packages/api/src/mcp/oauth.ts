/**
 * OAuth 2.1 provider for MCP — minimal implementation
 *
 * Flow:
 *   1. Claude.ai hits /mcp, gets 401 with WWW-Authenticate
 *   2. Discovers /.well-known/oauth-protected-resource → points to us as auth server
 *   3. Discovers /.well-known/oauth-authorization-server → authorize + token endpoints
 *   4. Redirects user to /oauth/authorize with PKCE challenge
 *   5. User enters their API key on a simple form
 *   6. We issue an auth code, redirect back to claude.ai
 *   7. Claude.ai exchanges code for token at /oauth/token
 *   8. Token = the user's API key (passed through on all MCP requests)
 */
import crypto from 'crypto'
import type { Express, Request, Response } from 'express'

// In-memory store for auth codes (short-lived)
const authCodes = new Map<string, {
  apiKey: string
  codeChallenge: string
  codeChallengeMethod: string
  redirectUri: string
  clientId: string
  expiresAt: number
}>()

// Clean up expired codes every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code)
  }
}, 5 * 60 * 1000)

export function mountOAuth(app: Express) {
  const baseUrl = process.env.API_BASE_URL || 'https://tax-api.catalogshub.com'

  // ─── Protected Resource Metadata (RFC 9728) ───
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['tax-api'],
    })
  })

  // ─── Authorization Server Metadata (RFC 8414) ───
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ['tax-api'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    })
  })

  // ─── Dynamic Client Registration (RFC 7591) ───
  app.post('/oauth/register', (req, res) => {
    const { client_name, redirect_uris } = req.body
    // Accept any client — we validate at the API key level
    const clientId = `client_${crypto.randomUUID()}`
    res.status(201).json({
      client_id: clientId,
      client_name: client_name || 'MCP Client',
      redirect_uris: redirect_uris || [],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    })
  })

  // ─── Authorization Endpoint ───
  app.get('/oauth/authorize', (req, res) => {
    const {
      response_type, client_id, redirect_uri, state,
      code_challenge, code_challenge_method, scope,
    } = req.query as Record<string, string>

    if (response_type !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' })
    }

    // Render a simple login page where user enters their API key
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tax API — Connect</title>
<style>
  body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f7fa; }
  .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
  h2 { margin: 0 0 0.5rem; color: #1a1a2e; }
  p { color: #666; font-size: 0.9rem; margin: 0 0 1.5rem; }
  label { display: block; font-weight: 500; margin-bottom: 0.5rem; color: #333; }
  input[type="text"] { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 8px; font-size: 1rem; box-sizing: border-box; }
  button { width: 100%; padding: 0.75rem; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
  button:hover { background: #1d4ed8; }
  .hint { font-size: 0.8rem; color: #999; margin-top: 0.5rem; }
</style></head>
<body><div class="card">
  <h2>Connect to Tax API</h2>
  <p>Enter your API key to authorize Claude to access your tax data.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${client_id || ''}">
    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
    <input type="hidden" name="state" value="${state || ''}">
    <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
    <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}">
    <input type="hidden" name="scope" value="${scope || 'tax-api'}">
    <label for="api_key">API Key</label>
    <input type="text" id="api_key" name="api_key" placeholder="txk_..." required>
    <p class="hint">Your key starts with txk_. Get one from your account settings.</p>
    <button type="submit">Authorize</button>
  </form>
</div></body></html>`)
  })

  // ─── Authorization POST — validate key, issue code ───
  app.post('/oauth/authorize', (req, res) => {
    const {
      api_key, client_id, redirect_uri, state,
      code_challenge, code_challenge_method, scope,
    } = req.body

    if (!api_key || !redirect_uri) {
      return res.status(400).send('API key and redirect_uri are required')
    }

    // Generate auth code
    const code = crypto.randomBytes(32).toString('hex')
    authCodes.set(code, {
      apiKey: api_key,
      codeChallenge: code_challenge || '',
      codeChallengeMethod: code_challenge_method || 'S256',
      redirectUri: redirect_uri,
      clientId: client_id || '',
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
    })

    // Redirect back to claude.ai with code
    const url = new URL(redirect_uri)
    url.searchParams.set('code', code)
    if (state) url.searchParams.set('state', state)
    res.redirect(url.toString())
  })

  // ─── Token Endpoint ───
  app.post('/oauth/token', (req, res) => {
    const { grant_type, code, code_verifier, redirect_uri } = req.body

    if (grant_type === 'authorization_code') {
      const authCode = authCodes.get(code)
      if (!authCode) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' })
      }

      if (authCode.expiresAt < Date.now()) {
        authCodes.delete(code)
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' })
      }

      // Verify PKCE
      if (authCode.codeChallenge && code_verifier) {
        const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url')
        if (hash !== authCode.codeChallenge) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
        }
      }

      // Verify redirect_uri matches
      if (redirect_uri && redirect_uri !== authCode.redirectUri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
      }

      // Clean up
      authCodes.delete(code)

      // The access token IS the user's API key
      res.json({
        access_token: authCode.apiKey,
        token_type: 'Bearer',
        expires_in: 86400 * 365, // effectively doesn't expire (API key is long-lived)
        scope: 'tax-api',
      })
    } else if (grant_type === 'refresh_token') {
      // API keys don't expire, so just return the same token
      // (The refresh_token in this case would be the access_token itself)
      const refresh_token = req.body.refresh_token
      if (!refresh_token) {
        return res.status(400).json({ error: 'invalid_grant' })
      }
      res.json({
        access_token: refresh_token,
        token_type: 'Bearer',
        expires_in: 86400 * 365,
        scope: 'tax-api',
      })
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' })
    }
  })

  console.log('  OAuth endpoints: /.well-known/oauth-*, /oauth/authorize, /oauth/token')
}
