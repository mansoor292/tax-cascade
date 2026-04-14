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

### Path A: Upload documents (prior returns, W-2s, 1099s, K-1s)
1. upload_document → get presigned S3 URL for each document
2. register_document → triggers OCR + auto-classification (detects w2/1099/k1/prior_return)
3. For prior returns: process_document → extracts, computes, saves as return
4. For W-2s, 1099s, K-1s: data is auto-extracted and stored
5. When compute_return is called, it auto-merges data from all supporting docs for that entity+year
6. IMPORTANT: Ask the user to upload ALL their W-2s, 1099s, and K-1s before computing

### Path B: Enter data manually or from QuickBooks
1. Check qbo_status — is QuickBooks connected?
2. If yes: get_financials to pull P&L + Balance Sheet, then get_qbo_mapping for field mappings
3. If no: ask the user for the numbers, or use connect_qbo to start OAuth
4. validate_return to check inputs
5. compute_return to calculate and save (auto-merges any uploaded supporting docs)

## Analysis & Scenarios
- run_scenario: create what-if scenarios. Returns: computed result, field-by-field diff vs base, input changes, PDF coverage %
- compare_scenarios: side-by-side comparison with AI recommendation
- get_scenario_pdf: generate a preview PDF for any scenario without promoting
- promote_scenario: finalize a scenario into an official return (only after user approval)
- analyze_scenario: get Gemini AI analysis of tax impact
- compute_cascade: S-Corp → K-1 → 1040 pass-through in one call
- IMPORTANT: Always pass base_return_id when creating scenarios — this enables the diff
- compute_return also returns pdf_coverage showing how complete the PDF would be

## Extensions
- validate_extension: check extension inputs before filing
- file_extension: file Form 4868 (individual), 7004 (business), or 8868 (exempt org)
- Call get_schema with form_type 4868/7004/8868 to see required fields
- Extensions can generate a filled PDF and save to the entity

## Output
- get_pdf: generate filled IRS PDF with download URL
- compare_returns: year-over-year comparison for an entity

## QuickBooks
- qbo_status: check connection
- connect_qbo: start OAuth (returns URL for user to click)
- get_financials: P&L + Balance Sheet summary (cached)
- get_qbo_report: any report — P&L detail, balance sheet detail, trial balance, GL, cash flow, transaction list, AR/AP aging, vendor/customer balances. All cached in DB.
- get_accounts: chart of accounts with balances — use to find account names for filtering
- get_transactions: search transactions by account, date range, or year. Returns individual line items.
- qbo_resource: CRUD any QBO resource (Invoice, Customer, Bill, Vendor, Employee, JournalEntry, etc). Search with WHERE/ORDERBY, or create/update/delete.
- qbo_query: raw QBO SQL for anything else
- IMPORTANT: Reports and transactions are cached in the database. Claude can query them anytime without re-fetching from QBO. Use refresh=true only when the user asks for fresh data.
- For QBO resource operations, use standard QBO API field names (e.g. DisplayName, TotalAmt, TxnDate).

## Stripe
- connect_stripe: link a Stripe account by providing the secret key (sk_live_... or rk_live_...)
- stripe_revenue: annual summary — gross, fees, net by transaction type (for tax reporting)
- stripe_invoices: list/filter invoices
- stripe_payments: list charges
- stripe_payouts: bank payouts
- stripe_customers: customer list
- Use stripe_revenue to get total Stripe income for a tax year

## Adding New Forms
- If the user needs a form we don't support, call request_form with the IRS form name and year
- The pipeline downloads the blank PDF from IRS, labels fields, runs Textract, and creates a field map
- Check progress with check_form_status
- Once active, the form shows up in get_schema automatically

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
  server.tool('get_qbo_report', 'Pull a QBO report. All reports are cached — add refresh=true to re-fetch. Available: profit-and-loss, profit-and-loss-detail, balance-sheet, balance-sheet-detail, trial-balance, general-ledger, cash-flow, transaction-list, accounts-receivable, accounts-payable, vendor-balance, customer-balance', {
    entity_id: z.string().describe('Entity UUID'),
    report: z.enum(['profit-and-loss', 'profit-and-loss-detail', 'balance-sheet', 'balance-sheet-detail', 'trial-balance', 'general-ledger', 'cash-flow', 'transaction-list', 'accounts-receivable', 'accounts-payable', 'vendor-balance', 'customer-balance']),
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
  server.tool('run_scenario', 'Create and compute a what-if tax scenario. Returns computed result, diff vs base return, input changes, and PDF coverage. Pass base_return_id to get a field-by-field comparison.', {
    entity_id: z.string().describe('Entity UUID'),
    name: z.string().describe('Scenario name'),
    tax_year: z.number().describe('Tax year'),
    adjustments: z.record(z.any()).describe('Adjusted input values'),
    base_return_id: z.string().optional().describe('Base return to compare against — enables diff'),
  }, async ({ entity_id, name, tax_year, adjustments, base_return_id }) => {
    const scenario = await call('POST', '/api/scenarios', {
      entity_id, name, tax_year, adjustments, base_return_id,
    })
    if (scenario.error) return text(scenario)
    // Compute returns rich detail: result + diff + input_changes + pdf_coverage
    const computed = await call('POST', `/api/scenarios/${scenario.scenario.id}/compute`)
    return text(computed)
  })

  // ─── Tool: compare_scenarios ───
  server.tool('compare_scenarios', 'Compare multiple scenarios with AI analysis', {
    scenario_ids: z.array(z.string()).describe('Array of scenario UUIDs to compare'),
  }, async ({ scenario_ids }) => {
    return text(await call('POST', '/api/scenarios/compare', { scenario_ids }))
  })

  // ─── Tool: get_pdf ───
  server.tool('get_pdf', 'Generate a filled IRS PDF for a computed return. Returns a download URL. Always regenerates from latest data.', {
    return_id: z.string().describe('Tax return UUID'),
  }, async ({ return_id }) => {
    return text(await call('GET', `/api/returns/${return_id}/pdf?regenerate=true`))
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
  server.tool('register_document', 'Register an uploaded document (prior return, W-2, 1099, K-1, bank statement). Triggers OCR + auto-classification + Textract extraction. W-2/1099/K-1 data auto-merges into compute_return for the same entity+year. ALWAYS pass entity_id to link the document to the correct entity.', {
    s3_key: z.string().describe('S3 key returned from upload_document'),
    filename: z.string().describe('Original filename'),
    entity_id: z.string().optional().describe('Entity UUID to link this document to — strongly recommended'),
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

  // ─── Tool: get_scenario_pdf ───
  server.tool('get_scenario_pdf', 'Generate a preview PDF for a scenario without promoting it to an official return. Use this to let the user review before committing.', {
    scenario_id: z.string().describe('Scenario UUID'),
  }, async ({ scenario_id }) => {
    return text(await call('GET', `/api/scenarios/${scenario_id}/pdf`))
  })

  // ─── Tool: promote_scenario ───
  server.tool('promote_scenario', 'Finalize a computed scenario into an official tax return. Only do this after the user has reviewed and approved the scenario.', {
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
  server.tool('connect_qbo', 'Start QuickBooks OAuth connection. Pass entity_id to link to existing entity, or pass "new" to auto-create an entity from the QBO company info. Returns an auth_url for the user to click.', {
    entity_id: z.string().describe('Entity UUID, or "new" to auto-create from QBO company info'),
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

  // ─── Tool: get_accounts ───
  server.tool('get_accounts', 'Get the chart of accounts from QuickBooks — all accounts with balances, types, and IDs. Use this to find account names for filtering transactions or reports.', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/qbo/${entity_id}/accounts`))
  })

  // ─── Tool: get_transactions ───
  server.tool('get_transactions', 'Get transactions from QuickBooks. Filter by account name, date range, or year. Returns date, type, name, memo, account, amount. Results are cached.', {
    entity_id: z.string().describe('Entity UUID'),
    year: z.number().optional().describe('Tax year to filter'),
    account: z.string().optional().describe('Account name to filter (from get_accounts)'),
    start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
  }, async ({ entity_id, year, account, start_date, end_date }) => {
    const qs = new URLSearchParams()
    if (year) qs.set('year', String(year))
    if (account) qs.set('account', account)
    if (start_date) qs.set('start_date', start_date)
    if (end_date) qs.set('end_date', end_date)
    return text(await call('GET', `/api/qbo/${entity_id}/transactions?${qs}`))
  })

  // ─── Tool: qbo_resource ───
  server.tool('qbo_resource', 'CRUD any QuickBooks resource (Invoice, Customer, Bill, Vendor, Employee, JournalEntry, Purchase, Estimate, Account, Item, Payment, etc). Supports read, search, create, update, delete.', {
    entity_id: z.string().describe('Entity UUID'),
    operation: z.enum(['read', 'search', 'create', 'update', 'delete']).describe('CRUD operation'),
    resource: z.string().describe('QBO resource type: Invoice, Customer, Bill, Vendor, Employee, JournalEntry, Purchase, Estimate, Account, Item, Payment, SalesReceipt, CreditMemo, Deposit, Transfer, etc.'),
    id: z.string().optional().describe('Resource ID (for read)'),
    where: z.string().optional().describe('WHERE clause for search (e.g. "TotalAmt > \'1000\'" or "DisplayName LIKE \'%Smith%\'")'),
    orderby: z.string().optional().describe('ORDER BY for search (e.g. "TxnDate DESC")'),
    limit: z.number().optional().describe('Max results for search (default 100)'),
    data: z.record(z.any()).optional().describe('Resource data for create/update/delete (QBO API format)'),
  }, async ({ entity_id, operation, resource, id, where, orderby, limit, data }) => {
    if (operation === 'read') {
      if (!id) return text({ error: 'id is required for read' })
      return text(await call('GET', `/api/qbo/${entity_id}/resource/${resource}/${id}`))
    } else if (operation === 'search') {
      const qs = new URLSearchParams()
      if (where) qs.set('where', where)
      if (orderby) qs.set('orderby', orderby)
      if (limit) qs.set('limit', String(limit))
      return text(await call('GET', `/api/qbo/${entity_id}/resource/${resource}?${qs}`))
    } else if (operation === 'create') {
      return text(await call('POST', `/api/qbo/${entity_id}/resource/${resource}`, data || {}))
    } else if (operation === 'update') {
      return text(await call('PUT', `/api/qbo/${entity_id}/resource/${resource}`, data || {}))
    } else if (operation === 'delete') {
      return text(await call('DELETE', `/api/qbo/${entity_id}/resource/${resource}`, data || {}))
    }
    return text({ error: 'Invalid operation' })
  })

  // ─── Tool: request_form ───
  server.tool('request_form', 'Request support for a new IRS form or tax year. Downloads the blank PDF from IRS, runs field detection via Textract, and creates the field map. Check status with get_schema afterward.', {
    form_name: z.string().describe('IRS form name (e.g. f8829, f1065, f940, f941, f1099misc). Use the f-prefix naming.'),
    year: z.number().describe('Tax year'),
  }, async ({ form_name, year }) => {
    // Trigger discovery
    const result = await call('POST', `/api/discover/${form_name}/${year}`)
    return text(result)
  })

  // ─── Tool: check_form_status ───
  server.tool('check_form_status', 'Check if a form/year is supported and its discovery status.', {
    form_name: z.string().describe('Form name (e.g. f8829, f1065)'),
    year: z.number().describe('Tax year'),
  }, async ({ form_name, year }) => {
    return text(await call('GET', `/api/discover/${form_name}/${year}/status`))
  })

  // ─── Tool: connect_stripe ───
  server.tool('connect_stripe', 'Connect a Stripe account to an entity by providing the secret API key. Verifies the key and stores it.', {
    entity_id: z.string().describe('Entity UUID'),
    stripe_key: z.string().describe('Stripe secret key (sk_live_..., sk_test_..., rk_live_..., or rk_test_...)'),
  }, async ({ entity_id, stripe_key }) => {
    return text(await call('POST', `/api/stripe/${entity_id}/connect`, { stripe_key }))
  })

  // ─── Tool: stripe_invoices ───
  server.tool('stripe_invoices', 'Get invoices from Stripe. Filter by status, customer, date range.', {
    entity_id: z.string().describe('Entity UUID'),
    status: z.string().optional().describe('Filter: draft, open, paid, void, uncollectible'),
    customer: z.string().optional().describe('Stripe customer ID'),
    limit: z.number().optional().describe('Max results (default 25)'),
    created_gte: z.string().optional().describe('Created after (Unix timestamp or YYYY-MM-DD)'),
    created_lte: z.string().optional().describe('Created before'),
  }, async ({ entity_id, ...params }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) { if (v !== undefined) qs.set(k, String(v)) }
    return text(await call('GET', `/api/stripe/${entity_id}/invoices?${qs}`))
  })

  // ─── Tool: stripe_payments ───
  server.tool('stripe_payments', 'Get payment charges from Stripe.', {
    entity_id: z.string().describe('Entity UUID'),
    limit: z.number().optional(),
    created_gte: z.string().optional(),
    created_lte: z.string().optional(),
  }, async ({ entity_id, ...params }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) { if (v !== undefined) qs.set(k, String(v)) }
    return text(await call('GET', `/api/stripe/${entity_id}/payments?${qs}`))
  })

  // ─── Tool: stripe_revenue ───
  server.tool('stripe_revenue', 'Get annual revenue summary from Stripe — gross, fees, net, broken down by transaction type. For tax reporting.', {
    entity_id: z.string().describe('Entity UUID'),
    year: z.number().optional().describe('Tax year (default current year)'),
  }, async ({ entity_id, year }) => {
    const qs = year ? `?year=${year}` : ''
    return text(await call('GET', `/api/stripe/${entity_id}/revenue${qs}`))
  })

  // ─── Tool: stripe_payouts ───
  server.tool('stripe_payouts', 'Get payouts from Stripe to bank account.', {
    entity_id: z.string().describe('Entity UUID'),
    limit: z.number().optional(),
  }, async ({ entity_id, limit }) => {
    const qs = limit ? `?limit=${limit}` : ''
    return text(await call('GET', `/api/stripe/${entity_id}/payouts${qs}`))
  })

  // ─── Tool: stripe_customers ───
  server.tool('stripe_customers', 'Get customers from Stripe.', {
    entity_id: z.string().describe('Entity UUID'),
    email: z.string().optional().describe('Filter by email'),
    limit: z.number().optional(),
  }, async ({ entity_id, email, limit }) => {
    const qs = new URLSearchParams()
    if (email) qs.set('email', email)
    if (limit) qs.set('limit', String(limit))
    return text(await call('GET', `/api/stripe/${entity_id}/customers?${qs}`))
  })

  // ─── Tool: qbo_status ───
  server.tool('qbo_status', 'Check if QuickBooks is connected for an entity', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/qbo/${entity_id}/status`))
  })

  // ─── Tool: file_extension ───
  server.tool('file_extension', 'File a tax extension (Form 4868 for individuals, 7004 for businesses, 8868 for exempt orgs). Can generate a filled PDF.', {
    extension_type: z.enum(['4868', '7004', '8868']).describe('4868=individual, 7004=business (1120/1120S/1065), 8868=exempt org'),
    tax_year: z.number().optional().describe('Tax year (default 2025)'),
    inputs: z.record(z.any()).describe('Extension form fields — call get_schema with the form type to see required fields'),
    entity_id: z.string().optional().describe('Entity UUID to save the extension against'),
    generate_pdf: z.boolean().optional().describe('Generate a filled PDF (default false)'),
  }, async ({ extension_type, tax_year, inputs, entity_id, generate_pdf }) => {
    return text(await call('POST', '/api/returns/extension', {
      extension_type, tax_year: tax_year || 2025, inputs, entity_id, generate_pdf,
    }))
  })

  // ─── Tool: validate_extension ───
  server.tool('validate_extension', 'Validate extension form inputs before filing', {
    extension_type: z.enum(['4868', '7004', '8868']).describe('4868=individual, 7004=business, 8868=exempt org'),
    inputs: z.record(z.any()).describe('Extension form fields'),
  }, async ({ extension_type, inputs }) => {
    return text(await call('POST', '/api/returns/extension/validate', { extension_type, inputs }))
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
