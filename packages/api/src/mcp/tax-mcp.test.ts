/**
 * The MCP server must build. Every tool needs an entry in TOOL_ANNOTATIONS,
 * and createServer throws on one that lacks it — once per request. On
 * 2026-10-20 the golden_view tool shipped without one: every /mcp request
 * killed a pm2 worker and the connector hung for hours, while the REST API
 * (and every REST test) stayed green. Building the server here catches it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
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

  // 2026-10-24: an amendment filed in a conversation could not be recorded —
  // only the web app's button could.
  describe('record_amendment_filed', () => {
    afterEach(() => { vi.unstubAllGlobals() })

    it('records the signed copy through the Record as filed route and answers with the year\'s filing status', async () => {
      const calls: Array<{ method: string; url: string; body?: any }> = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
        calls.push({ method: String(opts.method), url, body: opts.body ? JSON.parse(String(opts.body)) : undefined })
        const json = url.includes('/filed')
          ? { return_id: 'a1', entity_id: 'e1', tax_year: 2023, filed_at: '2026-05-11T12:00:00.000Z', document_id: 'd1', catalog_id: 'c1', catalog_status: 'complete' }
          : { entities: [{ entity_id: 'e1', years: [
              { tax_year: 2022, filed: null, accepted: false, accepted_why: '' },
              { tax_year: 2023, filed: { via: 'catalog' }, accepted: true, accepted_why: 'TC150', amendments: [{ return_id: 'a1', filed_at: '2026-05-11T12:00:00.000Z', copy: { catalog_id: 'c1' }, accepted: true, accepted_why: 'TC977 (amended return processed)' }] },
            ] }] }
        return { json: async () => json } as Response
      }))
      const server = createServer('test-key') as unknown as { _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; handler: (args: any, extra: any) => Promise<{ content: Array<{ text: string }> }> }> }
      const tool = server._registeredTools.record_amendment_filed
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
      const res = await tool.handler({ return_id: 'a1', filename: 'signed.pdf', content_base64: 'JVBERi0=', filed_on: '2026-05-11' }, {})
      expect(calls[0]).toMatchObject({ method: 'POST', body: { filename: 'signed.pdf', content_base64: 'JVBERi0=', filed_on: '2026-05-11' } })
      expect(calls[0].url).toMatch(/\/api\/returns\/a1\/filed$/)
      expect(calls[1]).toMatchObject({ method: 'GET' })
      expect(calls[1].url).toMatch(/\/api\/review\/filing\?entity_id=e1$/)
      const out = JSON.parse(res.content[0].text)
      expect(out.recorded.document_id).toBe('d1')
      expect(out.filing).toMatchObject({ tax_year: 2023, amendments: [{ return_id: 'a1', accepted: true }] })
    })

    it('passes a refusal back without reading the filing status', async () => {
      const fetchMock = vi.fn(async () => ({ json: async () => ({ error: 'This 2023 amendment is already recorded as filed' }) }) as unknown as Response)
      vi.stubGlobal('fetch', fetchMock)
      const server = createServer('test-key') as unknown as { _registeredTools: Record<string, { handler: (args: any, extra: any) => Promise<{ content: Array<{ text: string }> }> }> }
      const res = await server._registeredTools.record_amendment_filed.handler({ return_id: 'a1', filename: 'signed.pdf', content_base64: 'JVBERi0=' }, {})
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(res.content[0].text).error).toContain('already recorded as filed')
    })
  })
})
