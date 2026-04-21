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

// Describe a JSON value compactly — enough to orient the model without the raw bytes.
function describeShape(v: any): any {
  if (Array.isArray(v)) return { type: 'array', length: v.length }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    return { type: 'object', keys: keys.slice(0, 25), total_keys: keys.length }
  }
  return { type: typeof v }
}

function buildPreview(v: any): any {
  if (Array.isArray(v)) return v.slice(0, 3)
  if (v && typeof v === 'object') {
    const out: any = {}
    for (const k of Object.keys(v).slice(0, 12)) {
      const val = v[k]
      if (Array.isArray(val)) out[k] = { _array_length: val.length, first_3: val.slice(0, 3) }
      else if (val && typeof val === 'object') out[k] = { _keys: Object.keys(val).slice(0, 12) }
      else out[k] = val
    }
    return out
  }
  return v
}

// If spill_to is set, persist the response under that scratch key and return a compact
// ref + shape + preview instead of the full payload. Keeps the chat context small.
// Transactional QBO resources — searching these without a WHERE clause typically
// pulls thousands of rows. We require filters (or a report/spill_to) for these.
const TRANSACTIONAL_RESOURCES = new Set([
  'Transaction', 'Invoice', 'Bill', 'Purchase', 'Payment', 'SalesReceipt',
  'CreditMemo', 'Deposit', 'Transfer', 'RefundReceipt', 'BillPayment',
  'VendorCredit', 'TimeActivity', 'JournalEntry', 'Estimate',
])

// Caps applied at the MCP layer to keep chat context small by default.
// AI can always set spill_to to park a larger result, or set limit explicitly
// (up to HARD_MAX) when it knows what it's doing.
const DEFAULT_LIMIT = 50
const HARD_MAX = 200

async function maybeSpill(
  call: (m: string, p: string, b?: any) => Promise<any>,
  response: any,
  spill_to: string | undefined,
): Promise<any> {
  if (!spill_to) return response
  const saved = await call('PUT', `/api/scratch/${encodeURIComponent(spill_to)}`, response)
  if (saved?.error) return { ...response, _spill_error: saved.error }
  return {
    spilled_to: spill_to,
    size_bytes: saved.size_bytes,
    shape: describeShape(response),
    preview: buildPreview(response),
    note: `Full payload parked in scratch. Retrieve with scratch(op:'load', key:'${spill_to}').`,
  }
}

const INSTRUCTIONS = `You help users prepare and file tax returns.

## Financial data — reports first, ALWAYS

This is the biggest source of context blowouts. Read carefully.

**The rule: never open a QBO task by pulling transactions.** Start with a report, then drill down.

Bad (context will die):
- "Show me all sales GL entries" → qbo_report(general-ledger) or qbo_resource(Transaction) with no filter
- "Get invoices for 2024" → qbo_resource(Invoice) with no where clause

Good (reports-first):
1. Call \`qbo_report(entity_id, report_type:'profit-and-loss', year:2024)\` or \`'balance-sheet'\`
   — a summary fits in a few KB. Read it, understand the shape, identify the specific line/account
   that needs deeper inspection.
2. Only then pull transaction-level data, and ALWAYS with a filter:
   \`qbo_resource(operation:'search', resource:'Invoice', where:"TxnDate >= '2024-01-01' AND TxnDate <= '2024-01-31'", limit:50)\`
3. Transactional resources (Invoice, Bill, JournalEntry, Transaction, Payment, SalesReceipt, CreditMemo,
   Deposit, Transfer, Estimate, TimeActivity, Purchase, RefundReceipt, BillPayment, VendorCredit)
   REQUIRE a \`where\` clause — the tool will reject unfiltered searches with a guidance message.
4. qbo_query auto-injects \`MAXRESULTS 50\` when you leave it off. Hard cap: 200 rows.
   Unfiltered \`SELECT FROM <transactional>\` is rejected.
5. stripe_data list modes (invoices/payments/payouts/customers) default to 50 rows, hard cap 200.

## Parking large payloads when you really need them

When you do need a bigger dataset for multi-step analysis (e.g. a full general ledger for
reconciliation), use the spill pattern:

1. \`qbo_report(entity_id, report_type:'general-ledger', year:2024, spill_to:'edgewater-2024-gl')\`
   → the full payload is written to scratch storage; you get shape + preview + a ref instead of rows.
2. \`scratch(op:'load', key:'edgewater-2024-gl')\` — fetch the bytes only when you actually need them.
3. \`scratch(op:'delete', key:'edgewater-2024-gl')\` at task end.
4. \`scratch(op:'list')\` shows what's parked (per-user, 10 MB per blob).

\`spill_to\` is supported on qbo_report, qbo_query, qbo_resource, and stripe_data.

## Starting out
Call list_entities first. Figure out what the user needs from context — don't present a menu.
To create an entity: create_entity(name, form_type). form_type drives entity_type automatically (1040→individual, 1120→c_corp, 1120S→s_corp).
delete_entity wipes an entity + all its returns/scenarios/documents/connections — confirm first.

## Uploading documents

**ingest_document is the single entry point.** Two modes:
- Inline (chat images, pasted files): \`ingest_document(filename, base64, entity_id)\`
- Pre-uploaded (user has an S3 key): \`ingest_document(filename, s3_key, entity_id)\`

Always pass entity_id or the doc won't flow into compute_return.

**Stated in conversation (no document)**: Use \`record_tax_fact(entity_id, tax_year, category, values, source_note)\`.
When the user tells you values directly ("my W-2 wages were $150K"), persist them as a virtual document
so they flow into compute_return and survive to the next session. category matches the doc_type vocabulary
(w2, 1099_int, etc.). Always include source_note so the fact is audit-traceable.

**After ingestion**: Gemini classifies (w2, 1099_int, 1099_div, 1099_r, 1099_nec, k1, prior_return_*, etc.),
Textract extracts KVs and tables, meta.key_values stores the specific boxes.
list_documents returns presigned download_url for each doc.

## Filed returns vs. computed returns — STRICT SEPARATION

Returns live in two worlds. Don't cross them.

**Filed world — IMMUTABLE.** A \`prior_return_1040/1120/1120s\` document uploaded via
\`ingest_document\` gets fully extracted into a \`tax_return\` row with \`source='filed_import'\`.
Every canonical field the mapper recognizes lands in \`field_values\` verbatim; comparison totals
(taxable_income, total_tax, total_payments, etc.) land in \`computed_data.computed\`. These rows
are ARCHIVES — \`compute_return\` will refuse to touch them. You cannot recompute a filed return.

**Working world — MUTABLE.**
- \`source='proforma'\` — current-year work. compute_return writes here by default.
- \`source='extension'\` — 4868/7004/8868 returns.
- \`source='amendment'\` — amendments are first-class peers of filed returns (not flags on them).
  Created by calling \`compute_return(amend_of: <filed_return_id>)\` which inserts a NEW row
  with \`supersedes_id\` pointing at what it amends.

Multiple rows per (entity, year, form) are allowed. compute_return routes the write:
- \`return_id: <id>\`      → UPDATE that specific row (rejected if filed_import).
- \`amend_of: <id>\`       → INSERT a new amendment row superseding that one.
- \`new_row: true\`        → force INSERT a fresh proforma (for scenario snapshots).
- (none)                 → UPDATE the latest proforma, or INSERT if none exists.

**User says "my 2024 return":**
  - For the signed PDF → \`list_documents\` (doc_type starts with \`prior_return_\`)
  - For line values   → \`tax_return\` row for 2024 (check \`source\` — filed_import is canonical)
  - Both exist once a filed PDF has been ingested.

\`compare_returns\` picks one row per year using preference filed_import > amendment > proforma
and returns the full list in \`all_rows\` so you can drill into any specific version.

\`use_prior_year\` follows the same preference and bridges filed_import canonical keys
(\`income.L1a_gross_receipts\`) → engine input names (\`gross_receipts\`) automatically.

Auto-merge into compute_return for matching entity+year:
- W-2s → wages, withholding
- 1099-INT → taxable_interest
- 1099-DIV → ordinary_dividends, qualified_dividends
- 1099-B → capital_gains
- 1099-R → ira_distributions or pensions_annuities (based on box 7 distribution code)
- 1099-NEC → net_se_income
- 1099-MISC → schedule1_income (rents + royalties + other)
- K-1 → k1_ordinary_income, schedule1_income, k1_w2_wages

IMPORTANT: the compute response includes supporting_documents.auto_merged — a list of
{field, value, sources} showing what got auto-filled. Echo these to the user for
confirmation before finalizing. A misread OCR value silently becomes the filed number otherwise.

## QuickBooks

Start with reports, drill down only with filters (see "Financial data — reports first" above).

**qbo_report** — primary tool for financial questions. Summaries are small, cache-friendly:
- \`qbo_report(entity_id, report_type:'financials', year)\` — P&L + Balance Sheet bundle (default for tax prep)
- \`qbo_report(entity_id, report_type:'profit-and-loss' | 'balance-sheet' | 'trial-balance' | 'cash-flow')\` — individual summary reports, all small
- \`qbo_report(entity_id, report_type:'general-ledger' | 'transaction-list' | 'profit-and-loss-detail' | 'balance-sheet-detail')\` — detail reports, can be huge; pass spill_to
- \`qbo_report(form_type:'1120', report_type:'mapping')\` — QBO P&L categories → tax form line mapping

Reports are cached. Pass refresh=true only when the user explicitly asks for fresh data.

**Drill-down tools** — capped at 50 rows by default to protect context:
- \`qbo_resource\` — CRUD any resource. Search on transactional resources (Invoice, Bill, JournalEntry,
  Transaction, Payment, …) REQUIRES a where clause. Master data (Account, Customer, Vendor, Employee, Item,
  Class, Department) is fine without a where.
- \`qbo_query\` — raw QBO SQL. MAXRESULTS 50 auto-injected if you leave it off, hard cap 200. Unfiltered
  SELECTs from transactional tables are rejected.
- \`get_accounts\` — chart of accounts with balances (master data, no cap).

**Connection**: \`connect_qbo(entity_id)\` both starts OAuth and reports current status — no separate status check needed. Pass entity_id='new' to auto-create an entity from QBO company info.

## Stripe
\`connect_stripe\` links an account. \`stripe_data\` is the single query dispatcher:
- \`stripe_data(entity_id, data_type='revenue', year)\` — gross/fees/net summary for tax reporting
- \`stripe_data(entity_id, data_type='invoices' | 'payments' | 'payouts' | 'customers', ...filters)\` — lists

## Computing returns

**Two paths — pick the right one first or you'll waste turns.**

1. **Corporate (1120 / 1120S) with QBO connected → use the QBO-driven path.**
   \`compute_return_from_qbo(entity_id, tax_year, form_type)\` pulls the P&L + balance sheet, maps every line to 1120/1120S inputs via the canonical mapper, and computes in one call. Response includes \`qbo_mapper.{audit, warnings, sources}\` — each line's source + confidence. Pass \`overrides\` to correct specific classifications; everything else keeps the mapper-derived value. If you want to inspect before committing, call \`qbo_to_tax_inputs\` first and hand-edit.

2. **Everything else (1040, no QBO) → classic path.** validate_return → compute_return → get_pdf.

\`compute_return\` itself also auto-pulls QBO when an 1120/1120S entity has a connection — you don't need to restate QBO numbers in \`inputs\`. Pass **only the fields you want to override or add** (1099 interest, officer_comp split, NOL carryforward, etc.). Caller-provided values ALWAYS win, including an explicit \`0\` — use that to force-zero a QBO-defaulted field.

\`qbo_warnings\` array in the response flags preparer-judgment items:
  - \`OFFICER_COMP_UNSPLIT\` — QBO lumps officer comp into salaries; split manually.
  - \`SSTB_SUSPECTED\` — business_code suggests specified service trade; affects QBI.
  - \`CONTINGENCY_IN_REVENUE\` — accrued liabilities reported as income; may need reclassification.
Always surface these to the user before finalizing.

get_pdf serves cached PDFs by default. Pass refresh=true after recomputing.
run_scenario auto-generates a preview_pdf_url in its response.
get_schema returns the input spec AND the tax tables in one call.

## 1040 Schedule E — rentals, royalties, K-1 pass-through

If the taxpayer has rental properties, partnership interests, or S-corp K-1s, pass structured \`schedule_e\` inside \`inputs\` — the engine computes per-property net, Part I totals (L23a-e, L24-26), Part II partnership total (L32), and flows L41 into Schedule 1 line 5 → 1040 line 8 automatically.

\`\`\`
inputs: {
  filing_status, wages, ...,
  schedule_e: {
    rental_properties: [
      { address, property_type, fair_rental_days, personal_use_days,
        rents, royalties, advertising, auto_travel, cleaning_maintenance,
        commissions, insurance, legal_professional, management_fees,
        mortgage_interest, other_interest, repairs, supplies, taxes,
        utilities, depreciation, other_expenses }
    ],
    partnerships: [{ name, ein, type: 'P'|'S', passive, ordinary_income }],
    estate_trust_income, remic_income, farm_rental,
    // §469 Passive Activity Loss limitation (Form 8582) — opt-in
    pal_limitation: {
      filing_status: 'mfj'|'single'|'mfs'|'hoh'|'qw',
      magi:                 <number>,  // modified AGI
      active_participation: <bool>,    // §469(i) $25K allowance gate
      prior_year_suspended_re: <number>,  // carried-forward rental loss
    }
  }
}
\`\`\`

Without pal_limitation, rental losses flow through without §469 limiting (optimistic for high-MAGI filers — always ask if they're active participants). With pal_limitation, Form 8582 is computed, the allowed loss is pro-rated across loss-making properties, and Form 8582 PDF is bundled into the 1040 package alongside Schedule E. Check \`response.schedule_e.computed.pal.suspended_rental\` for carryforward to next year.

When a \`prior_return_1040\` has Schedule E, the archive captures \`sched_e_rental_net\`, \`sched_e_partnership\`, \`sched_e_total\` in computed_data for year-over-year comparison.

## Onboarding a new QBO-connected entity

When \`connect_qbo(entity_id:'new')\` auto-creates an entity from CompanyInfo, the entity lands with \`meta.form_type_inferred: true\` and a note. QBO CANNOT distinguish S-corp from C-corp — it's a tax election QBO doesn't track. After connection:
  1. Surface \`entity.meta.qbo_company_type\` + \`form_type_inferred: true\` to the user.
  2. Ask: "QBO reports this as Corporation. Has the company elected S-corp status (Form 2553)?"
  3. If yes, \`update_entity(entity_id, form_type:'1120S')\` — entity_type auto-syncs.
  4. If no, leave as 1120.
Same ambiguity for LLCs: 1065 (multi-member), 1120 (corp-elected), 1120S (S-elected), or 1040 Schedule C (single-member disregarded).

## Missing-field review — HARD GATE

get_pdf REFUSES to generate when the return has critical fields still at zero
(NOL, IRA distributions, prior-year line items ≥ $1,000). You'll get a 400
error with \`missing_fields\` and next-steps guidance.

Flow:
  1. compute_return → check missing_fields in response
  2. If missing_fields.count > 0 with any severity="critical" items:
     - Walk the user through each one conversationally
     - Offer three options per field:
       a. "Leave blank (zero)" — confirm no activity
       b. "Use prior year" — pull last year's value (shown in prior_year_value)
       c. Provide a value now
     - Recompute with updated inputs as needed
  3. When done: either
     - Call mark_reviewed(return_id) to permanently unblock (recompute clears it)
     - Or call get_pdf(skip_review=true) for a one-off bypass
  4. get_pdf now succeeds

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
- \`run_scenario\` (pass base_return_id for diff) — returns computed result + diff + pdf_coverage + preview_pdf_url in one call.
- \`compare_scenarios(scenario_ids, include_analysis)\` — works with 1+ scenarios. One scenario = focused analysis mode; two or more = side-by-side. Structured diff is always returned; include_analysis=true adds Gemini recommendation text.
- \`promote_scenario\` — finalize into an official return (only after user approval).
- \`compute_cascade\` — S-Corp → K-1 → 1040 in one call.

## New forms
\`request_form(form_name, year)\` downloads from IRS and runs field detection. The response inlines current discovery status — call again to poll until status=active.

## Rules
- Never fabricate financial data.
- Confirm tax year before computing.
- validate_return before compute_return on the classic 1040 path.
- S-Corp shareholders must sum to 100% (pass \`shareholders: [{name, pct}]\` in 1120S inputs).
- Caller-provided inputs (even explicit \`0\`) always win over QBO / document auto-merge.
- Use get_schema to discover fields — don't guess canonical keys.
- Confirm QBO-inferred form_type for new corp/LLC connections (S vs C, 1065 vs 1120S).
- Surface \`qbo_warnings\` and \`missing_fields\` to the user before get_pdf.`

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
  server.tool('list_entities', 'List all tax entities and their tax_return rows (computed/parsed — NOT filed PDFs). Each return carries a `source` field: `filed_import` (parsed from an uploaded prior-year PDF), `proforma` (current-year work), `extension`, `amendment`. For the signed/filed PDF itself, use list_documents filtered by doc_type starting with `prior_return_`.', {}, async () => {
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
  server.tool('get_entity', 'Get entity details with all tax_return rows and scenarios. Each return has a `source` field — see list_entities for the filed_import vs. proforma distinction. Filed PDFs live in list_documents, not here.', {
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

  // ─── Tool: qbo_report ───
  // Dispatcher — replaces get_financials + get_qbo_report + get_qbo_mapping.
  server.tool('qbo_report', 'Pull a QuickBooks report or the P&L→tax-form mapping. All reports are cached — pass refresh=true to re-fetch. Use report_type=financials for the combined P&L + balance sheet used in tax prep. Use report_type=mapping to get the QBO category → tax line mapping (requires form_type). Full reports (general-ledger, transaction-list) can be huge — pass spill_to to park the payload in scratch storage and receive only a summary.', {
    entity_id: z.string().describe('Entity UUID (not required for mapping)').optional(),
    report_type: z.enum([
      'financials', 'mapping',
      'profit-and-loss', 'profit-and-loss-detail',
      'balance-sheet', 'balance-sheet-detail',
      'trial-balance', 'general-ledger', 'cash-flow', 'transaction-list',
      'accounts-receivable', 'accounts-payable',
      'vendor-balance', 'customer-balance',
    ]).describe('Which report to pull'),
    year: z.number().optional().describe('Tax year (reports only)'),
    refresh: z.boolean().optional().describe('Force re-fetch from QuickBooks (reports only)'),
    form_type: z.string().optional().describe('For report_type=mapping: 1040, 1120, or 1120S'),
    spill_to: z.string().optional().describe('Scratch key to park the full response under. Returns shape+preview+ref instead of the raw payload. Use for general-ledger, transaction-list, or any multi-year pull.'),
  }, async ({ entity_id, report_type, year, refresh, form_type, spill_to }) => {
    if (report_type === 'mapping') {
      if (!form_type) return text({ error: 'form_type required for mapping' })
      return text(await call('GET', `/api/schema/${form_type}/qbo-mapping`))
    }
    if (!entity_id) return text({ error: 'entity_id required' })
    const qs = new URLSearchParams()
    if (year) qs.set('year', String(year))
    if (refresh) qs.set('refresh', 'true')
    const path = report_type === 'financials'
      ? `/api/qbo/${entity_id}/financials?${qs}`
      : `/api/qbo/${entity_id}/reports/${report_type}?${qs}`
    const response = await call('GET', path)
    return text(await maybeSpill(call, response, spill_to))
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
  server.tool('compute_return', 'Compute a tax return from structured inputs and save it. By default, updates the latest proforma row for (entity, year, form) or creates one if none exists. Never touches filed_import rows. For amendments, pass amend_of=<filed_return_id>. For scenario snapshots, pass new_row=true. To update a specific row, pass return_id.', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('Tax year'),
    form_type: z.string().describe('1040, 1120, or 1120S'),
    inputs: z.record(z.any()).describe('Tax return input fields'),
    save: z.boolean().optional().describe('Save as tax_return record (default true)'),
    return_id: z.string().optional().describe('Update this specific row. Rejected if it is a filed_import row.'),
    amend_of: z.string().optional().describe('Start an amendment: insert a new amendment row superseding this return_id (usually a filed_import).'),
    new_row: z.boolean().optional().describe('Force INSERT a fresh proforma row instead of updating the latest one. Useful for saving scenario snapshots.'),
  }, async (params) => {
    return text(await call('POST', '/api/returns/compute', params))
  })

  // ─── Tool: qbo_to_tax_inputs ───
  // Returns the mapper packet WITHOUT computing so the caller can inspect
  // per-field classifications and override anything it disagrees with
  // before invoking compute_return.
  server.tool('qbo_to_tax_inputs', 'Map QBO P&L + Balance Sheet into 1120/1120S input fields. Returns {inputs, audit, warnings} packet — each input has a per-line audit entry citing its QBO source + confidence rule, and the warnings flag preparer-judgment items (SSTB_SUSPECTED, OFFICER_COMP_UNSPLIT, CONTINGENCY_IN_REVENUE). Use this to inspect classifications BEFORE computing; edit inputs in place and pass to compute_return. Or skip inspection and call compute_return_from_qbo for a one-shot pipeline. Schedule K portfolio items (interest/dividends/cap gains) are intentionally skipped — those come from 1099 facts during compute to avoid double-counting QBO book entries.', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('Tax year to pull QBO data for'),
    form_type: z.string().describe('1120 or 1120S'),
  }, async ({ entity_id, tax_year, form_type }) => {
    return text(await call('GET', `/api/qbo/${entity_id}/qbo-to-tax-inputs?tax_year=${tax_year}&form_type=${form_type}`))
  })

  // ─── Tool: compute_return_from_qbo ───
  // One-shot wrapper: pulls the mapper packet, applies optional overrides,
  // calls compute_return. Response includes the full compute payload PLUS
  // the mapper audit + warnings so the caller can iterate without a second
  // round-trip. Typical flow: call this first with no overrides; if the
  // result + audit surfaces a classification you disagree with, call again
  // with `overrides: { field: corrected_value }`.
  server.tool('compute_return_from_qbo', 'Pull QBO data → map to 1120/1120S inputs → apply overrides → compute in one call. Response includes the compute result plus qbo_mapper.{audit, warnings, sources, overrides_applied}. Intended to replace the multi-turn "pull P&L, hand-classify each line, total deductions, call compute" workflow with 1–3 round trips to converge. Pass overrides to correct specific classifications; all other fields keep their mapper-derived values.', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('Tax year'),
    form_type: z.string().describe('1120 or 1120S'),
    overrides: z.record(z.any()).optional().describe('Field-level overrides applied AFTER the mapper runs. E.g. {officer_compensation: 60000, salaries_wages: 177802, is_sstb: true}. Use this to correct any audit entry you disagree with.'),
    return_id: z.string().optional().describe('Update this specific row. Rejected if filed_import.'),
    amend_of: z.string().optional().describe('Start an amendment off this return_id.'),
    new_row: z.boolean().optional().describe('Force INSERT a fresh proforma row.'),
    save: z.boolean().optional().describe('Save as tax_return record (default true).'),
  }, async (params) => {
    return text(await call('POST', '/api/returns/compute_from_qbo', params))
  })

  // ─── Tool: recategorize_uncategorized ───
  server.tool('recategorize_uncategorized', 'Classify transactions currently sitting in Uncategorized / Ask-My-Accountant accounts against the entity chart of accounts via Gemini Flash Lite. Returns per-transaction suggestions with confidence + reasoning (dry-run by default). Pair with apply_recategorizations to commit the curated set.', {
    entity_id: z.string().describe('Entity UUID'),
    source_account_ids: z.array(z.string()).optional().describe('Override default auto-detect of Uncategorized* accounts'),
    start_date: z.string().optional().describe('YYYY-MM-DD (default 2020-01-01)'),
    end_date: z.string().optional().describe('YYYY-MM-DD (default today)'),
    min_confidence: z.number().optional().describe('Threshold used to compute would_apply flag (default 0.80)'),
    dry_run: z.boolean().optional().describe('Default true. Always true in current impl — apply happens via apply_recategorizations.'),
  }, async (params) => {
    return text(await call('POST', `/api/qbo/${params.entity_id}/recategorize`, params))
  })

  // ─── Tool: apply_recategorizations ───
  server.tool('apply_recategorizations', 'Apply a curated array of recategorization decisions to QBO. For each entry, fetches the transaction by (txn_id, txn_type), finds the line hitting Uncategorized, swaps its AccountRef to new_account_id, PUTs the update with SyncToken. Returns per-entry result + summary. Safety: requires confirm:true to acknowledge this modifies posted transactions. Typical flow: call recategorize_uncategorized (dry-run) → edit/filter suggestions to the ones you trust → pass the shortened list here.', {
    entity_id: z.string().describe('Entity UUID'),
    entries: z.array(z.object({
      txn_id: z.string().describe('QBO transaction Id (from recategorize suggestions[].txn_id)'),
      txn_type: z.string().describe('Transaction type label — "Expense", "Deposit", "Journal Entry", "Bill", "Credit Card Expense", etc.'),
      new_account_id: z.string().describe('Destination account ID — will be validated against the entity COA before any PUT'),
      memo: z.string().optional().describe('Optional replacement for the line Description'),
    })).describe('Curated list of decisions to apply. Omit any suggestion you disagreed with.'),
    confirm: z.boolean().describe('MUST be true — safety acknowledgement that you intend to modify QBO'),
  }, async (params) => {
    return text(await call('POST', `/api/qbo/${params.entity_id}/recategorize/apply`, params))
  })

  // ─── Tool: reconcile_bank_import ───
  server.tool('reconcile_bank_import', 'Reconcile a bank CSV against QBO transactions for an account. Server-side pipeline: (1) heuristic CSV column detection, (2) QBO TransactionList pull for the account+date range, (3) 3-tier deterministic match (exact date+amount → ±3d → fuzzy description overlap), (4) Gemini Flash Lite classifies unmatched rows against the entity chart of accounts, returning suggested_posting payloads with confidence scores. Each account_id is validated against the live COA server-side (no hallucinated IDs). Pipe the confirmed suggestions into post_transactions_batch. Eliminates the previous "parse CSV in Python → QBO query → manual date/amount match → build 77 posting payloads" workflow into one MCP turn.', {
    entity_id: z.string().describe('Entity UUID'),
    qbo_account_id: z.string().describe('QBO Account ID for the bank the CSV is for (e.g. "323" for BUS CHK)'),
    csv_data_b64: z.string().describe('Base64-encoded CSV text. Read the CSV file, base64-encode it, and pass the string here.'),
    date_range: z.object({ start: z.string(), end: z.string() }).optional().describe('Override date range for QBO pull; defaults to min/max dates in the CSV'),
  }, async (params) => {
    return text(await call('POST', `/api/qbo/${params.entity_id}/reconcile_bank`, params))
  })

  // ─── Tool: post_transactions_batch ───
  server.tool('post_transactions_batch', 'Post an array of QBO transactions in one call. Serial (QBO v3 has no native batch for arbitrary entities) with per-item success/error reported. `rollback_on_error: true` reverses any successful posts on first failure via delete/void. Use this after loan_amortization_schedule or reconcile_bank_import to land 10-120 journal entries / purchases / deposits in a single MCP turn instead of 10-120 sequential qbo_resource calls.', {
    entity_id: z.string().describe('Entity UUID'),
    transactions: z.array(z.object({
      type: z.string().describe('QBO resource type: JournalEntry, Purchase, Deposit, Transfer, Bill, Payment, etc.'),
      data: z.record(z.any()).describe('Resource payload in QBO v3 format (Line[], TxnDate, DocNumber, etc.)'),
    })).describe('Array of transactions to post'),
    rollback_on_error: z.boolean().optional().describe('If true, reverse any successful posts when the first failure hits (best-effort). Default false — partial success is kept as-is.'),
  }, async ({ entity_id, transactions, rollback_on_error }) => {
    return text(await call('POST', `/api/qbo/${entity_id}/transactions_batch`, { transactions, rollback_on_error }))
  })

  // ─── Tool: loan_amortization_schedule ───
  server.tool('loan_amortization_schedule', 'Compute a full loan amortization schedule given terms, and emit balanced QBO JournalEntry payloads ready for batch posting. Does NOT post — returns { summary, schedule[], journal_entries[] } for review. Pipe journal_entries into post_transactions_batch when ready. Useful for booking a multi-year loan (e.g. 120-month PETERLoan at 7% on $210k principal = 120 JEs), which previously required 12+ sequential qbo_resource calls.', {
    entity_id: z.string().describe('Entity UUID (used for routing; schedule is pure math)'),
    principal: z.number().describe('Principal loan amount (e.g. 210000)'),
    annual_rate: z.number().describe('Annual interest rate as decimal (0.07 = 7%)'),
    term_months: z.number().int().describe('Loan term in months (e.g. 120 for 10 years)'),
    first_payment_date: z.string().describe('First payment date YYYY-MM-DD (subsequent dates increment monthly)'),
    interest_account_id: z.string().describe('QBO account ID for interest expense (e.g. "35" Interest Paid)'),
    principal_account_id: z.string().describe('QBO account ID for the loan balance liability (reduced each month)'),
    from_account_id: z.string().describe('QBO account ID for the bank paying each monthly P&I (e.g. "323" BUS CHK)'),
    doc_number_prefix: z.string().optional().describe('Prefix for JE DocNumbers (default "LN" → "LN-001", "LN-002", ...)'),
    memo_prefix: z.string().optional().describe('Prefix for JE line descriptions (default "Loan payment")'),
  }, async ({ entity_id, ...body }) => {
    return text(await call('POST', `/api/qbo/${entity_id}/loan-amortization-schedule`, body))
  })

  // ─── Tool: run_scenario ───
  server.tool('run_scenario', 'Create and compute a what-if tax scenario. Returns computed result, diff vs base return, input changes, PDF coverage, and a preview_pdf_url you can hand directly to the user. Pass base_return_id to get a field-by-field comparison.', {
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
    const scenarioId = scenario.scenario.id
    const computed = await call('POST', `/api/scenarios/${scenarioId}/compute`)
    // Auto-generate preview PDF so the caller has a link without a second round-trip
    let preview_pdf_url: string | null = null
    try {
      const pdfResp = await call('GET', `/api/scenarios/${scenarioId}/pdf`)
      preview_pdf_url = pdfResp?.url || null
    } catch {}
    return text({ ...computed, preview_pdf_url })
  })

  // ─── Tool: compare_scenarios ───
  // Works for 1 scenario (analyze mode) or 2+ (side-by-side). Pass include_analysis=true
  // to get Gemini's recommendation/analysis text; default returns structured diff only.
  server.tool('compare_scenarios', 'Compare one or more scenarios. Default returns structured side-by-side (total tax, balance due, AGI, adjustments). Pass include_analysis=true for Gemini-generated recommendation text. Single-scenario mode gives a focused AI analysis of that scenario.', {
    scenario_ids: z.array(z.string()).describe('Scenario UUIDs. One scenario → AI analysis mode; two or more → side-by-side comparison.'),
    include_analysis: z.boolean().optional().describe('Include Gemini-generated analysis/recommendation text (slower). Default: false — structured data only.'),
  }, async ({ scenario_ids, include_analysis }) => {
    return text(await call('POST', '/api/scenarios/compare', { scenario_ids, include_analysis }))
  })

  // ─── Tool: get_pdf ───
  server.tool('get_pdf', 'Generate a filled IRS PDF for a computed return. The API REFUSES to generate if critical fields are still missing — walk the user through review_return first, then call this with skip_review=true (or mark_reviewed) to confirm. Uses cached PDF if available — pass refresh=true to regenerate.', {
    return_id: z.string().describe('Tax return UUID'),
    refresh: z.boolean().optional().describe('Force regeneration from latest data (default: false)'),
    skip_review: z.boolean().optional().describe('Bypass the critical-fields-missing gate. ONLY use after confirming with the user that missing fields should stay blank.'),
  }, async ({ return_id, refresh, skip_review }) => {
    const qs = new URLSearchParams()
    if (refresh) qs.set('regenerate', 'true')
    if (skip_review) qs.set('skip_review', 'true')
    const q = qs.toString() ? '?' + qs.toString() : ''
    return text(await call('GET', `/api/returns/${return_id}/pdf${q}`))
  })

  // ─── Tool: mark_reviewed ───
  server.tool('mark_reviewed', 'Mark a return as reviewed — user has confirmed the missing fields are intentional. Unblocks get_pdf. Automatically cleared if the return is recomputed (inputs change).', {
    return_id: z.string().describe('Tax return UUID'),
  }, async ({ return_id }) => {
    return text(await call('POST', `/api/returns/${return_id}/review`))
  })

  // ─── Tool: delete_return ───
  server.tool('delete_return', 'Delete a tax return permanently. Also deletes any what-if scenarios that referenced this return as their base. Confirm with the user before calling — this is destructive and irreversible.', {
    return_id: z.string().describe('Tax return UUID'),
  }, async ({ return_id }) => {
    return text(await call('DELETE', `/api/returns/${return_id}`))
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
      source: ret.source,
      missing_fields: (recomputed as any)?.missing_fields,
      pdf_coverage: (recomputed as any)?.pdf_coverage,
      note: 'Walk the user through each missing field before calling get_pdf. Group by category for efficient questions.',
    })
  })

  // ─── Tool: use_prior_year ───
  server.tool('use_prior_year', 'Copy values from the prior-year tax_return row (NOT the filed PDF — from the parsed/structured cache). Works equally on filed_import rows (parsed from an uploaded PDF) and proforma rows (computed earlier). Response includes `prior_source` so you can tell the user whether you pulled from a filed return or a prior proforma. Only fills blanks — won\'t overwrite user-provided values. Returns merged_inputs that you pass to compute_return.', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('CURRENT tax year (prior year = this - 1)'),
    form_type: z.string().describe('1040, 1120, 1120S'),
    fields: z.array(z.string()).optional().describe('Specific input fields to copy (e.g. ["nol_deduction", "officer_compensation"]). If omitted, copies every numeric input that has a value last year and is blank this year.'),
  }, async ({ entity_id, tax_year, form_type, fields }) => {
    return text(await call('POST', '/api/returns/use-prior-year', { entity_id, tax_year, form_type, fields }))
  })

  // ─── Tool: compare_returns ───
  server.tool('compare_returns', 'Compare tax returns across years for an entity', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/returns/compare/${entity_id}`))
  })

  // ─── Tool: record_tax_fact ───
  // When the user states tax info in conversation (no document attached),
  // persist it so it flows into THIS compute AND future recomputes.
  server.tool('record_tax_fact', 'Persist a tax fact from conversation (no document needed). Use when the user tells you values directly: "I got $10K interest from Chase", "My W-2 wages were $150K". Creates a virtual document that auto-merges into compute_return for this entity+year, just like an uploaded W-2 or 1099. Always include a source_note describing where the info came from (e.g. "client stated on call 2026-04-17") so it\'s audit-traceable.', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('Tax year this fact applies to'),
    category: z.enum([
      'w2', 'k1',
      '1099_int', '1099_div', '1099_b', '1099_r', '1099_misc', '1099_nec',
      '1099_k', '1099_g', '1099_sa', '1099_oid', '1099',
      'bank_statement', 'rental_income', 'business_income', 'other',
    ]).describe('What kind of tax data this is — matches the doc_type vocabulary so auto-merge routes it correctly'),
    values: z.record(z.any()).describe('The box-level values. Use the same field names Gemini uses on real documents: W-2 → {box_1: 150000, box_2: 25000}, 1099-INT → {interest: 10000}, 1099-DIV → {ordinary_dividends: 500, qualified_dividends: 300}, 1099-R → {gross_distribution: 20000, distribution_code: "7"}, K-1 → {ordinary_income: 50000, w2_wages: 10000}'),
    source_note: z.string().optional().describe('Provenance — where this info came from. E.g. "client phone call 2026-04-17", "from attached bank statement summary", "user confirmed via chat". Shows up in audit trail.'),
    summary: z.string().optional().describe('One-line human description'),
  }, async (params) => {
    return text(await call('POST', '/api/documents/fact', params))
  })

  // ─── Tool: ingest_document ───
  // Dual-mode: pass `base64` for inline content (image pasted in chat),
  // or pass `s3_key` when the file was pre-uploaded via the presign flow.
  server.tool('ingest_document', 'Upload a tax document (W-2, 1099, K-1, prior return, etc.). Two modes: (a) inline — pass {filename, base64, entity_id} when the user shares a file directly in chat; (b) pre-uploaded — pass {filename, s3_key, entity_id} if a presigned upload URL was used separately. Runs Gemini classification + Textract extraction, saves the record, auto-processes prior returns. Always pass entity_id — without it the doc won\'t flow into compute_return.', {
    filename: z.string().describe('Filename with extension (e.g. "W2_2024.jpg", "1099-INT.pdf", "K1.png")'),
    base64: z.string().optional().describe('Base64-encoded file content (no data: prefix). Use this for inline images/files from chat. Mutually exclusive with s3_key.'),
    s3_key: z.string().optional().describe('S3 key for a file already uploaded via /api/documents/presign. Mutually exclusive with base64.'),
    entity_id: z.string().describe('Entity UUID to link this document to. REQUIRED — without it the doc won\'t flow into compute_return.'),
    file_size: z.number().optional().describe('File size in bytes (s3_key mode)'),
  }, async (params) => {
    return text(await call('POST', '/api/documents/ingest', params))
  })

  // ─── Tool: list_documents ───
  server.tool('list_documents', 'List all uploaded documents (authoritative source for filed/signed PDFs). Documents with doc_type starting with `prior_return_` (prior_return_1040/1120/1120s) ARE the filed returns the user uploaded. Each doc includes a presigned download_url (1-hour expiry). For the parsed line-by-line data from those filed returns, see the matching tax_return row via list_entities (source=filed_import).', {}, async () => {
    return text(await call('GET', '/api/documents'))
  })

  // ─── Tool: scratch ───
  // Per-user JSON blob store for parking large intermediate results outside the chat
  // context. Keyed by names the caller picks. Backed by the `ai-scratch` Supabase bucket.
  server.tool('scratch', 'Park large intermediate results outside the chat context. Use for: full QBO transaction lists, Stripe exports, multi-year snapshots, anything you need to hold but don\'t need to read right now. Keys you choose — use descriptive names like "edgewater-2024-gl". Scoped to the current user (not per-entity). 10 MB per blob.', {
    op: z.enum(['save', 'load', 'list', 'delete']).describe('save: store data under key. load: fetch stored data. list: see what\'s parked (optional prefix). delete: remove.'),
    key: z.string().optional().describe('Scratch key (required for save/load/delete). Alphanumeric + . _ - : — no slashes.'),
    data: z.any().optional().describe('JSON to store (save only)'),
    prefix: z.string().optional().describe('List filter (list only)'),
  }, async ({ op, key, data, prefix }) => {
    if (op === 'save') {
      if (!key) return text({ error: 'key required for save' })
      return text(await call('PUT', `/api/scratch/${encodeURIComponent(key)}`, data ?? {}))
    }
    if (op === 'load') {
      if (!key) return text({ error: 'key required for load' })
      return text(await call('GET', `/api/scratch/${encodeURIComponent(key)}`))
    }
    if (op === 'list') {
      const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
      return text(await call('GET', `/api/scratch${qs}`))
    }
    if (op === 'delete') {
      if (!key) return text({ error: 'key required for delete' })
      return text(await call('DELETE', `/api/scratch/${encodeURIComponent(key)}`))
    }
    return text({ error: 'Invalid op' })
  })

  // ─── Tool: promote_scenario ───
  server.tool('promote_scenario', 'Finalize a computed scenario into an official tax return. Only do this after the user has reviewed and approved the scenario.', {
    scenario_id: z.string().describe('Scenario UUID'),
  }, async ({ scenario_id }) => {
    return text(await call('POST', `/api/scenarios/${scenario_id}/promote`))
  })

  // ─── Tool: compute_cascade ───
  server.tool('compute_cascade', 'Compute S-Corp → K-1 → Individual 1040 cascade. Shows combined tax impact and QBI savings.', {
    s_corp_inputs: z.record(z.any()).describe('Form 1120-S inputs'),
    individual_base: z.record(z.any()).describe('Form 1040 base inputs (wages, filing_status, etc.)'),
  }, async (params) => {
    return text(await call('POST', '/api/compute/cascade', params))
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

  // ─── Tool: delete_entity ───
  server.tool('delete_entity', 'Delete an entity and everything linked to it: returns, scenarios, documents, and QBO/Stripe connections. Destructive and irreversible — confirm with the user first.', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('DELETE', `/api/entities/${entity_id}`))
  })

  // ─── Tool: connect_qbo ───
  // Also reports current connection status (folds in the old qbo_status tool).
  server.tool('connect_qbo', 'Start or check a QuickBooks OAuth connection. Pass entity_id to link to existing entity, or pass "new" to auto-create from QBO company info. Response includes the current connection status — if already connected, an auth_url is not needed.', {
    entity_id: z.string().describe('Entity UUID, or "new" to auto-create from QBO company info'),
  }, async ({ entity_id }) => {
    const connect = await call('GET', `/api/qbo/connect/${entity_id}`)
    if (entity_id === 'new') return text(connect)
    try {
      const status = await call('GET', `/api/qbo/${entity_id}/status`)
      return text({ ...connect, status })
    } catch {
      return text(connect)
    }
  })

  // ─── Tool: qbo_query ───
  server.tool('qbo_query', `Run a raw QuickBooks SQL query. Auto-injects MAXRESULTS ${DEFAULT_LIMIT} when you don't specify one (hard cap ${HARD_MAX}). Transactional tables (Invoice, Bill, JournalEntry, Transaction, Payment, …) REQUIRE a WHERE clause — unfiltered SELECTs are rejected. Use qbo_report for summaries (P&L, BS, GL) before drilling into transactions.`, {
    entity_id: z.string().describe('Entity UUID'),
    query: z.string().describe(`QBO SQL. Examples: "SELECT * FROM Account" (master data, fine), "SELECT * FROM Invoice WHERE TxnDate >= '2024-01-01' MAXRESULTS 50". Unfiltered SELECTs from transactional tables are rejected.`),
    spill_to: z.string().optional().describe('Scratch key to park the full response under. Use when the query is broad.'),
  }, async ({ entity_id, query, spill_to }) => {
    // Guardrail 1: unbounded SELECT on transactional tables
    const tableMatch = query.match(/FROM\s+(\w+)/i)
    const table = tableMatch?.[1]
    if (table && TRANSACTIONAL_RESOURCES.has(table) && !/\bWHERE\b/i.test(query)) {
      return text({
        error: `SELECT from ${table} requires a WHERE clause.`,
        reason: `Unfiltered ${table} queries pull thousands of rows and blow the context window.`,
        suggestions: [
          `Add a date filter: WHERE TxnDate >= '2024-01-01' AND TxnDate <= '2024-01-31'`,
          `Add an amount filter: WHERE TotalAmt > '1000'`,
          `For summary analysis, call qbo_report(report_type='profit-and-loss' or 'balance-sheet' or 'general-ledger') instead`,
          `If you must pull everything, set spill_to:'<key>' to park the result in scratch`,
        ],
      })
    }
    // Guardrail 2: inject MAXRESULTS if not specified, cap at hard max
    let effectiveQuery = query.trim()
    const maxMatch = effectiveQuery.match(/MAXRESULTS\s+(\d+)/i)
    if (!maxMatch) {
      effectiveQuery = `${effectiveQuery} MAXRESULTS ${DEFAULT_LIMIT}`
    } else if (parseInt(maxMatch[1]) > HARD_MAX) {
      effectiveQuery = effectiveQuery.replace(/MAXRESULTS\s+\d+/i, `MAXRESULTS ${HARD_MAX}`)
    }
    const response = await call('GET', `/api/qbo/${entity_id}/query?q=${encodeURIComponent(effectiveQuery)}`)
    return text(await maybeSpill(call, response, spill_to))
  })

  // ─── Tool: get_accounts ───
  server.tool('get_accounts', 'Get the chart of accounts from QuickBooks — all accounts with balances, types, and IDs. Use this to find account names for filtering transactions or reports.', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('GET', `/api/qbo/${entity_id}/accounts`))
  })

  // ─── Tool: qbo_resource ───
  server.tool('qbo_resource', `CRUD any QuickBooks resource (Invoice, Customer, Bill, Vendor, Employee, JournalEntry, Purchase, Estimate, Account, Item, Payment, etc). Supports read, search, create, update, delete. Search defaults to ${DEFAULT_LIMIT} rows, hard-capped at ${HARD_MAX}. Transactional resources (Invoice, Bill, JournalEntry, Transaction, Payment, …) REQUIRE a where clause — without one, the call is rejected. For broader analysis, call qbo_report(report_type='profit-and-loss'/'balance-sheet'/'general-ledger') first and drill down afterward.`, {
    entity_id: z.string().describe('Entity UUID'),
    operation: z.enum(['read', 'search', 'create', 'update', 'delete']).describe('CRUD operation'),
    resource: z.string().describe('QBO resource type: Invoice, Customer, Bill, Vendor, Employee, JournalEntry, Purchase, Estimate, Account, Item, Payment, SalesReceipt, CreditMemo, Deposit, Transfer, etc.'),
    id: z.string().optional().describe('Resource ID (for read)'),
    where: z.string().optional().describe('WHERE clause for search. REQUIRED for transactional resources. Example: "TxnDate >= \'2024-01-01\' AND TxnDate <= \'2024-01-31\'" or "TotalAmt > \'1000\'".'),
    orderby: z.string().optional().describe('ORDER BY for search (e.g. "TxnDate DESC")'),
    limit: z.number().optional().describe(`Max results for search. Default ${DEFAULT_LIMIT}, hard cap ${HARD_MAX}. Values above ${HARD_MAX} are clamped.`),
    data: z.record(z.any()).optional().describe('Resource data for create/update/delete (QBO API format)'),
    spill_to: z.string().optional().describe('Scratch key to park a search response under (applies to operation=search only).'),
  }, async ({ entity_id, operation, resource, id, where, orderby, limit, data, spill_to }) => {
    if (operation === 'read') {
      if (!id) return text({ error: 'id is required for read' })
      return text(await call('GET', `/api/qbo/${entity_id}/resource/${resource}/${id}`))
    } else if (operation === 'search') {
      // Force a filter on transactional resources — otherwise the result set is huge.
      if (TRANSACTIONAL_RESOURCES.has(resource) && !where) {
        return text({
          error: `Search on ${resource} requires a where clause.`,
          reason: `Unfiltered ${resource} queries pull thousands of rows and blow the context window.`,
          suggestions: [
            `Add a date filter: where:"TxnDate >= '2024-01-01' AND TxnDate <= '2024-01-31'"`,
            `Add an amount filter: where:"TotalAmt > '1000'"`,
            `For trend/summary analysis, call qbo_report(report_type='profit-and-loss' or 'balance-sheet' or 'general-ledger') instead`,
            `If you must pull everything, set spill_to:'<key>' to park the result in scratch storage`,
          ],
        })
      }
      const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, HARD_MAX)
      const qs = new URLSearchParams()
      if (where) qs.set('where', where)
      if (orderby) qs.set('orderby', orderby)
      qs.set('limit', String(effectiveLimit))
      const response = await call('GET', `/api/qbo/${entity_id}/resource/${resource}?${qs}`)
      return text(await maybeSpill(call, response, spill_to))
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
  // Response includes the live discovery status record inline (folds in the old check_form_status tool).
  // Call again later to poll; when status becomes "active" the form is ready to use.
  server.tool('request_form', 'Request support for a tax form. Default: downloads the blank PDF from IRS. For state forms (NY IT-201, CA 540, etc.) or anything not on irs.gov, pass base64 OR s3_key so the API processes your PDF directly — field detection via Textract then builds the field map. Response includes current discovery status; call again to poll until status=active.', {
    form_name: z.string().describe('Form name used as the storage key (e.g. f8829 for IRS, it201 for NY IT-201, ca540 for CA 540). Becomes part of the local path and field-map key.'),
    year: z.number().describe('Tax year'),
    base64: z.string().optional().describe('Base64-encoded blank PDF (no data: prefix). Use for state forms or any form not on irs.gov. Mutually exclusive with s3_key.'),
    s3_key: z.string().optional().describe('S3 key of a pre-uploaded blank PDF. Mutually exclusive with base64.'),
  }, async ({ form_name, year, base64, s3_key }) => {
    const body: any = {}
    if (base64) body.base64 = base64
    if (s3_key) body.s3_key = s3_key
    return text(await call('POST', `/api/discover/${form_name}/${year}`, body))
  })

  // ─── Tool: connect_stripe ───
  server.tool('connect_stripe', 'Connect a Stripe account to an entity by providing the secret API key. Verifies the key and stores it.', {
    entity_id: z.string().describe('Entity UUID'),
    stripe_key: z.string().describe('Stripe secret key (sk_live_..., sk_test_..., rk_live_..., or rk_test_...)'),
  }, async ({ entity_id, stripe_key }) => {
    return text(await call('POST', `/api/stripe/${entity_id}/connect`, { stripe_key }))
  })

  // ─── Tool: stripe_data ───
  // Dispatcher — replaces stripe_invoices, stripe_payments, stripe_payouts, stripe_customers, stripe_revenue.
  server.tool('stripe_data', 'Query Stripe data for an entity. Use data_type=revenue for the annual gross/fees/net summary used in tax reporting. Other types return lists — support common filters. Year-long invoice/payment pulls can be huge — pass spill_to to park them in scratch storage.', {
    entity_id: z.string().describe('Entity UUID'),
    data_type: z.enum(['invoices', 'payments', 'payouts', 'customers', 'revenue']).describe('What to pull'),
    year: z.number().optional().describe('Tax year (revenue only)'),
    status: z.string().optional().describe('Invoice status: draft, open, paid, void, uncollectible'),
    customer: z.string().optional().describe('Stripe customer ID (invoices only)'),
    email: z.string().optional().describe('Email filter (customers only)'),
    limit: z.number().optional().describe('Max results'),
    created_gte: z.string().optional().describe('Date floor (Unix ts or YYYY-MM-DD) — invoices/payments'),
    created_lte: z.string().optional().describe('Date ceiling — invoices/payments'),
    spill_to: z.string().optional().describe('Scratch key to park the full response under. Use for year-spanning invoice/payment/customer lists.'),
  }, async ({ entity_id, data_type, year, spill_to, ...filters }) => {
    let response: any
    if (data_type === 'revenue') {
      const qs = year ? `?year=${year}` : ''
      response = await call('GET', `/api/stripe/${entity_id}/revenue${qs}`)
    } else {
      // Cap list responses at DEFAULT_LIMIT / HARD_MAX to keep chat context small.
      // Caller can still bump it up to HARD_MAX; above that we clamp.
      const effectiveLimit = Math.min(Number(filters.limit) || DEFAULT_LIMIT, HARD_MAX)
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(filters)) {
        if (k === 'limit') continue
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      }
      qs.set('limit', String(effectiveLimit))
      response = await call('GET', `/api/stripe/${entity_id}/${data_type}?${qs}`)
    }
    return text(await maybeSpill(call, response, spill_to))
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
