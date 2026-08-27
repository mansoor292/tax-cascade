import { test, expect } from '@playwright/test'

/**
 * The Claude connector handshake (SOP 01, final step).
 *
 * Reported: Claude showed "Couldn't reach Catipult Family Finance (Cati)"
 * and could not get as far as OAuth authorization.
 *
 * Nothing in the suite covered this chain, so a break in any link of it was
 * invisible. Each step below is one thing an MCP client does before it can
 * show an authorize prompt; if any returns HTML, a 404, or the wrong status,
 * the connector reports the server as unreachable and gives no further
 * detail.
 *
 * These are request-level checks — driving Claude's own UI is not something
 * we can automate — so they verify the server side of the handshake only.
 */
const MCP_PATH = '/mcp'

test.describe('MCP connector handshake', () => {

  /**
   * RFC 9728 §3.1 / RFC 8414 §3.1: when the protected resource has a PATH
   * component — ours is /mcp — the client builds the metadata URL by
   * inserting the well-known segment BEFORE that path, not by appending it to
   * the host alone. Serving only the bare form meant the derived lookups fell
   * through to the SPA fallback and returned an HTML page with a 200, and the
   * connector reported the server as unreachable.
   *
   * The earlier fix corrected the content type on the bare URLs only, which
   * is why probing those passed while a real client still failed. Every form
   * a client may derive is checked here.
   */
  const DERIVED_METADATA_URLS = [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/mcp/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/mcp/.well-known/oauth-authorization-server',
  ]

  for (const path of DERIVED_METADATA_URLS) {
    test(`metadata at ${path} is JSON, not the SPA`, async ({ request, baseURL }) => {
      const res = await request.get(`${baseURL}${path}`)
      expect(res.status()).toBe(200)

      const ct = res.headers()['content-type'] || ''
      expect(ct, `${path} returned ${ct} — an HTML body here reads as "server unreachable"`)
        .toContain('application/json')

      // Must parse, and be one of the two metadata documents.
      const body = await res.json()
      expect(body.resource || body.issuer, `${path} returned JSON without resource/issuer`).toBeTruthy()
    })
  }

  test('the protected-resource metadata is served as JSON', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/.well-known/oauth-protected-resource`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type'] || '').toContain('application/json')

    const body = await res.json()
    expect(body.resource).toBe(`${baseURL}${MCP_PATH}`)
    expect(body.authorization_servers?.length).toBeGreaterThan(0)
  })

  test('the authorization-server metadata advertises the endpoints a client needs', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/.well-known/oauth-authorization-server`)
    expect(res.status()).toBe(200)

    // RFC 9728 requires application/json. Extensionless static files get
    // served as text/plain, which a strict client rejects outright.
    expect(res.headers()['content-type'] || '').toContain('application/json')

    const md = await res.json()
    // The issuer must be the host the client is actually talking to. If these
    // documents are ever proxied to the API they will advertise the origin
    // host instead, and the OAuth endpoints live only on this one.
    expect(md.issuer).toBe(baseURL)
    for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      expect(md[field], `${field} must point at ${baseURL}`).toContain(baseURL)
    }
    // PKCE is required by the MCP spec; without S256 Claude will refuse.
    expect(md.code_challenge_methods_supported).toContain('S256')
  })

  test('an unauthenticated MCP call returns 401 with a WWW-Authenticate pointer', async ({ request, baseURL }) => {
    // This is the single most important response in the chain: it is how the
    // client learns WHERE to authenticate. A 404, a 500, or a 401 without the
    // header all surface to the user as "couldn't reach the server".
    const res = await request.post(`${baseURL}${MCP_PATH}`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
      },
    })
    expect(res.status()).toBe(401)

    const wwwAuth = res.headers()['www-authenticate'] || ''
    expect(wwwAuth).toContain('Bearer')
    expect(wwwAuth).toContain('resource_metadata')
  })

  test('dynamic client registration accepts a Claude-shaped request', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/oauth/register`, {
      data: {
        client_name: 'E2E Connector Check',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.client_id).toBeTruthy()
    expect(body.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback')
  })

  test('the authorize page loads rather than erroring', async ({ page, baseURL }) => {
    // Where the user lands after Claude redirects. It should render (asking
    // for sign-in if needed), never a blank page or a crash.
    const res = await page.goto(
      `${baseURL}/oauth/authorize?client_id=probe&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
      `&response_type=code&code_challenge=abc&code_challenge_method=S256&state=xyz`,
    )
    expect(res?.status()).toBeLessThan(400)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('the setup instructions do not link to the retired connector dialog', async ({ page, baseURL }) => {
    // claude.ai moved connectors under Customize; the old deep link
    // ?modal=add-custom-connector now lands on a dead-end page. That strands a
    // new user at the one step they cannot work around, and it fails silently
    // because our page still looks correct. Third-party URLs rot, so assert we
    // are not shipping a known-dead one.
    await page.goto(`${baseURL}/app/connect-claude`)
    const stale = page.locator('a[href*="modal=add-custom-connector"]')
    await expect(stale, 'links to the retired Claude connector dialog').toHaveCount(0)

    // The landing page carries the same instructions.
    await page.goto(`${baseURL}/`)
    await expect(page.locator('a[href*="modal=add-custom-connector"]')).toHaveCount(0)
  })
})
