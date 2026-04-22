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
import { createClient } from '@supabase/supabase-js'
import type { Express, Request, Response } from 'express'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

// In-memory store for auth codes (short-lived)
const authCodes = new Map<string, {
  accessToken: string
  userId: string
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
  // `resource` MUST match the MCP endpoint URL the client is actually
  // connecting to (the MCP SDK enforces this — mismatch == auth failure).
  // Users hit https://fin.catipult.ai/mcp, which Netlify proxies here, so
  // the metadata declares fin.catipult.ai/mcp as the canonical resource.
  // This endpoint is kept for backward compat but the canonical location
  // is https://fin.catipult.ai/.well-known/oauth-protected-resource, per
  // RFC 9728 § the metadata-at-resource convention.
  const authServerUrl     = process.env.OAUTH_AUTH_SERVER_URL || 'https://fin.catipult.ai'
  const protectedResource = process.env.OAUTH_PROTECTED_RESOURCE || 'https://fin.catipult.ai/mcp'
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: protectedResource,
      authorization_servers: [authServerUrl],
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

    // Render login/signup page
    const error = req.query.error as string || ''
    const mode = req.query.mode as string || 'signin'
    const hiddenFields = `
    <input type="hidden" name="client_id" value="${client_id || ''}">
    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
    <input type="hidden" name="state" value="${state || ''}">
    <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
    <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}">
    <input type="hidden" name="scope" value="${scope || 'tax-api'}">`

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catipult Tax API</title>
<style>
  body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f7fa; }
  .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
  h2 { margin: 0 0 0.5rem; color: #1a1a2e; }
  p { color: #666; font-size: 0.9rem; margin: 0 0 1.5rem; }
  label { display: block; font-weight: 500; margin-bottom: 0.5rem; color: #333; }
  input[type="email"], input[type="password"], input[type="text"] { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 8px; font-size: 1rem; box-sizing: border-box; margin-bottom: 1rem; }
  button { width: 100%; padding: 0.75rem; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-bottom: 0.5rem; }
  button:hover { background: #1d4ed8; }
  .switch { text-align: center; font-size: 0.9rem; color: #666; }
  .switch a { color: #2563eb; text-decoration: none; font-weight: 500; }
  .error { color: #dc2626; font-size: 0.9rem; margin-bottom: 1rem; }
  .tabs { display: flex; margin-bottom: 1.5rem; border-bottom: 2px solid #e5e7eb; }
  .tab { flex: 1; text-align: center; padding: 0.75rem; cursor: pointer; font-weight: 500; color: #666; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tab.active { color: #2563eb; border-bottom-color: #2563eb; }
</style>
<script>
function showTab(tab) {
  document.getElementById('signin-form').style.display = tab === 'signin' ? 'block' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? 'block' : 'none';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
}
</script>
</head>
<body><div class="card">
  <h2>Catipult Tax API</h2>
  <p>Connect Claude to your tax data.</p>
  ${error ? `<p class="error">${error}</p>` : ''}
  <div class="tabs">
    <div class="tab ${mode !== 'signup' ? 'active' : ''}" id="tab-signin" onclick="showTab('signin')">Sign In</div>
    <div class="tab ${mode === 'signup' ? 'active' : ''}" id="tab-signup" onclick="showTab('signup')">Create Account</div>
  </div>
  <div id="signin-form" style="display:${mode !== 'signup' ? 'block' : 'none'}">
    <form method="POST" action="/oauth/authorize">
      ${hiddenFields}
      <input type="hidden" name="action" value="signin">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Sign In & Authorize</button>
    </form>
  </div>
  <div id="signup-form" style="display:${mode === 'signup' ? 'block' : 'none'}">
    <form method="POST" action="/oauth/authorize">
      ${hiddenFields}
      <input type="hidden" name="action" value="signup">
      <label for="full_name">Full Name</label>
      <input type="text" id="full_name" name="full_name" required>
      <label for="company_name">Company Name (optional)</label>
      <input type="text" id="company_name" name="company_name">
      <label for="signup_email">Email</label>
      <input type="email" id="signup_email" name="email" required>
      <label for="signup_password">Password</label>
      <input type="password" id="signup_password" name="password" minlength="6" required>
      <button type="submit">Create Account & Authorize</button>
    </form>
  </div>
</div></body></html>`)
  })

  // ─── Authorization POST — sign in or sign up via Supabase, issue code ───
  app.post('/oauth/authorize', async (req, res) => {
    const {
      action, email, password, full_name, company_name,
      client_id, redirect_uri, state,
      code_challenge, code_challenge_method, scope,
    } = req.body

    if (!email || !password || !redirect_uri) {
      return res.status(400).send('Email, password, and redirect_uri are required')
    }

    const errorRedirect = (msg: string, mode?: string) => {
      const qs = new URLSearchParams({
        response_type: 'code', client_id: client_id || '', redirect_uri,
        state: state || '', code_challenge: code_challenge || '',
        code_challenge_method: code_challenge_method || 'S256',
        scope: scope || 'tax-api', error: msg, mode: mode || 'signin',
      })
      return res.redirect(`/oauth/authorize?${qs}`)
    }

    let data: any, error: any

    if (action === 'signup') {
      // Sign up
      if (!full_name) return errorRedirect('Full name is required', 'signup')
      const result = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name, company_name: company_name || '' } },
      })
      data = result.data
      error = result.error
      if (error) return errorRedirect(error.message, 'signup')
      if (!data.session) {
        // Some Supabase configs require email confirmation
        // Try signing in immediately (works if email confirmation is disabled)
        const signInResult = await supabase.auth.signInWithPassword({ email, password })
        data = signInResult.data
        error = signInResult.error
        if (error) return errorRedirect('Account created. Please check your email to confirm, then sign in.', 'signin')
      }
    } else {
      // Sign in
      const result = await supabase.auth.signInWithPassword({ email, password })
      data = result.data
      error = result.error
      if (error || !data.session) return errorRedirect('Invalid email or password')
    }

    // Get or create a persistent API key for this user (doesn't expire like JWTs)
    let apiKey: string
    const { data: existingKey } = await supabase.from('api_key')
      .select('key_value').eq('user_id', data.user.id).eq('is_active', true).limit(1).single()
    if (existingKey) {
      apiKey = existingKey.key_value
    } else {
      apiKey = `txk_${crypto.randomBytes(12).toString('hex')}`
      await supabase.from('api_key').insert({
        user_id: data.user.id,
        key_value: apiKey,
        name: 'Claude MCP (auto-created)',
        is_active: true,
      })
    }

    // Generate auth code — store the persistent API key (not the short-lived JWT)
    const code = crypto.randomBytes(32).toString('hex')
    authCodes.set(code, {
      accessToken: apiKey,
      userId: data.user.id,
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

      // Return the persistent API key — never expires, survives server restarts
      res.json({
        access_token: authCode.accessToken,
        token_type: 'Bearer',
        expires_in: 31536000, // 1 year (API keys don't expire)
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
