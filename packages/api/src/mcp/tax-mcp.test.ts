/**
 * The MCP server must build. Every tool needs an entry in TOOL_ANNOTATIONS,
 * and createServer throws on one that lacks it — once per request. On
 * 2026-10-20 the golden_view tool shipped without one: every /mcp request
 * killed a pm2 worker and the connector hung for hours, while the REST API
 * (and every REST test) stayed green. Building the server here catches it.
 */
import { describe, it, expect } from 'vitest'
import { createServer } from './tax-mcp.js'

describe('the MCP server', () => {
  it('builds with every tool annotated', () => {
    expect(() => createServer('test-key')).not.toThrow()
  })

  it('registers the golden view', () => {
    const server = createServer('test-key') as unknown as { _registeredTools: Record<string, { annotations?: { title?: string; readOnlyHint?: boolean } }> }
    const tools = server._registeredTools
    expect(Object.keys(tools).length).toBeGreaterThan(50)
    expect(tools.golden_view?.annotations?.readOnlyHint).toBe(true)
  })
})
