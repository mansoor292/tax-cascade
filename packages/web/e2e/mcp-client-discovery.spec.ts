import { test, expect } from '@playwright/test'
import {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js'

/**
 * Discovery driven by the MCP SDK's OWN logic, not by a list of URLs someone
 * thought a client would use.
 *
 * This file exists because of a mistake worth not repeating. The connector
 * failed with "Couldn't reach"; I probed the endpoints I had chosen, found a
 * content-type defect on those, fixed it, wrote a test asserting exactly what
 * I had already concluded, and reported it verified. It was still broken. A
 * real client derives its metadata URLs from the resource PATH (RFC 9728 3.1)
 * — /.well-known/oauth-protected-resource/mcp — and that form was answered by
 * the SPA with an HTML page.
 *
 * A test written from my own hypothesis can only confirm my own hypothesis.
 * So these call the SDK's real discovery functions against the deployed site:
 * if the SDK's derivation rules change, or ours drift from the spec, this
 * fails without anyone having to guess a URL again.
 */
const MCP_URL = (base: string) => `${base}/mcp`

test.describe('MCP discovery, as a real client performs it', () => {
  test('every URL the SDK will try returns JSON rather than the SPA', async ({ request, baseURL }) => {
    // The list comes from the SDK, so it cannot drift from what Claude does.
    const urls = buildDiscoveryUrls(new URL(MCP_URL(baseURL!)))
    expect(urls.length, 'SDK produced no discovery URLs').toBeGreaterThan(0)

    const html: string[] = []
    for (const { url } of urls) {
      const res = await request.get(url.toString())
      // A 404 is legitimate — the client falls through to the next candidate.
      // HTML with a 200 is not: the client tries to parse it as metadata.
      if (res.status() === 200 && !(res.headers()['content-type'] || '').includes('application/json')) {
        html.push(`${url.pathname} -> ${res.headers()['content-type']}`)
      }
    }
    expect(html, `these returned a non-JSON 200, which a client reads as a broken server:\n${html.join('\n')}`)
      .toHaveLength(0)
  })

  test('the SDK can discover the protected-resource metadata', async ({ baseURL }) => {
    const md = await discoverOAuthProtectedResourceMetadata(MCP_URL(baseURL!))
    expect(md.resource).toBe(MCP_URL(baseURL!))
    expect(md.authorization_servers?.length).toBeGreaterThan(0)
  })

  test('the SDK can discover the authorization-server metadata', async ({ baseURL }) => {
    const resourceMd = await discoverOAuthProtectedResourceMetadata(MCP_URL(baseURL!))
    const authServer = resourceMd.authorization_servers![0]

    const md = await discoverAuthorizationServerMetadata(authServer)
    expect(md, 'SDK could not discover authorization server metadata').toBeTruthy()
    expect(md!.authorization_endpoint).toContain(baseURL!)
    expect(md!.token_endpoint).toContain(baseURL!)
    expect(md!.registration_endpoint).toContain(baseURL!)
    expect(md!.code_challenge_methods_supported).toContain('S256')
  })

  test('a real transport reaches the server and is told to authorize, not that it is unreachable', async ({ baseURL }) => {
    // The distinction that matters. "Needs authorization" is correct
    // behaviour for an unauthenticated client. "Couldn't reach" is the bug.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

    const client = new Client({ name: 'e2e-discovery-probe', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL(baseURL!)))

    let error: unknown
    try {
      await client.connect(transport)
      await client.close()
    } catch (e) {
      error = e
    }

    expect(error, 'expected an authorization challenge from an unauthenticated connect').toBeTruthy()
    const text = String((error as Error)?.message || error)

    // Unauthorized / 401 is the correct outcome. Anything that reads as a
    // transport or parse failure is what the user saw as "Couldn't reach".
    expect(text, `connect failed for the wrong reason: ${text}`).toMatch(/unauthorized|401|authoriz/i)
    expect(text).not.toMatch(/ENOTFOUND|ECONNREFUSED|Unexpected token|<!doctype/i)
  })
})
