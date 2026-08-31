import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import { testEmail, deleteUserByEmail, signUpViaApi } from './helpers'

/**
 * The COMPLETE connector onboarding, end to end, as claude.ai performs it:
 * dynamic client registration → consent (issue-code) → PKCE token exchange →
 * an authenticated MCP tool call carrying the gateway's own protocol version.
 *
 * Exists because the pieces were only ever tested separately, and the seams
 * are where it actually broke: a reconnect failed "Authorization with the
 * MCP server failed" when the token exchange succeeded but the first
 * authenticated MCP request was rejected for its protocol version — a
 * failure no per-endpoint test could see. This spec fails if ANY link in
 * the chain regresses, including a future gateway protocol-version bump
 * (the header below should be kept at whatever Anthropic currently sends).
 */
test.describe('connector onboarding, whole chain', () => {
  const email = testEmail('oauthflow')
  test.afterAll(() => deleteUserByEmail(email))

  test('register → consent → token → versioned MCP call', async ({ request, baseURL }) => {
    // 1. Dynamic client registration (RFC 7591), as Claude does it.
    const reg = await request.post(`${baseURL}/oauth/register`, {
      data: { client_name: 'e2e oauth flow', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
    })
    expect(reg.status(), await reg.text()).toBe(201)
    const { client_id } = await reg.json()
    expect(client_id).toBeTruthy()

    // 2. A signed-in user — what the consent screen has after login.
    const jwt = await signUpViaApi(email)

    // 3. Consent: the React page's server call that mints the auth code.
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const issue = await request.post(`${baseURL}/.netlify/functions/oauth-issue-code`, {
      data: {
        code_challenge: challenge, code_challenge_method: 'S256',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        state: 'e2e', client_id, supabase_jwt: jwt,
      },
    })
    expect(issue.status(), await issue.text()).toBe(200)
    const { code } = await issue.json()
    expect(code, 'an auth code must be issued').toBeTruthy()

    // 4. Token exchange — claude.ai server-to-server, form-encoded.
    const tok = await request.post(`${baseURL}/oauth/token`, {
      form: {
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id,
      },
    })
    expect(tok.status(), await tok.text()).toBe(200)
    const { access_token } = await tok.json()
    expect(access_token, 'the access token is the MCP api key').toMatch(/^txk_/)

    // 5. The first authenticated MCP request, with the protocol version the
    // gateway ACTUALLY sends (newer than any published SDK at time of
    // writing) — this is the seam that broke.
    const GATEWAY_VERSION = '2026-07-28'
    const headers = {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${access_token}`,
      'MCP-Protocol-Version': GATEWAY_VERSION,
    }
    const init = await request.post(`${baseURL}/mcp`, {
      headers,
      data: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: GATEWAY_VERSION, capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
      },
    })
    expect(init.status(), await init.text()).toBe(200)

    const call = await request.post(`${baseURL}/mcp`, {
      headers,
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_documents', arguments: {} } },
    })
    expect(call.status(), await call.text()).toBe(200)
    const body = await call.text()
    expect(body, 'a real tool result, not a version rejection').toContain('documents')
    expect(body).not.toContain('Unsupported protocol version')
  })
})
