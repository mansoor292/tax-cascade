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

const INSTRUCTIONS = `You help users prepare and file tax returns.

## Starting out
Call list_entities first. Figure out what the user needs from context — don't present a menu.
To create an entity: create_entity(name, form_type). form_type drives entity_type automatically (1040→individual, 1120→c_corp, 1120S→s_corp).

## Uploading documents
upload_document → register_document (with entity_id) → process_document.
OCR + classification is automatic. Prior returns get fully extracted and computed. W-2s, 1099s, K-1s auto-merge into compute_return for the same entity+year.

## QuickBooks

**Reports are cached.** get_financials and get_qbo_report store results in the database. Subsequent calls return the cached copy. Use refresh=true ONLY when the user explicitly asks for fresh data.

Cached reports: profit-and-loss, profit-and-loss-detail, balance-sheet, balance-sheet-detail, trial-balance, general-ledger, cash-flow, transaction-list, accounts-receivable, accounts-payable, vendor-balance, customer-balance.

**Everything else is live.** qbo_resource, qbo_query, get_accounts, and get_transactions hit the QBO API directly. Use these freely to look up specific items — invoices, bills, vendors, customers, journal entries, account balances, individual transactions. They're fast. Don't pull a full report just to find one number.

get_qbo_mapping shows how QBO P&L categories map to tax form lines.

## Stripe
connect_stripe links an account. stripe_revenue gives annual gross/fees/net for tax reporting. stripe_invoices, stripe_payments, stripe_payouts, stripe_customers for details.

## Computing returns
validate_return → compute_return → get_pdf.
get_pdf and get_scenario_pdf serve cached PDFs by default. Pass refresh=true after recomputing a return or updating data to regenerate.
Ask for data conversationally — group by topic (income, deductions, payments). Use get_schema to discover required fields.

## Missing-field review — critical

Before finalizing a return, compute_return's response includes a \`missing_fields\`
list (lines the taxpayer has no value for). When it's non-trivial, DO NOT silently
generate the PDF. Walk the user through each missing line and ask how to resolve:

  For each missing field, offer three options:
    a. "Leave blank (zero)" — confirm they truly had no activity on this line
    b. "Use prior year" — pull the value from last year's return if available
    c. Provide a value now — they answer the question directly

Examples where this matters:
  - 1040 line 4 IRA distributions: silently defaulting to 0 is wrong if they
    had IRA income they forgot to mention
  - 1120 line 29a NOL carryforward: critical; a stale $0 default loses real tax benefit
  - Schedule L balance sheet rows: 0 is appropriate for an account type the
    business doesn't use, but confirm for material lines like inventory, loans

Present missing fields in plain English (use the \`description\` from get_schema),
not canonical keys. Group by section so the user can answer in batches:
  "A few 1040 items I want to confirm before filing — any of these apply?"
    - IRA distributions (line 4a)?
    - Pensions/annuities (line 5a)?
    - Social Security benefits (line 6a)?
    - Additional child tax credit (line 28)?

If the user says "use prior year," pull last year's computed return via
compare_returns or list their returns and use those values. If they say
"leave blank," explicitly confirm by echoing the line back so they know what
they're signing off on.

## Extensions (4868/7004/8868)
Extensions are time-sensitive. Collect the minimum: name, SSN/EIN, address, estimated tax liability, payments already made.
validate_extension → file_extension(generate_pdf: true) → give them the PDF.

Key inputs for 4868: taxpayer_name, taxpayer_id, address, city, state, zip, estimated_tax_liability, total_payments, amount_paying.
For 7004: add form_code ("12"=1120, "25"=1120-S, "09"=1065).
For 8868: add return_code ("01"=990, "04"=990-PF).

## Scenarios
run_scenario (pass base_return_id for diff), compare_scenarios, get_scenario_pdf, promote_scenario, analyze_scenario, compute_cascade (S-Corp→K-1→1040).

## New forms
request_form + check_form_status. Downloads from IRS, runs Textract. Shows up in get_schema when ready.

## Rules
- Never fabricate financial data
- Confirm tax year before computing
- validate_return before compute_return
- S-Corp shareholders must sum to 100%
- Use get_schema to discover fields — don't guess`

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
  server.tool('create_entity', 'Create a new tax entity (individual, C-Corp, S-Corp). entity_type is auto-derived from form_type if omitted (1040→individual, 1120→c_corp, 1120S→s_corp).', {
    name: z.string().describe('Entity name (person or business)'),
    form_type: z.string().optional().describe('Tax form: 1040, 1120, 1120S, 1065, 990'),
    entity_type: z.string().optional().describe('Entity type: individual, c_corp, s_corp, partnership, llc, nonprofit. Auto-derived from form_type if omitted.'),
    ein: z.string().optional().describe('EIN (business) or SSN (individual)'),
    address: z.string().optional().describe('Street address'),
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
  server.tool('get_pdf', 'Generate a filled IRS PDF for a computed return. Returns a presigned download URL. Uses cached PDF if available — pass refresh=true to regenerate from latest data (e.g. after recomputing the return or updating schedules).', {
    return_id: z.string().describe('Tax return UUID'),
    refresh: z.boolean().optional().describe('Force regeneration from latest data (default: false — serves cached PDF if available)'),
  }, async ({ return_id, refresh }) => {
    const qs = refresh ? '?regenerate=true' : ''
    return text(await call('GET', `/api/returns/${return_id}/pdf${qs}`))
  })

  // ─── Tool: review_return ───
  server.tool('review_return', 'QC review of a saved return: lists fields still at 0/blank so you can walk the user through them before finalizing the PDF. For each missing field, ask the user (a) leave blank, (b) use prior year, or (c) provide a value.', {
    return_id: z.string().describe('Tax return UUID'),
  }, async ({ return_id }) => {
    // Fetch the return and run the same missing-fields analysis as compute_return
    const r = await call('GET', `/api/returns/${return_id}`) as any
    const ret = r.return
    if (!ret) return text({ error: 'return not found' })
    // Rerun compute against existing inputs to get a fresh missing_fields list
    const recomputed = await call('POST', '/api/returns/compute', {
      entity_id: ret.entity_id,
      tax_year: ret.tax_year,
      form_type: ret.form_type,
      inputs: ret.input_data || {},
      save: false,
    })
    return text({
      return_id,
      form_type: ret.form_type,
      tax_year: ret.tax_year,
      missing_fields: (recomputed as any)?.missing_fields,
      pdf_coverage: (recomputed as any)?.pdf_coverage,
      note: 'Walk the user through each missing field before calling get_pdf. Group by category for efficient questions.',
    })
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
  server.tool('get_scenario_pdf', 'Generate a preview PDF for a scenario without promoting it to an official return. Uses cached PDF if available — pass refresh=true to regenerate.', {
    scenario_id: z.string().describe('Scenario UUID'),
    refresh: z.boolean().optional().describe('Force regeneration (default: false)'),
  }, async ({ scenario_id, refresh }) => {
    const qs = refresh ? '?regenerate=true' : ''
    return text(await call('GET', `/api/scenarios/${scenario_id}/pdf${qs}`))
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
  server.tool('update_entity', 'Update a tax entity. Address is split into separate street/city/state/zip fields since the PDF pulls them individually. Use meta_merge for other metadata (preparer, title, business_code, etc.) without overwriting existing meta.', {
    entity_id: z.string().describe('Entity UUID'),
    name: z.string().optional().describe('Entity name'),
    form_type: z.string().optional().describe('1040, 1120, 1120S, 1065, 990'),
    ein: z.string().optional().describe('EIN (9 digits, no dash) or SSN (9 digits for individuals)'),
    address: z.string().optional().describe('Street address (line 1 only). City/state/zip are separate.'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('State (2-letter abbreviation)'),
    zip: z.string().optional().describe('ZIP code'),
    date_incorporated: z.string().optional().describe('Date incorporated / S-election date (YYYY-MM-DD)'),
    meta_merge: z.record(z.any()).optional().describe('Shallow-merge into meta. Use for preparer info ({preparer: {name, ptin, firm_name, firm_ein, firm_address, phone}}), title, business_code, etc. Preserves existing meta keys.'),
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
