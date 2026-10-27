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

  // 2026-10-27: a practice's clients over MCP, for the key that owns it. A
  // client's periods come without their transactions unless one is opened,
  // the signer's details never come, and nothing here asks the IRS.
  describe('practice tools', () => {
    afterEach(() => { vi.unstubAllGlobals() })
    type Tools = Record<string, { annotations?: { readOnlyHint?: boolean }; handler: (args: any, extra: any) => Promise<{ content: Array<{ text: string }> }> }>
    const tools = () => (createServer('test-key') as unknown as { _registeredTools: Tools })._registeredTools
    const txn = (code: string) => ({ code, date: '2024-04-15', amountCents: 100, explanation: 'x' })
    const detail = {
      client: { id: 'c1', name: 'Fictional Co', stage: 'claimed', signer: { name: 'Should Not Appear' } },
      findings: [{ id: 'f1', type: 'penalty_fta', amount_cents: 5000 }],
      transcripts: [
        { type: 'ACTR', form: '941', tax_year: 2024, period_month: 3, status: 'filed', synced_at: 's', response_date: 'r', parsed: { balanceCents: 0, txns: [txn('150'), txn('610')], returnLines: [{ label: 'a' }] }, retr: null },
        { type: 'ACTR', form: '941', tax_year: 2024, period_month: 6, status: 'filed', synced_at: 's', response_date: 'r', parsed: { balanceCents: 7, txns: [txn('150')], returnLines: [] }, retr: null },
        { type: 'ACTR', form: '1120', tax_year: 2023, period_month: 12, status: 'never_synced', synced_at: null, response_date: null, parsed: null, retr: null },
      ],
    }

    it('are read-only except the refresh, which only re-reads what is on file', () => {
      const t = tools()
      for (const n of ['practice_clients', 'practice_client', 'practice_opportunities', 'practice_coverage']) expect(t[n]?.annotations?.readOnlyHint).toBe(true)
      expect(t.practice_refresh?.annotations?.readOnlyHint).toBe(false)
    })

    it('lists periods without transactions, and opens only the one asked for', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => detail }) as Response))
      const brief = JSON.parse((await tools().practice_client.handler({ client_id: 'c1' }, {})).content[0].text)
      expect(brief.client.signer).toBeUndefined()
      expect(brief.periods.map((p: any) => `${p.form} ${p.period_month} ${p.transactions}`)).toEqual(['1120 12 undefined', '941 3 2', '941 6 1'])
      const open = JSON.parse((await tools().practice_client.handler({ client_id: 'c1', form: '941', year: 2024, month: 3 }, {})).content[0].text)
      expect(open.periods[1].transactions.map((x: any) => x.code)).toEqual(['150', '610'])
      expect(open.periods[2].transactions).toBe(1)
    })

    it('says plainly when the key has no practice', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ error: 'No practice yet.' }) }) as Response))
      expect((await tools().practice_clients.handler({}, {})).content[0].text).toMatch(/has no practice/)
    })

    it('refreshes through the read route, never the IRS-request route', async () => {
      const urls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        urls.push(url)
        return { json: async () => url.endsWith('/clients') ? { clients: [{ id: 'c1', stage: 'claimed' }, { id: 'c2', stage: 'draft' }] } : { job_id: 'j1' } } as Response
      }))
      const r = JSON.parse((await tools().practice_refresh.handler({ all: true }, {})).content[0].text)
      expect(r.queued).toBe(1)
      expect(urls.some(u => u.endsWith('/api/practice/clients/c1/read'))).toBe(true)
      expect(urls.some(u => u.includes('irs-requests'))).toBe(false)
    })

    it('sorts findings largest first and filters by type prefix', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ findings: [
        { practice_client_id: 'c1', section: 'income', type: 'penalty_fta', amount_cents: 100 },
        { practice_client_id: 'c1', section: 'income', type: 'missing_return', amount_cents: null },
        { practice_client_id: 'c2', section: 'payroll', type: 'penalty_covid_kwong', amount_cents: 900 },
      ] }) }) as Response))
      const r = JSON.parse((await tools().practice_opportunities.handler({ type: 'penalty_*' }, {})).content[0].text)
      expect(r.findings.map((f: any) => f.amount_cents)).toEqual([900, 100])
    })
  })
})
