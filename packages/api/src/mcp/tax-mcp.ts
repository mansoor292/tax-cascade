/**
 * MCP over HTTP — Streamable HTTP transport mounted on Express
 *
 * Exposes the tax API as MCP tools so claude.ai can call them directly.
 * Tools call the REST API internally (localhost) — no external HTTP round-trip.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import type { Express, Request, Response } from 'express'

const API_BASE = `http://localhost:${process.env.PORT || 3737}`

/**
 * Call the REST API with the user's API key.
 * The key is captured from the MCP request's Authorization header
 * and threaded through every tool call via the session.
 */
async function api(token: string, method: string, path: string, body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${API_BASE}${path}`, opts)
  return resp.json()
}

function text(data: any): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

const INSTRUCTIONS = `You help users prepare and optimize tax returns using the Tax Preparation API.

## Getting Started
1. Call list_entities to see existing entities and returns
2. Call get_schema to discover supported forms (1040/1120/1120S), years (2018-2025), and required inputs
3. Call get_schema with form_type and year for the exact input fields needed

## Data Entry — Two Paths

### Path A: Upload a prior return (PDF)
1. upload_document → get presigned S3 URL
2. register_document → triggers OCR + auto-classification
3. process_document → extracts data, computes, saves as return

### Path B: Enter data manually or from QuickBooks
1. Check qbo_status — is QuickBooks connected?
2. If yes: get_financials to pull P&L + Balance Sheet, then get_qbo_mapping for field mappings
3. If no: ask the user for the numbers, or use connect_qbo to start OAuth
4. validate_return to check inputs
5. compute_return to calculate and save

## Analysis & Scenarios
- run_scenario: create what-if scenarios with adjusted inputs
- analyze_scenario: get AI analysis of a scenario's tax impact
- compare_scenarios: side-by-side comparison with recommendation
- promote_scenario: finalize a scenario into an official return
- compute_cascade: S-Corp → K-1 → 1040 pass-through in one call

## Output
- get_pdf: generate filled IRS PDF with download URL
- compare_returns: year-over-year comparison for an entity

## QuickBooks
- qbo_status: check connection
- connect_qbo: start OAuth (returns URL for user to click)
- get_financials: P&L + Balance Sheet (cached, use refresh=true for fresh data)
- get_qbo_report: individual reports (profit-and-loss, balance-sheet, trial-balance, general-ledger, cash-flow)
- qbo_query: raw QBO SQL (SELECT * FROM Account, etc.)

## Rules
- Never fabricate financial data — ask the user for missing values
- Always confirm the tax year before computing
- Call validate_return before compute_return
- For S-Corps, shareholder percentages must sum to 100%
- When QBO is connected, pull financials first before asking for manual input
- Call get_schema to discover required fields — don't guess`

function extractApiKey(req: Request): string | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const key = req.headers['x-api-key'] as string
  if (key) return key
  return null
}

function createServer(apiKey: string): McpServer {
  const server = new McpServer(
    { name: 'Tax Preparation API', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )

  const call = (method: string, path: string, body?: any) => api(apiKey, method, path, body)

  // ─── Tool: list_entities ───
  server.tool('list_entities', 'List all tax entities and their returns', {}, async () => {
    return text(await call('GET', '/api/entities'))
  })

  // ─── Tool: get_schema ───
  server.tool('get_schema', 'Get API capabilities, supported forms, years, and endpoints. Call with form_type and year for detailed input spec.', {
    form_type: z.string().optional().describe('Form type (1040, 1120, 1120S) — omit for full manifest'),
    year: z.number().optional().describe('Tax year — required if form_type provided'),
  }, async ({ form_type, year }) => {
    if (form_type && year) return text(await call('GET', `/api/schema/${form_type}/${year}`))
    if (form_type) return text(await call('GET', `/api/schema/${form_type}/2025`))
    return text(await call('GET', '/api/schema'))
  })

  // ─── Tool: get_entity ───
  server.tool('get_entity', 'Get entity details with all returns and scenarios', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/entities/${entity_id}`))
  })

  // ─── Tool: create_entity ───
  server.tool('create_entity', 'Create a new tax entity (individual, C-Corp, S-Corp)', {
    name: z.string().describe('Entity name'),
    form_type: z.string().optional().describe('1040, 1120, or 1120S'),
    ein: z.string().optional().describe('EIN or SSN'),
  }, async (params) => {
    return text(await call('POST', '/api/entities', params))
  })

  // ─── Tool: get_financials ───
  server.tool('get_financials', 'Pull QuickBooks P&L and Balance Sheet for an entity. Returns cached data unless refresh=true.', {
    entity_id: z.string().describe('Entity UUID'),
    year: z.number().optional().describe('Tax year (default: current year)'),
    refresh: z.boolean().optional().describe('Force re-fetch from QuickBooks'),
  }, async ({ entity_id, year, refresh }) => {
    const qs = new URLSearchParams()
    if (year) qs.set('year', String(year))
    if (refresh) qs.set('refresh', 'true')
    return text(await call('GET', `/api/qbo/${entity_id}/financials?${qs}`))
  })

  // ─── Tool: get_qbo_report ───
  server.tool('get_qbo_report', 'Pull a specific QBO report (profit-and-loss, balance-sheet, trial-balance, general-ledger, cash-flow)', {
    entity_id: z.string().describe('Entity UUID'),
    report: z.enum(['profit-and-loss', 'balance-sheet', 'trial-balance', 'general-ledger', 'cash-flow']),
    year: z.number().optional(),
    refresh: z.boolean().optional(),
  }, async ({ entity_id, report, year, refresh }) => {
    const qs = new URLSearchParams()
    if (year) qs.set('year', String(year))
    if (refresh) qs.set('refresh', 'true')
    return text(await call('GET', `/api/qbo/${entity_id}/reports/${report}?${qs}`))
  })

  // ─── Tool: get_qbo_mapping ───
  server.tool('get_qbo_mapping', 'Get QBO P&L category to tax form field mappings', {
    form_type: z.string().describe('1040, 1120, or 1120S'),
  }, async ({ form_type }) => {
    return text(await call('GET', `/api/schema/${form_type}/qbo-mapping`))
  })

  // ─── Tool: validate_return ───
  server.tool('validate_return', 'Validate tax return inputs before computing. Returns errors and warnings.', {
    form_type: z.string().describe('1040, 1120, or 1120S'),
    tax_year: z.number().describe('Tax year'),
    inputs: z.record(z.any()).describe('Tax return input fields'),
  }, async (params) => {
    return text(await call('POST', '/api/returns/validate', params))
  })

  // ─── Tool: compute_return ───
  server.tool('compute_return', 'Compute a tax return from structured inputs and save it', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('Tax year'),
    form_type: z.string().describe('1040, 1120, or 1120S'),
    inputs: z.record(z.any()).describe('Tax return input fields'),
    save: z.boolean().optional().describe('Save as tax_return record (default true)'),
  }, async (params) => {
    return text(await call('POST', '/api/returns/compute', params))
  })

  // ─── Tool: run_scenario ───
  server.tool('run_scenario', 'Create and compute a what-if tax scenario', {
    entity_id: z.string().describe('Entity UUID'),
    name: z.string().describe('Scenario name'),
    tax_year: z.number().describe('Tax year'),
    adjustments: z.record(z.any()).describe('Adjusted input values'),
    base_return_id: z.string().optional().describe('Base return to adjust from'),
  }, async ({ entity_id, name, tax_year, adjustments, base_return_id }) => {
    const scenario = await call('POST', '/api/scenarios', {
      entity_id, name, tax_year, adjustments, base_return_id,
    })
    if (scenario.error) return text(scenario)
    const computed = await call('POST', `/api/scenarios/${scenario.scenario.id}/compute`)
    return text({ scenario: scenario.scenario, result: computed })
  })

  // ─── Tool: compare_scenarios ───
  server.tool('compare_scenarios', 'Compare multiple scenarios with AI analysis', {
    scenario_ids: z.array(z.string()).describe('Array of scenario UUIDs to compare'),
  }, async ({ scenario_ids }) => {
    return text(await call('POST', '/api/scenarios/compare', { scenario_ids }))
  })

  // ─── Tool: get_pdf ───
  server.tool('get_pdf', 'Generate a filled IRS PDF for a computed return. Returns a download URL.', {
    return_id: z.string().describe('Tax return UUID'),
  }, async ({ return_id }) => {
    return text(await call('GET', `/api/returns/${return_id}/pdf`))
  })

  // ─── Tool: compare_returns ───
  server.tool('compare_returns', 'Compare tax returns across years for an entity', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/returns/compare/${entity_id}`))
  })

  // ─── Tool: upload_document ───
  server.tool('upload_document', 'Get a presigned S3 upload URL for a tax document (PDF, image, CSV). After uploading, call register_document.', {
    filename: z.string().describe('Filename with extension (e.g. "2022_1120.pdf")'),
  }, async ({ filename }) => {
    return text(await call('GET', `/api/documents/presign?filename=${encodeURIComponent(filename)}`))
  })

  // ─── Tool: register_document ───
  server.tool('register_document', 'Register an uploaded document. Triggers OCR classification and Textract extraction. Call after uploading to the presigned URL.', {
    s3_key: z.string().describe('S3 key returned from upload_document'),
    filename: z.string().describe('Original filename'),
    file_size: z.number().optional().describe('File size in bytes'),
  }, async (params) => {
    return text(await call('POST', '/api/documents/register', params))
  })

  // ─── Tool: process_document ───
  server.tool('process_document', 'Process an uploaded tax document into a computed return. Extracts data via Textract, maps to canonical model, runs tax engine, and saves the return.', {
    document_id: z.string().describe('Document UUID from register_document'),
    form_type: z.string().optional().describe('Override form type (1040, 1120, 1120S) if auto-detection was wrong'),
    tax_year: z.number().optional().describe('Override tax year if auto-detection was wrong'),
  }, async ({ document_id, form_type, tax_year }) => {
    const body: any = {}
    if (form_type) body.form_type = form_type
    if (tax_year) body.tax_year = tax_year
    return text(await call('POST', `/api/returns/process/${document_id}`, body))
  })

  // ─── Tool: list_documents ───
  server.tool('list_documents', 'List all uploaded documents', {}, async () => {
    return text(await call('GET', '/api/documents'))
  })

  // ─── Tool: download_document ───
  server.tool('download_document', 'Get a presigned download URL for an uploaded document', {
    document_id: z.string().describe('Document UUID'),
  }, async ({ document_id }) => {
    return text(await call('GET', `/api/documents/${document_id}/download`))
  })

  // ─── Tool: promote_scenario ───
  server.tool('promote_scenario', 'Finalize a computed scenario into an official tax return', {
    scenario_id: z.string().describe('Scenario UUID'),
  }, async ({ scenario_id }) => {
    return text(await call('POST', `/api/scenarios/${scenario_id}/promote`))
  })

  // ─── Tool: analyze_scenario ───
  server.tool('analyze_scenario', 'Get AI analysis of a tax scenario — tax impact, risks, alternatives, compliance', {
    scenario_id: z.string().describe('Scenario UUID'),
  }, async ({ scenario_id }) => {
    return text(await call('POST', `/api/scenarios/${scenario_id}/analyze`))
  })

  // ─── Tool: compute_cascade ───
  server.tool('compute_cascade', 'Compute S-Corp → K-1 → Individual 1040 cascade. Shows combined tax impact and QBI savings.', {
    s_corp_inputs: z.record(z.any()).describe('Form 1120-S inputs'),
    individual_base: z.record(z.any()).describe('Form 1040 base inputs (wages, filing_status, etc.)'),
  }, async (params) => {
    return text(await call('POST', '/api/compute/cascade', params))
  })

  // ─── Tool: get_tax_tables ───
  server.tool('get_tax_tables', 'Get tax brackets, standard deduction, and rate tables for a specific year', {
    year: z.number().describe('Tax year (2018-2025)'),
  }, async ({ year }) => {
    return text(await call('GET', `/api/tax-tables/${year}`))
  })

  // ─── Tool: update_entity ───
  server.tool('update_entity', 'Update a tax entity (name, form_type, EIN, address)', {
    entity_id: z.string().describe('Entity UUID'),
    name: z.string().optional().describe('Entity name'),
    form_type: z.string().optional().describe('1040, 1120, or 1120S'),
    ein: z.string().optional().describe('EIN or SSN'),
    address: z.string().optional().describe('Address'),
  }, async ({ entity_id, ...updates }) => {
    return text(await call('PUT', `/api/entities/${entity_id}`, updates))
  })

  // ─── Tool: connect_qbo ───
  server.tool('connect_qbo', 'Start QuickBooks OAuth connection for an entity. Returns an auth_url for the user to click.', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/qbo/connect/${entity_id}`))
  })

  // ─── Tool: qbo_query ───
  server.tool('qbo_query', 'Run a raw QuickBooks query (e.g. SELECT * FROM Account, SELECT * FROM Invoice WHERE TotalAmt > 1000)', {
    entity_id: z.string().describe('Entity UUID'),
    query: z.string().describe('QBO SQL query'),
  }, async ({ entity_id, query }) => {
    return text(await call('GET', `/api/qbo/${entity_id}/query?q=${encodeURIComponent(query)}`))
  })

  // ─── Tool: qbo_status ───
  server.tool('qbo_status', 'Check if QuickBooks is connected for an entity', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/qbo/${entity_id}/status`))
  })

  return server
}

// ─── Mount on Express (stateless — no sessions to lose on restart) ───
export function mountMCP(app: Express) {
  app.post('/mcp', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req)
    if (!apiKey) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authorization required.' },
        id: null,
      })
      return
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    })
    const server = createServer(apiKey)
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  // GET /mcp — not needed in stateless mode, but return a helpful error
  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Stateless MCP — use POST only' })
  })

  // DELETE /mcp — no-op in stateless mode
  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  console.log('  MCP endpoint: POST /mcp (stateless)')
}
