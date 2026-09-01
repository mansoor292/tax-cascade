import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, createUserWithApiKey } from './helpers'
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

/** Streamable HTTP may answer as SSE or plain JSON — accept either. */
function parseMcp(body: string): any {
  if (!body.startsWith('event:')) return JSON.parse(body)
  const line = body.split('\n').find(l => l.startsWith('data: ')) || ''
  return JSON.parse(line.slice(6))
}

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

  /**
   * The authenticated path — what actually happens after a user approves
   * access. Everything above verifies a client can DISCOVER and be told to
   * authorize; none of it proves a tool call works once it has a token. That
   * is the step a connector fails on after OAuth succeeds, and it had no
   * coverage at all.
   */
  test.describe('authenticated tool call', () => {
    const email = testEmail('mcpauth')

    test.afterAll(async () => {
      const r = await deleteUserByEmail(email)
      if (r === 'skipped') console.log(`NOTE: no service role key — left ${email} behind`)
    })

    test('a token holder can list tools through the deployed endpoint', async ({ request, baseURL }) => {
      const { apiKey } = await createUserWithApiKey(email)

      const res = await request.post(`${baseURL}/mcp`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      expect(res.status(), 'authenticated tools/list must succeed').toBe(200)

      // Streamable HTTP may answer as SSE, so parse either shape.
      const body = await res.text()
      const json = body.startsWith('event:')
        ? JSON.parse(body.slice(body.indexOf('data: ') + 6).split('\n')[0])
        : JSON.parse(body)

      const tools = json?.result?.tools
      expect(Array.isArray(tools), `no tool list returned: ${body.slice(0, 200)}`).toBe(true)
      expect(tools.length).toBeGreaterThan(10)
      expect(tools.map((t: any) => t.name)).toContain('list_entities')
    })

    test('every tool carries a human-readable title and honest behavior hints', async ({ request, baseURL }) => {
      // A client audit found claude.ai's approval prompts showing only raw
      // tool names and UUID arguments — the user had no way to know what
      // they were consenting to. Titles + read-only/destructive hints are
      // the metadata the connector CAN provide; this pins that every tool
      // has them and that the hints stay honest for the tools that matter.
      const { apiKey } = await createUserWithApiKey(testEmail('mcpann'))
      const res = await request.post(`${baseURL}/mcp`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      expect(res.status()).toBe(200)
      const tools: any[] = parseMcp(await res.text()).result?.tools || []
      expect(tools.length).toBeGreaterThan(10)

      const untitled = tools.filter(t => !t.annotations?.title)
      expect(untitled.map(t => t.name), 'every tool must carry a title').toEqual([])

      const byName = Object.fromEntries(tools.map(t => [t.name, t.annotations]))
      expect(byName.list_entities?.readOnlyHint, 'reads must say so').toBe(true)
      expect(byName.get_entity?.readOnlyHint).toBe(true)
      expect(byName.list_documents?.readOnlyHint).toBe(true)
      expect(byName.delete_entity?.readOnlyHint, 'a delete must never claim read-only').toBe(false)
      expect(byName.delete_entity?.destructiveHint).toBe(true)
      expect(byName.delete_return?.destructiveHint).toBe(true)
      expect(byName.compute_return?.readOnlyHint, 'compute persists — not read-only').toBe(false)
    })

    test('server instructions demand evidence discipline in the first answer', async ({ request, baseURL }) => {
      // Audit finding SPO-02: Claude presented inferences (ownership,
      // pass-through activity) in the same voice as documented facts, and
      // only distinguished them when challenged. The server instructions
      // are the connector-side lever; this pins that they ship.
      const { apiKey } = await createUserWithApiKey(testEmail('mcpinstr'))
      const res = await request.post(`${baseURL}/mcp`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        data: {
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
        },
      })
      expect(res.status()).toBe(200)
      const instructions: string = parseMcp(await res.text()).result?.instructions || ''
      expect(instructions, 'evidence-discipline section must ship').toContain('Evidence discipline')
      expect(instructions).toContain('Documented fact')
      expect(instructions).toContain('Absence of evidence')
      expect(instructions).toContain('labeled as inference')
      expect(instructions, 'family-level questions answered from the list, not per-entity').toContain('Do NOT call get_entity once per entity')
    })


    test('initialize declares the tools capability', async ({ request, baseURL }) => {
      // If a server does not advertise tools, a client has no reason to
      // surface them as callable. Reported symptom was "connected as an MCP
      // source but not available as a direct tool", so this is worth pinning.
      const { apiKey } = await createUserWithApiKey(testEmail('mcpcap'))
      const res = await request.post(`${baseURL}/mcp`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        data: {
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
        },
      })
      expect(res.status()).toBe(200)
      const json = parseMcp(await res.text())
      expect(json.result?.capabilities?.tools, 'server must advertise a tools capability').toBeTruthy()
      expect(json.result?.serverInfo?.name).toBeTruthy()
      expect(json.result?.protocolVersion).toBeTruthy()
    })

    test('a tool can actually be CALLED, not merely listed', async ({ request, baseURL }) => {
      // tools/list succeeding proves nothing about invocation. This is the
      // exact request behind "list my tax entities" — the thing that failed.
      const { apiKey } = await createUserWithApiKey(testEmail('mcpcall'))
      const res = await request.post(`${baseURL}/mcp`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        data: {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'list_entities', arguments: {} },
        },
      })
      expect(res.status()).toBe(200)
      const json = parseMcp(await res.text())
      expect(json.error, `tools/call returned an error: ${JSON.stringify(json.error)}`).toBeUndefined()
      // A brand-new account has no entities; an empty list is the right answer.
      const text = json.result?.content?.[0]?.text || ''
      expect(JSON.parse(text)).toHaveProperty('entities')
    })

    test('the 401 exposes WWW-Authenticate to browser clients', async ({ request, baseURL }) => {
      // Headers a server does not EXPOSE are invisible to browser JavaScript,
      // even though curl sees them. A browser-based client then cannot read
      // the auth challenge and reports an opaque connection failure.
      const res = await request.post(`${baseURL}/mcp`, {
        headers: { Origin: 'https://claude.ai', 'Content-Type': 'application/json' },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      expect(res.status()).toBe(401)
      const exposed = (res.headers()['access-control-expose-headers'] || '').toLowerCase()
      expect(exposed, 'WWW-Authenticate must be readable by a browser client').toContain('www-authenticate')
    })
  })
})

/**
 * Forward-compat: Anthropic's gateway stamps requests with the newest MCP
 * protocol version IT speaks, which can outrun the newest published SDK.
 * Seen live 2026-08-31: header 2026-07-28 -> SDK hard-400 -> the gateway
 * told Claude the connector "failed to connect (502 Bad Gateway)", breaking
 * every fresh connection while established sessions kept working. The
 * server must negotiate down, not reject.
 */
test.describe('protocol version forward-compat', () => {
  test('a future MCP-Protocol-Version header is negotiated down, not 400ed', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/mcp`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer txk_version_probe',
        'MCP-Protocol-Version': '2099-01-01',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(res.status(), 'unknown future version must not be rejected').toBe(200)
    const body = await res.text()
    expect(body).toContain('list_documents')
    expect(body).not.toContain('Unsupported protocol version')
  })
})
