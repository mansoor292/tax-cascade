/**
 * MCP over HTTP — Streamable HTTP transport mounted on Express
 *
 * Exposes the tax API as MCP tools so claude.ai can call them directly.
 * Tools call the REST API internally (localhost) — no external HTTP round-trip.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
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

/**
 * Same call, but hand back the raw body. Needed for endpoints that answer with
 * something other than JSON — the CSV export in particular, where parsing the
 * response as JSON would throw on the first comma.
 */
async function apiText(token: string, method: string, path: string): Promise<string> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}` },
  })
  return resp.text()
}

/**
 * Mask tax identifiers before ANY tool response reaches a model.
 *
 * Client finding, 2026-09-01 (SOP-02 retest): the first answer displayed the
 * individual's full SSN and both entities' full EINs in plain text. The web
 * UI has masked these since the original full-SSN report (web/src/lib/mask.ts)
 * — but the MCP fed models the raw values and relied on the model choosing
 * not to repeat them. Her requirement, verbatim in spirit: mask at the data
 * boundary, before the value reaches the model, not after. A model never
 * needs a full SSN/EIN — last-4 identifies; the server fills PDFs from the
 * database, not from what the model sends back.
 *
 * Same shape-preserving mask as the web UI: 123-45-6789 → •••-••-6789.
 * Two layers: known key names (ein, ssn, spouse_ssn, ein_or_ssn, *_ein,
 * *_ssn) are masked outright; SSN/EIN-shaped digit runs inside free text
 * (summaries, source notes, filenames) are masked by pattern.
 */
function maskTaxId(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4) return '•'.repeat(value.length)
  const last4 = digits.slice(-4)
  let seen = 0
  const total = digits.length
  return value
    .split('')
    .map((ch) => {
      if (!/\d/.test(ch)) return ch
      seen++
      return seen > total - 4 ? last4[4 - (total - seen) - 1] : '•'
    })
    .join('')
}

const TAX_ID_KEY = /^(ein|ssn|spouse_ssn|ein_or_ssn)$|_(ein|ssn)$/
const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/g
const EIN_SHAPE = /\b\d{2}-\d{7}\b/g

function maskTaxIdsDeep(node: any, key?: string): any {
  if (typeof node === 'string') {
    if (key && TAX_ID_KEY.test(key)) return maskTaxId(node)
    return node.replace(SSN_SHAPE, maskTaxId).replace(EIN_SHAPE, maskTaxId)
  }
  if (Array.isArray(node)) return node.map((v) => maskTaxIdsDeep(v))
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(node)) out[k] = maskTaxIdsDeep(v, k)
    return out
  }
  return node
}

function text(data: any): { content: Array<{ type: 'text'; text: string }> } {
  const masked = maskTaxIdsDeep(data)
  return { content: [{ type: 'text' as const, text: typeof masked === 'string' ? masked : JSON.stringify(masked, null, 2) }] }
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

/**
 * Stripe's ceiling, which is lower than QBO's and is Stripe's rule, not ours:
 * every list and search endpoint 400s on limit > 100. HARD_MAX above stays at
 * 200 because QBO genuinely serves that. Mirrors STRIPE_PAGE_MAX in
 * routes/stripe.ts, which clamps server-side regardless of what arrives.
 */
const STRIPE_PAGE_MAX = 100

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

const INSTRUCTIONS = `You help users prepare and file tax returns. Each tool's description carries its detailed contract — these INSTRUCTIONS cover cross-cutting workflow and the mental models that span multiple tools.

## Reports first, transactions only with a filter

Biggest source of context blowouts. Never open a QBO task by pulling transactions. Start with a summary report, drill into detail only with a filter.

Summary reports fit in a few KB: qbo_report(profit-and-loss | balance-sheet | trial-balance | cash-flow | financials). Use these to understand the shape before drilling.

Transactional resources (Invoice, Bill, JournalEntry, Transaction, Payment, SalesReceipt, CreditMemo, Deposit, Transfer, Estimate, TimeActivity, Purchase, RefundReceipt, BillPayment, VendorCredit) REQUIRE a WHERE clause — qbo_resource search and qbo_query both reject unfiltered pulls. Default cap 50 rows, hard max 200.

For multi-step workflows on genuinely big datasets (full general ledger reconciliation, multi-year transaction pull): pass spill_to to park the payload in scratch storage and get shape+preview+ref back. Supported on qbo_report, qbo_query, qbo_resource, and stripe_data.

## Entry point

Call list_entities first, then entity_map for how the entities are tied together (who owns what, intercompany dealings, disregarded entities, and what a change to each return touches). Figure out what the user needs from context — don't present a menu. Entities carry a \`source\` field on each return (filed_import / proforma / amendment / extension); filed PDFs live in list_documents (doc_type: prior_return_*), parsed line values live in tax_return. One filed return becomes one filed_import row when ingested — you'll see both.

Answer account-level and family-level questions ("what's on file?", "what's missing for 2024?") from list_entities + list_documents alone — they already carry every entity's returns, years, sources, and document types. Do NOT call get_entity once per entity for an overview; each call is a separate permission prompt for the user. get_entity is for drilling into ONE entity when you need what the summary omits (the Schedule K questionnaire, scenarios, full field detail).

## Questions about a return are answered from the CATALOG

Every value on every page of a catalogued return — each box, check, Schedule K-1 item, statement row and worksheet line — is stored with its form, section, line, column and page. Answer questions about a return with query_catalog, and cite the line it returned ("per the filed 2023 Form 1120-S, Schedule L line 19, column (d)"). Do not read or re-read the PDF to answer a question, and do not rely on the filed_import tax_return row (it holds 10–40% of a return). If query_catalog finds nothing, say the catalog has no such line for that return — that is a catalog gap to report (catalog_status shows coverage), not a reason to go to the PDF. Before relying on a year, check catalog_status: a return that is not catalogued, or catalogued as incomplete, must be called out.

## Evidence discipline — fact vs. absence vs. inference

This system holds financial records; users act on what you say. Before stating any material financial or tax conclusion, check the underlying records (list_documents, compare_returns, get_entity — the extracted field values), and keep three categories distinct in your OWN voice, in the FIRST answer, not only when challenged:

1. **Documented fact** — directly supported by a document or extracted field here. State it plainly and cite the support in human terms: the form, year, and entity ("per the filed 2023 Form 1040") — never a bare internal ID.
2. **Absence of evidence** — the system does not contain the document or data needed to establish something. Say exactly that. A missing return is not evidence of activity or of inactivity; an extracted \`0\` is a documented zero, which is different from a field that was never extracted.
3. **Inference** — a reasonable conclusion the records do not establish (e.g. ownership assumed because entities share an account, pass-through activity assumed from an entity's existence). Inference is allowed ONLY when labeled as inference. Never present an inference in the same voice as something the records actually show.

Two failure modes that slipped through even after the rules above shipped — treat these as hard rules, not style:

- **Co-location is not a relationship.** Entities in one account share nothing but the account. Never assert that an entity's K-1 "flows to" or "should surface on" an individual's return unless the entity map records the link (with its evidence) or a document on file establishes the ownership (a K-1 naming them, a return schedule, an operating agreement). The compliant phrasing pattern: "No 2024 Partnership X return is present here. IF the individual has an ownership interest in Partnership X, a 2024 K-1 may also be relevant to her return — but this system currently contains no document establishing that relationship."
- **This vault is not the world.** A return absent from this system is "not present here" — never "not filed" or "was never filed". Filing may have happened anywhere; absence here establishes only absence here. Same for "no activity": a missing return is not evidence the entity was dormant.
- **Internal ids are plumbing, not citations.** The UUIDs in tool responses (entity_id, return_id, document id) exist so you can chain tool calls. Never surface them to the user — not even truncated. Refer to a record by entity name, form, and tax year ("the computed 2024 1120S for Harborlight"), which is what a person can act on.
- **These rules constrain claims — they are not content to volunteer.** Apply them silently to whatever you were about to assert. Do NOT raise ownership, family relationships, K-1 flow, or filed-elsewhere caveats when neither the question nor your answer touches those topics: a user who asks for a plain entity list should get a plain entity list, with no unprompted disclaimer about what the account does not prove.

Use record_tax_fact for values stated in conversation ("my W-2 wages were $150K"). Use ingest_document for uploaded PDFs. Both flow into compute_return's auto-merge.

## Facts every return needs

Facts that are not a document's box values — ownership and share counts, the S election and its acceptance, who lent money and from whose account, material participation, intercompany fees, state tax payment dates, IRS transcript events — are defined ONCE per return type in a registry, and every return of that type, every year, needs the same list. get_fact_gaps(entity_id, tax_year) returns that list with each fact answered, unknown, not applicable, missing or contradicted. Before preparing, reviewing or drawing a conclusion about a return, call it; ask the owner every missing and contradicted fact together in one message; record each answer with record_fact. Never fill a fact from inference. If you learn something a return needs that the list does not ask, say so — it belongs in the registry, not in entity meta or a note.

## Open notes on a return

Everything still open about a return that is neither a registry fact nor a review finding is a NOTE (add_note / update_note / list_notes). Examples: a refund check nobody has confirmed arriving, a call the representative still has to make, a related return whose filing is unconfirmed. Standing context a new session must know is also a note, with status info. Each open note says who it is waiting on, and review_summary lists every open note beside the findings. Before working on a return, read its notes (list_notes, or get_review, which carries them). When something is learned or settled, update the note in the same turn. An open item left only in the conversation is lost when the conversation ends.

## The entity map

How the entities in an account are tied together is stored ONCE, in the entity map (entity_map / record_link / update_link), not re-derived each session. A link is one of: owns (an owner's return holds a percentage of an entity; subject names the person on a joint 1040), disregarded (an LLC whose income and payroll belong on a parent's return), intercompany (two businesses deal with each other: services fee, loan, rent, settlement). Each link has the years it holds, its source and its evidence. entity_map also lists "unrecorded" — evidence in the returns, facts or entity records that points to a link nobody has recorded — and for each entity what a change to its return touches. Before reasoning across entities (K-1 flow, basis, intercompany fees and balances, controlled groups), read the map. Record a link only from evidence or the owner's statement, never from inference; when the evidence is misleading, retire the link (update_link removed: true) or resolve the review item, and say why. The review checks the map against the returns every run, and through it compares each intercompany fee (one side's intercompany.fee_expense vs the other's intercompany.fee_revenue) and balance (intercompany.balance_end, or the balance-sheet rows naming each other) on both sides, and each C corporation's controlled-group answers with who owns what. The map also answers the registry's related-company questions (intercompany.has_related_entities / counterparties); do not record those separately.

## Versions: every set of returns must tie

Returns are versioned in group-wide SETS. "filed" is every return as filed with the IRS (plus any filed amendment package). v1, v2, … are restatement packages: each holds amended versions of some returns (put_return_version: the lines it changes, with the reason; a change that moves an intercompany amount names the fact and the related company), and leaves every other return as filed. Every set must TIE internally — the tie checks (arithmetic within each return, opening balances against the prior year, carryover chains, K-1 to 1040, K-1 item I to Schedule L, intercompany fees and balances on both sides, controlled-group answers, ownership against the returns) run on the set exactly as on the filed returns (review_version_set). A BREAK is a tie that fails; breaks in the filed returns and in every draft set are open items (review_summary breaks). Never prepare an amendment for one return alone: put it in a set with the returns it touches (entity_map shows them), review the set, and keep adding changes until review_version_set reports no new breaks. When the package is filed, update_version_set status filed — the filed view then includes it.

## Filed returns vs. computed returns — STRICT SEPARATION

Returns live in two worlds. Don't cross them.

**Filed world — IMMUTABLE.** prior_return_* uploads become \`source='filed_import'\` tax_return rows. Every canonical field lands in field_values; totals (taxable_income, total_tax, total_payments, sched_e_*) in computed_data.computed. These rows are ARCHIVES — compute_return REFUSES to touch them.

**Working world — MUTABLE.**
- \`proforma\` — current-year work. compute_return writes here by default (updates latest, or inserts new if none).
- \`extension\` — 4868/7004/8868.
- \`amendment\` — first-class peer of filed returns (not a flag on them). Create with compute_return(amend_of:<filed_return_id>).

compute_return's routing params:
- \`return_id\`  → UPDATE that specific row (rejected if filed_import)
- \`amend_of\`   → INSERT a new amendment superseding that row
- \`new_row\`    → force INSERT a fresh proforma (scenario snapshot)
- (none)       → UPDATE latest proforma, or INSERT if none

compare_returns picks one row per year (filed_import > amendment > proforma > extension) and returns all_rows for drill-down. use_prior_year follows the same preference and bridges canonical PDF keys (income.L1a_gross_receipts) back to engine input names.

## Computing returns — pick the right path first

**1120/1120S with QBO connected:** call compute_return_from_qbo for a one-shot pipeline. QBO P&L + BS auto-map to every line; pass \`overrides\` only for classifications you want to correct.

**1040, or no QBO:** validate_return → compute_return → get_pdf.

compute_return itself auto-pulls QBO for connected 1120/1120S entities — pass only the fields you want to override or add (1099 interest, officer_comp split, NOL carryforward, Schedule E, etc.). **Caller inputs always win over auto-merge, including an explicit \`0\`** — that's how you force-zero a QBO-defaulted field.

Response fields to surface to the user before finalizing:
- \`qbo_warnings\` — preparer-judgment items (e.g. OFFICER_COMP_UNSPLIT, SSTB_SUSPECTED, CONTINGENCY_IN_REVENUE).
- \`supporting_documents.auto_merged\` — values pulled from W-2s / 1099s / K-1s. A misread OCR becomes the filed number otherwise.
- \`missing_fields\` (severity: critical) — get_pdf won't generate until you walk the user through these. See review_return for the flow.

compute_cascade runs the S-Corp → K-1 → 1040 chain in one call.

## Onboarding a QBO-connected entity

When connect_qbo auto-creates an entity, it lands with \`meta.form_type_inferred: true\` and \`meta.qbo_company_type\` set. QBO CANNOT distinguish S-corp from C-corp — that's a tax election QBO doesn't track. For Corporation or LLC, confirm with the user:
  "QBO reports this as Corporation. Has the company elected S-corp status (Form 2553)?"
If yes, update_entity(form_type: '1120S') — entity_type auto-syncs. LLCs have even more ambiguity (1065 / 1120 / 1120S / Schedule C depending on election).

## Style and rules

- Never fabricate financial data.
- Confirm tax year before computing.
- validate_return before compute_return on the classic 1040 path.
- S-Corp shareholders must sum to 100%.
- Caller-provided inputs (incl. explicit \`0\`) always win over auto-merge.
- Use get_schema to discover fields — don't guess canonical keys.
- Surface qbo_warnings, auto_merged, and missing_fields before get_pdf.
- Present missing fields in plain English (descriptions, not canonical keys) and group by category.
- For "use prior year" requests, pull via use_prior_year or compare_returns.
- For "leave blank" on a critical line, echo back the line in confirmation before moving on.`

/**
 * Tool annotations — human-readable titles + behavior hints, one table.
 *
 * Added after a client audit: claude.ai's approval prompts showed only raw
 * tool names and UUID arguments, so a user approving get_entity had no idea
 * what they were consenting to. Titles are what the claude.ai UI can display;
 * readOnlyHint lets it treat harmless reads differently from writes. The MCP
 * spec's DEFAULTS are worst-case (destructive, open-world), so benign write
 * tools carry an explicit destructiveHint: false. Tools whose spill_to merely
 * caches their own response in the user's scratch space still count as
 * read-only. Every tool operates on the user's own tax data or their
 * connected QBO/Stripe accounts: openWorldHint is false across the board.
 */
const RO = { readOnlyHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const

const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  list_entities:              { title: 'List entities & returns', ...RO },
  get_schema:                 { title: 'Get form schema', ...RO },
  get_entity:                 { title: 'Get one entity (full detail)', ...RO },
  create_entity:              { title: 'Create entity', ...WRITE },
  qbo_report:                 { title: 'QuickBooks report (read)', ...RO },
  validate_return:            { title: 'Validate return inputs', ...RO },
  compute_return:             { title: 'Compute & save return', ...WRITE },
  qbo_to_tax_inputs:          { title: 'Map QBO to tax inputs (read)', ...RO },
  compute_return_from_qbo:    { title: 'Compute return from QBO', ...WRITE },
  recategorize_uncategorized: { title: 'Suggest recategorizations (dry-run)', ...RO },
  apply_recategorizations:    { title: 'Apply recategorizations to QBO', ...DESTRUCTIVE },
  reconcile_bank_import:      { title: 'Reconcile bank CSV (suggestions)', ...RO },
  post_transactions_batch:    { title: 'Post QBO transactions', ...WRITE },
  loan_amortization_schedule: { title: 'Loan amortization schedule', ...RO },
  run_scenario:               { title: 'Run what-if scenario', ...WRITE },
  compare_scenarios:          { title: 'Compare scenarios', ...RO },
  get_pdf:                    { title: 'Get return PDF', ...RO },
  export_return:              { title: 'Export return lines (JSON/CSV)', ...RO },
  audit_risk:                 { title: 'Audit-risk screen (DIF-style)', ...RO },
  mark_reviewed:              { title: 'Mark return reviewed', ...WRITE },
  delete_return:              { title: 'Delete return', ...DESTRUCTIVE },
  review_return:              { title: 'Review return (QC)', ...WRITE },
  use_prior_year:             { title: 'Pull prior-year values', ...RO },
  compare_returns:            { title: 'Compare returns across years', ...RO },
  record_tax_fact:            { title: 'Record tax fact', ...WRITE },
  get_fact_gaps:              { title: 'Facts this return needs (gap list)', ...RO },
  record_fact:                { title: 'Record a registry fact', ...WRITE },
  list_facts:                 { title: 'List recorded facts', ...RO },
  ingest_document:            { title: 'Upload document', ...WRITE },
  list_documents:             { title: 'List documents', ...RO },
  fill_extraction_gaps:       { title: 'Fill extraction gaps', ...WRITE },
  scratch:                    { title: 'Scratch storage', ...WRITE },
  promote_scenario:           { title: 'Promote scenario to return', ...WRITE },
  compute_cascade:            { title: 'Compute S-corp cascade (stateless)', ...RO },
  update_entity:              { title: 'Update entity', ...WRITE },
  delete_entity:              { title: 'Delete entity & all its data', ...DESTRUCTIVE },
  connect_qbo:                { title: 'Connect QuickBooks', ...WRITE },
  qbo_query:                  { title: 'QuickBooks query (read)', ...RO },
  get_accounts:               { title: 'QuickBooks chart of accounts', ...RO },
  qbo_resource:               { title: 'QuickBooks resource CRUD', ...DESTRUCTIVE },
  tax_calendar:               { title: 'Tax calendar', ...RO },
  update_obligation:          { title: 'Update calendar obligation', ...WRITE },
  add_obligation:             { title: 'Add calendar obligation', ...WRITE },
  request_form:               { title: 'Request form support', ...WRITE },
  connect_stripe:             { title: 'Connect Stripe', ...WRITE },
  stripe_data:                { title: 'Stripe data (read)', ...RO },
  // DESTRUCTIVE because the worst member governs: pay moves real money and
  // void is not undoable, and one tool gets one annotation (same reasoning
  // as qbo_resource).
  stripe_invoice:             { title: 'Stripe invoice actions (create/finalize/pay/void)', ...DESTRUCTIVE },
  file_extension:             { title: 'File extension', ...WRITE },
  generate_k1s:               { title: 'Generate Schedule K-1s (issuer side)', ...WRITE },
  validate_extension:         { title: 'Validate extension inputs', ...RO },
  query_catalog:              { title: 'Answer from the return catalog', ...RO },
  catalog_status:             { title: 'Catalog coverage by year', ...RO },
  catalog_document:           { title: 'Catalogue a stored return PDF', ...WRITE },
  catalog_upload:             { title: 'Upload & catalogue a return PDF', ...WRITE },
  run_review:                 { title: 'Run the review framework', ...WRITE },
  get_review:                 { title: 'Latest review findings', ...RO },
  review_summary:             { title: 'Everything to act on, all entities', ...RO },
  resolve_finding:            { title: 'Record a decision on a finding', ...WRITE },
  add_note:                   { title: 'Add an open note to a return', ...WRITE },
  update_note:                { title: 'Edit or close a return note', ...WRITE },
  list_notes:                 { title: 'Open notes for a return', ...RO },
  entity_map:                 { title: 'Entity map: how the entities connect', ...RO },
  record_link:                { title: 'Record a link in the entity map', ...WRITE },
  update_link:                { title: 'Change or retire an entity-map link', ...WRITE },
  version_sets:               { title: 'Version sets (restatement packages)', ...RO },
  create_version_set:         { title: 'Start a version set', ...WRITE },
  put_return_version:         { title: 'Add or replace an amended return in a set', ...WRITE },
  remove_return_version:      { title: 'Remove an amended return from a draft set', ...WRITE },
  update_version_set:         { title: 'Rename, file or abandon a version set', ...WRITE },
  review_version_set:         { title: 'Check a version set ties (breaks)', ...WRITE },
}

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
  const callText = (method: string, path: string) => apiText(apiKey, method, path)

  // Every registration below uses the 4-arg form (name, description, schema,
  // handler); this wrap threads in each tool's annotations from the one table
  // above instead of growing a fifth argument at 43 call sites. A tool missing
  // from the table is a registration-time error — annotations are not optional.
  const rawTool = server.tool.bind(server)
  ;(server as any).tool = (name: string, description: string, schema: any, cb: any) => {
    const annotations = TOOL_ANNOTATIONS[name]
    if (!annotations) throw new Error(`tool ${name} has no entry in TOOL_ANNOTATIONS`)
    return (rawTool as any)(name, description, schema, annotations, cb)
  }

  // ─── Tool: list_entities ───
  // Trimmed at this layer, not in the route — the web app reads the full shape
  // from /api/entities. Dropped here: ciphertext columns, user_id, and the
  // 30-key Schedule K yes/no questionnaire, none of which are useful to a model
  // browsing the account. get_entity still returns everything for one entity.
  server.tool('list_entities', 'List all tax entities and their tax_return rows (computed/parsed — NOT filed PDFs). Each return carries a `source` field: `filed_import` (parsed from an uploaded prior-year PDF), `proforma` (current-year work), `extension`, `amendment`. Summary view — call get_entity for full detail including the Schedule K questionnaire. For the signed/filed PDF itself, use list_documents filtered by doc_type starting with `prior_return_`.', {}, async () => {
    const resp = await call('GET', '/api/entities')
    if (!resp?.entities) return text(resp)
    return text({
      // In-band because initialize-time instructions demonstrably did not
      // stop this at the moment of reasoning: a client audit's retest still
      // saw ownership inferred from co-location ("I'd expect that to surface
      // on the 1040 via K-1") and vault-absence stated as filing-absence.
      // The note rides WITH the entity list so it is in front of the model
      // exactly when it is looking at these entities.
      evidence_note: 'Rules for claims you make — apply silently, do not recite or volunteer them: these entities share an account, which alone documents NO ownership, K-1 flow, or family relationship between them, so assert a relationship only from a document on file (K-1, return schedule, operating agreement) and otherwise label it as unverified inference — but ONLY IF the question or your answer touches relationships; never add unprompted disclaimers to a plain listing. A return absent from this system is "not present here", never "not filed" — filing elsewhere is not knowable from this vault. The UUID ids in these records exist to chain tool calls — never cite one to the user, even truncated; cite by entity name, form, and tax year.',
      entities: resp.entities.map((e: any) => {
        // Rename syntax matters: `{ ein_enc: _x }` extracts the real key.
        // The `{ _ein_enc }` spelling a lint sweep introduced extracted a
        // nonexistent key and LEAKED ein_enc ciphertext, ein_hash and
        // user_id to every MCP client.
        const { ein_enc: _ee, ein_hash: _eh, user_id: _uid, meta, ...rest } = e
        const { sched_k, ...metaRest } = meta || {}
        return {
          ...rest,
          meta: sched_k ? { ...metaRest, sched_k: '(omitted — see get_entity)' } : metaRest,
        }
      }),
    })
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
  // The entity routes return the raw hydrated row — including ein_enc
  // ciphertext, the ein_hash blind index, and user_id. list_entities stripped
  // those from day one; get_entity/create_entity/update_entity relayed them
  // to every MCP client until a live connector call surfaced it (2026-09-01,
  // while verifying the tool a client was being asked to authorize). Same
  // leak class as the list_documents user_id incident: internal identifiers
  // handed to a model end up cited as "evidence".
  const stripEntityInternals = (resp: any) => {
    if (resp?.entity && typeof resp.entity === 'object') {
      const { user_id: _uid, ein_enc: _ee, ein_hash: _eh, ...rest } = resp.entity
      return { ...resp, entity: rest }
    }
    return resp
  }

  server.tool('get_entity', 'Get ONE entity\'s full detail (all tax_return rows, scenarios, Schedule K questionnaire). For account-wide or multi-entity overviews use list_entities instead of calling this once per entity — every call is a separate permission prompt for the user. Each return has a `source` field — see list_entities for the filed_import vs. proforma distinction. Filed PDFs live in list_documents, not here.', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(stripEntityInternals(await call('GET', `/api/entities/${entity_id}`)))
  })

  // ─── Tool: create_entity ───
  server.tool('create_entity', 'Create a new tax entity. form_type is the return it files (1040, 1120, 1120S, 1065) and drives all calculation; entity_type is auto-derived from it. Pass legal_form separately when the entity is an LLC, trust or similar — an LLC taxed as an S-corp is legal_form=llc with form_type=1120S, and an ordinary pass-through LLC is legal_form=llc with form_type=1065.', {
    name: z.string().describe('Entity name (person or business)'),
    form_type: z.string().optional().describe('Tax form the entity FILES — 1040, 1120, 1120S or 1065. This drives every calculation and deadline.'),
    entity_type: z.string().optional().describe('individual, c_corp, s_corp or partnership. Auto-derived from form_type if omitted; there is no separate llc or nonprofit value here — see legal_form.'),
    legal_form: z.string().optional().describe('What the entity legally IS, independent of how it is taxed: llc, corporation, partnership, sole_proprietor, trust, estate, individual. An LLC that elected S-corp treatment on Form 2553 is legal_form=llc with form_type=1120S; an ordinary pass-through LLC is legal_form=llc with form_type=1065.'),
    ein: z.string().optional().describe('EIN (business) or SSN (individual)'),
    address: z.string().optional().describe('Street address'),
  }, async (params) => {
    return text(stripEntityInternals(await call('POST', '/api/entities', params)))
  })

  // ─── Tool: qbo_report ───
  // Dispatcher — replaces get_financials + get_qbo_report + get_qbo_mapping.
  server.tool('qbo_report', `Pull a QuickBooks report or the P&L→tax-form mapping.

Summary reports (small, start here):
- report_type='financials' → P&L + Balance Sheet bundle. Default for tax prep.
- report_type='profit-and-loss' | 'balance-sheet' | 'trial-balance' | 'cash-flow' → individual summary.

Detail reports (can be huge — use spill_to):
- 'general-ledger' | 'transaction-list' | 'profit-and-loss-detail' | 'balance-sheet-detail'.

Mapping:
- form_type='1120'|'1120S', report_type='mapping' → QBO P&L category → tax form line mapping.

All reports are cached; pass refresh=true only when the user explicitly wants fresh data.`, {
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
  server.tool('compute_return', `Compute a tax return from structured inputs and save it.

Routing: by default, updates the latest proforma for (entity, year, form) — or inserts if none. Never touches filed_import rows. Pass amend_of=<filed_return_id> to create an amendment. Pass new_row=true to force a fresh proforma (scenario snapshot). Pass return_id to update a specific row (rejected if it's filed_import).

1120 payments: estimated_tax_paid (Schedule J line 14), prior_year_overpayment (line 13, overpayment credited from the prior year), deposit_7004 (line 17).

1120 amendments also produce Form 1120-X (section \`amended.*\`, Part I columns _a as reported / _b change / _c correct, then lines 5a–13 netting payments against what the original return already paid out). Pass \`amended_x\`: { original?: { total_income, total_deductions (lines 27 + 29c), taxable_income, total_tax } — defaults to the superseded return; prior_year_credit (5a), estimated_tax (5b), refund_4466 (5c), deposit_7004 (5e), other_credits (5f+5g), tax_paid_after (6), original_overpayment (8, as reported or later adjusted), credit_to_estimated (12) }. amended.L13_refunded is the refund being claimed; amended.L10_tax_owed the balance due.

1040 Schedule E (rentals / partnerships / K-1 pass-through): pass nested \`schedule_e\` inside \`inputs\`. Engine computes per-property net, Part I totals (L23a-e, L24-26), Part II partnership total (L32), and flows L41 into Schedule 1 line 5. Shape:
  schedule_e: {
    rental_properties: [{ address, property_type, fair_rental_days, personal_use_days,
      rents, royalties, advertising, auto_travel, cleaning_maintenance, commissions,
      insurance, legal_professional, management_fees, mortgage_interest, other_interest,
      repairs, supplies, taxes, utilities, depreciation, other_expenses }],
    partnerships: [{ name, ein, type: 'P'|'S', passive, ordinary_income }],
    estate_trust_income, remic_income, farm_rental,
    pal_limitation: { filing_status, magi, active_participation, prior_year_suspended_re }
  }
Without pal_limitation, rental losses flow through without §469 limiting (optimistic for high-MAGI filers — always ask if they're active participants). With it, Form 8582 runs, loss is pro-rated across loss-making properties, and Form 8582 PDF is bundled alongside Schedule E. Read response.schedule_e.computed.pal.suspended_rental for next-year carryforward.

1040 source documents — pass these instead of pre-summed figures so the return carries its supporting schedules as data (Schedules 1/2/3/B/D, Forms 8949/8959/8960/8995-A; read them back with export_return):
  w2s: [{ owner: 'taxpayer'|'spouse', employer, box1, box2, box3, box4, box5, box6 }]
  taxable_interest_detail: [{ label, amount }]            ordinary_dividends_detail: [{ label, amount, qualified }]
  k1_portfolio: { name, interest, ordinary_dividends, qualified_dividends, st_gain, lt_gain }   (K-1 boxes 4/5a/5b/7/8a — not also in taxable_interest)
  capital_transactions_detail: [{ label, proceeds, basis, adjustment, term: 'short'|'long', box: 'A'..'F' }]
  other_income / other_income_detail: [{ label, amount, investment }]   (Schedule 1 line 8z)
  extension_payment (paid with Form 4868 — NOT estimated_payments), prior_year_tax, prior_year_agi (Form 2210 safe harbor → computed.form2210_shortfall), foreign_accounts

QBO auto-pull: for 1120/1120S with a QBO connection, compute_return maps the P&L + BS automatically. Pass only overrides — 1099 interest, officer_comp split, NOL carryforward, etc. Caller-provided values always win, INCLUDING explicit \`0\` (that's how you force-zero a QBO-defaulted field). For a one-shot convenience wrapper see compute_return_from_qbo.

Response: \`qbo_warnings\` (preparer-judgment items — surface to user), \`supporting_documents.auto_merged\` (values from W-2/1099/K-1 docs — echo for confirmation), \`missing_fields\` (critical lines at 0 that need user confirmation before get_pdf).

S-Corp inputs require \`shareholders: [{ name, pct }]\` summing to 100.`, {
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
  server.tool('compute_return_from_qbo', `Pull QBO data → map to 1120/1120S inputs → apply overrides → compute in one call. Response includes the compute result plus qbo_mapper.{audit, dropped, warnings, sources, overrides_applied} and a top-level reconciliation block.

Iteration pattern — DO NOT just accept the first response and report numbers:

1. Call with no overrides. Inspect qbo_mapper.warnings.
2. Each warning may carry a \`decision\` block of shape:
     { question: string,
       options: [{ label, summary, overrides: {…} }],
       default_label: string }
   These are mapper judgment calls (Contract Labor → COGS vs salaries, meals 50% disallowance, contingent customer deposits as L1b vs liability, officer comp split, etc.). The mapper has already applied the option matching default_label; the decision block lets you ask the user which option they want.
3. For each warning with a decision block, ASK THE USER the \`question\`, present the options' labels + summaries, and let them pick. If the user defers, leave the default — but tell them what defaulted.
4. Merge the chosen options' \`overrides\` into a single overrides dict, then call this tool again with overrides set. Repeat if reconciliation.delta is still material (>$1K relative to qbo_net_income).

Reconciliation: top-level \`reconciliation: { qbo_net_income, form_ordinary_income, schedule_k_portfolio, delta, delta_explanation }\` — delta should be near zero for a clean return. Material delta means the form misses real income/expense (book-vs-tax differences like meals 50% or MACRS-vs-book depreciation are normal residuals).

Caller-provided overrides always win, INCLUDING explicit 0 or null (that's how you force-zero a QBO-defaulted field). Only fields you pass in overrides are touched; everything else stays at the mapper default.`, {
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
  server.tool('get_pdf', `Generate a filled IRS PDF for a computed return.

HARD GATE: API returns 400 if the return has critical fields at 0 (NOL, IRA distributions, prior-year line items ≥ $1,000). The 400 response includes missing_fields and next-steps guidance — walk the user through review_return, then either mark_reviewed(return_id) to permanently unblock or pass skip_review=true for a one-off bypass.

Serves cached PDFs by default (pdf_s3_path on the return row). Pass refresh=true after a recompute to regenerate. For 1040 with schedule_e / pal_limitation, Schedule E and Form 8582 are auto-bundled into the package.`, {
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

  // ─── Tool: export_return ───
  server.tool('export_return', `Read a computed return's actual line values — every populated line with its canonical key, schedule, IRS line number, column and amount, plus each shareholder's K-1 figures.

This is how you INSPECT a return. get_pdf renders one for filing and tells you nothing about what is on it; compare_returns gives a handful of headline metrics across years. Use this when you need the figures themselves: checking that a schedule foots, reconciling to the books, handing numbers to a preparer, or answering "what does line 20 say".

format 'json' (default) returns {entity, return, lines[], k1s[]}. Each line carries: key (the canonical key, authoritative), section_label, line, column (Schedule L runs boy_a/boy_b/eoy_c/eoy_d) and value. Labels are derived from the key and are a convenience only — cite the canonical key or the IRS line number, never the label, when precision matters.

format 'csv' returns the same rows as CSV for a spreadsheet.`, {
    return_id: z.string().describe('Tax return UUID'),
    format: z.enum(['json', 'csv']).optional().describe("'json' (default) or 'csv'"),
  }, async ({ return_id, format }) => {
    const path = `/api/returns/${return_id}/export?format=${format || 'json'}`
    // CSV must not go through the JSON parser.
    return text(format === 'csv' ? await callText('GET', path) : await call('GET', path))
  })

  // ─── Tool: audit_risk ───
  server.tool('audit_risk', `Screen a saved 1120, 1120-S or 1040 for audit risk — a transparent, rule-based stand-in for the IRS's confidential DIF score.

Returns score 0-100, band (low/elevated/high), the ratios it measured, and flags. Each flag carries the rule code, kind (ratio / integrity / pattern / change), the measured value, the threshold, the canonical lines it read and a plain explanation.

- ratio: expenses vs receipts (>80%), meals (>2%), travel/vehicles (>8%), advertising (>10%, 20% retail), "other deductions" (>10% of deductions, worse if not itemized), charitable.
- integrity: Schedule L not balancing or its lines not adding to the total, M-1 not reaching line 28, M-2 not reaching its ending balance, Schedule B payers not adding to line 2b. Fix these before filing — the IRS's automated checks catch them regardless of score.
- pattern: S-corp officer pay low beside distributions (reasonable compensation), loans to shareholders, high income class, K-1 income dwarfing wages.
- change: a line that moved by >50% and >$25,000 from the prior year.

Present it as a heuristic screen, never as the IRS's score. A flag means "keep documentation", not "do not deduct": ordinary and necessary expenses are deductible whatever their ratio.`, {
    return_id: z.string().describe('Tax return UUID'),
  }, async ({ return_id }) => {
    return text(await call('GET', `/api/returns/${return_id}/audit-risk`))
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
  server.tool('review_return', `QC review of a saved return: lists fields still at 0/blank so you can walk the user through them before finalizing the PDF.

Flow:
  1. Check missing_fields in the response. For each critical one, offer three options to the user:
     (a) "Leave blank (zero)" — confirm no activity; echo the line back for acknowledgment.
     (b) "Use prior year" — pull via use_prior_year or compare_returns; shown as prior_year_value.
     (c) Provide a value now → recompute.
  2. When resolved: either mark_reviewed(return_id) to permanently unblock, or get_pdf(skip_review=true) for a one-off bypass.
  3. get_pdf will then succeed.

Present in plain English using the \`description\` field, grouped by category. Examples worth asking:
  - 1040 L4 IRA distributions (silent 0 is wrong if IRA income was forgotten)
  - 1120 L29a NOL carryforward (stale $0 loses real tax benefit)
  - Schedule L balance sheet (0 can be valid for unused account types — confirm material lines)`, {
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
  server.tool('record_tax_fact', 'Persist a tax fact from conversation (no document needed). Use when the user tells you values directly: "I got $10K interest from Chase", "My W-2 wages were $150K". Creates a virtual document that auto-merges into compute_return for this entity+year, just like an uploaded W-2 or 1099. Always include a source_note describing where the info came from (e.g. "client stated on call 2026-04-17") so it\'s audit-traceable. This is for numeric values a document would carry (W-2, 1099, K-1 boxes); for facts that are not a document line — ownership, elections, loans and who made them, material participation, intercompany terms, IRS account events — use record_fact (get_fact_gaps lists them).', {
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

  // ─── Tool: get_fact_gaps ───
  // The registry's list for one return. Open items carry the full question
  // (and the shape of the answer); settled facts are compacted to key + value
  // so the whole list still fits comfortably in a chat context.
  server.tool('get_fact_gaps', `THE list of facts every return of this type needs. The list is defined once per return type (1120-S, 1120, 1040, 1065) in the fact registry and is the same for every return of that type and every year — something learned on one return is asked of all of them.

Each fact comes back with a status:
- missing — nobody has answered it. conditional_on means it depends on those facts (ask them together: "…and if so, …"); needs_subjects_from means the owner / K-1 / counterparty list must be answered first. catalog_value, when present, is what the filed return shows — ask the owner to confirm it, do not assume it.
- contradicted — answered, but the filed return (catalog_line) shows catalog_value. Ask which is right.
- unknown — the owner said they do not know.
- answered / not_applicable — settled.

Missing and contradicted facts MUST be asked of the owner ALL AT ONCE, in a single message grouped by area — not one at a time across a conversation, and none skipped because it looks minor: single unrecorded facts (material participation, a related-company loan taken for a shareholder loan) are what cost real money before this list existed. Record each answer with record_fact. Never answer a fact yourself by inference.`, {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().describe('Tax year of the return'),
    form_type: z.enum(['1120S', '1120', '1040', '1065']).optional().describe('Return type; defaults to the entity\'s own form type'),
  }, async ({ entity_id, tax_year, form_type }) => {
    const qs = new URLSearchParams({ year: String(tax_year) })
    if (form_type) qs.set('form_type', form_type)
    const resp = await call('GET', `/api/facts/${entity_id}/gaps?${qs}`)
    if (!Array.isArray(resp?.gaps)) return text(resp)
    const pick = (g: any, keys: string[]) =>
      Object.fromEntries(keys.filter(k => g[k] !== undefined).map(k => [k, g[k]]))
    const having = (status: string) => resp.gaps.filter((g: any) => g.status === status)
    return text({
      entity: resp.entity_name,
      form_type: resp.form_type,
      tax_year: resp.tax_year,
      summary: resp.summary,
      ask_now: resp.gaps
        .filter((g: any) => g.status === 'missing' || g.status === 'contradicted')
        .map((g: any) => pick(g, [
          'key', 'subject', 'status', 'question', 'why', 'type', 'options', 'item_fields',
          'conditional_on', 'needs_subjects_from', 'value', 'catalog_value', 'catalog_line', 'accepted_evidence',
        ])),
      unknown: having('unknown').map((g: any) => pick(g, ['key', 'subject', 'question', 'source_note', 'recorded_at'])),
      answered: having('answered').map((g: any) => pick(g, ['key', 'subject', 'value', 'source', 'catalog_value', 'recorded_at'])),
      not_applicable: having('not_applicable').map((g: any) => pick(g, ['key', 'subject', 'not_applicable_reason', 'source'])),
    })
  })

  // ─── Tool: record_fact ───
  server.tool('record_fact', `Record ONE answer to a fact from get_fact_gaps (e.g. scorp.election_effective_date, owners.material_participation for one owner, the rows of loans.from_related_entities). The write is checked against the fact registry: an unknown key, a key for another return type, a value of the wrong type, or a missing or extra tax_year / subject is refused with the reason. A new answer SUPERSEDES the previous one and the history is kept — nothing is overwritten.

- tax_year: only for per-year facts; omit it for all-years facts (formation date, S election, basis at inception).
- subject: for owner, K-1 and related-company facts — the name exactly as listed in owners.roster, k1.received or intercompany.counterparties.
- status: answered (with value) | unknown (the owner does not know) | not_applicable (does not apply) — the last two take no value.
- value: dates as YYYY-MM-DD; amounts as plain numbers (no $ or commas); percents 0-100; enums exactly as one of the listed options; lists as an array of row objects using the item_fields keys (an empty array means none).
- source: owner (they told you) | document (pass evidence_document_id) | catalog (read from a filed return line) | derived (computed from other facts) | migrated.
- source_note: always say exactly where it came from ("owner, call on 2026-10-17", "IRS CP261 letter", "2023 1120-S Schedule L line 19").`, {
    entity_id: z.string().describe('Entity UUID'),
    fact_key: z.string().describe('Registry key from get_fact_gaps, e.g. "owners.material_participation"'),
    status: z.enum(['answered', 'unknown', 'not_applicable']).describe('answered needs a value; unknown / not_applicable take none'),
    source: z.enum(['owner', 'document', 'catalog', 'derived', 'migrated']).describe('Where the answer came from'),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.record(z.any()))]).optional()
      .describe('The answer, typed per the fact (see type / options / item_fields in get_fact_gaps)'),
    tax_year: z.number().optional().describe('Per-year facts only'),
    subject: z.string().optional().describe('Owner / K-1 issuer / related company, for owner and relationship facts'),
    source_note: z.string().optional().describe('Exact provenance — who said it and when, or which document or return line'),
    evidence_document_id: z.string().optional().describe('Document UUID supporting the answer (from list_documents)'),
  }, async (params) => {
    return text(await call('POST', '/api/facts', { ...params, recorded_by: 'mcp' }))
  })

  // ─── Tool: list_facts ───
  server.tool('list_facts', 'List the facts recorded for an entity — current answers by default — with value, status, source, provenance note and evidence document. With tax_year: that year\'s answers plus the all-years ones. include_history adds superseded answers, to see what was said before and when it changed. For what is still MISSING use get_fact_gaps instead.', {
    entity_id: z.string().describe('Entity UUID'),
    tax_year: z.number().optional().describe('Limit to one tax year (all-years facts are always included)'),
    include_history: z.boolean().optional().describe('Include superseded answers'),
  }, async ({ entity_id, tax_year, include_history }) => {
    const qs = new URLSearchParams()
    if (tax_year !== undefined) qs.set('year', String(tax_year))
    if (include_history) qs.set('history', '1')
    const q = qs.toString()
    return text(await call('GET', `/api/facts/${entity_id}${q ? `?${q}` : ''}`))
  })

  // ─── Tool: ingest_document ───
  // Dual-mode: pass `base64` for inline content (image pasted in chat),
  // or pass `s3_key` when the file was pre-uploaded via the presign flow.
  server.tool('ingest_document', 'Upload a tax document (W-2, 1099, K-1, prior return, etc.). Two modes: (a) inline — pass {filename, base64, entity_id} when the user shares a file directly in chat; (b) pre-uploaded — pass {filename, s3_key, entity_id} if a presigned upload URL was used separately. Stores the file and returns immediately with a document id; classification and Textract extraction then run in the background, so a large return no longer times out mid-upload. Poll list_documents (or get the document by id) until processing_status is \'done\', then the doc_type, tax_year and extracted values are populated and any prior return has been archived. Always pass entity_id — without it the doc won\'t flow into compute_return.', {
    filename: z.string().describe('Filename with extension (e.g. "W2_2024.jpg", "1099-INT.pdf", "K1.png")'),
    base64: z.string().optional().describe('Base64-encoded file content (no data: prefix). Use this for inline images/files from chat. Mutually exclusive with s3_key.'),
    s3_key: z.string().optional().describe('S3 key for a file already uploaded via /api/documents/presign. Mutually exclusive with base64.'),
    entity_id: z.string().describe('Entity UUID to link this document to. REQUIRED — without it the doc won\'t flow into compute_return.'),
    file_size: z.number().optional().describe('File size in bytes (s3_key mode)'),
  }, async (params) => {
    return text(await call('POST', '/api/documents/ingest', params))
  })

  // ─── Tool: list_documents ───
  server.tool('list_documents', 'List all uploaded documents (authoritative source for filed/signed PDFs). Documents with doc_type starting with `prior_return_` (prior_return_1040/1120/1120s) ARE the filed returns the user uploaded. Each doc carries a `textract_summary` (page/KV/table counts); the raw Textract key-values are NOT included because they are far too large — use fill_extraction_gaps, which reads them server-side. Presigned download links are omitted by default (they were the majority of the response); pass include_download_urls when the user actually needs a link. For the parsed line-by-line data from those filed returns, see the matching tax_return row via list_entities (source=filed_import).', {
    include_download_urls: z.boolean().optional().describe('Include a presigned download_url per document (1-hour expiry). Off by default — only ask for it when the user wants to open or download a file.'),
  }, async ({ include_download_urls }) => {
    const resp = await call('GET', `/api/documents${include_download_urls ? '?urls=1' : ''}`)
    if (!resp?.documents) return text(resp)
    // Strip internal identifiers, mirroring list_entities. user_id leaked here
    // while list_entities stripped it, and a client's Claude promptly cited the
    // raw UUID as "evidence" the entities were related — an internal id doing
    // reasoning work it should never have been available for. s3_path is
    // storage layout, useless to a model.
    return text({
      // In-band like list_entities' evidence_note: the model-harness run of
      // 2026-09-01 cited truncated document ids to the user even after the
      // initialize-time instructions forbade it — the reminder has to sit
      // next to the ids at the moment the model is reading them.
      evidence_note: 'The UUID ids below exist to chain tool calls — never cite one to the user, even truncated; cite by document type, entity, and tax year.',
      documents: resp.documents.map((d: any) => {
        const { user_id: _uid, s3_path: _s3, ...rest } = d
        return rest
      }),
    })
  })

  // ─── Tool: fill_extraction_gaps ───
  // Standalone gap-fill for an already-archived filed return. The same step runs
  // inline during ingest/rearchive; this tool lets the model re-run gap-fill on
  // existing filed_import rows (e.g. after a mapper improvement) without a full
  // re-archive, or score an ad-hoc KV set via direct-input mode.
  server.tool('fill_extraction_gaps',
    'Run Gemini gap-fill on an already-archived filed return. After Textract + regex mapping, many canonical tax-line keys (Schedule L columns, Schedule K detail, etc.) go unfilled because the mapper rules don\'t match every layout. This tool identifies those gaps against the authoritative PDF field map for the form+year, sends Gemini the raw Textract KVs + the gap list, and fills what it can. Cheap (text-only, no PDF re-parse) and bounded (output scoped to the missing keys only). Two modes: (a) by `return_id` — auto-loads the return + its source document\'s Textract data, optionally persists filled values back to the row with `persist:true`; (b) direct inputs — pass `form_type, tax_year, textract_kvs, current_field_values` for ad-hoc scoring without saving.',
    {
      return_id: z.string().optional().describe('tax_return row ID (source=filed_import). Loads field_values and pulls the source document\'s Textract KVs. Use persist:true to merge filled values back into the row.'),
      persist: z.boolean().optional().describe('When return_id is set, also merge filled values back into the tax_return field_values (non-destructive — never overwrites existing values). Default false.'),
      form_type: z.enum(['1040', '1120', '1120S']).optional().describe('Direct-input mode: form type for gap computation. Required if return_id is not passed.'),
      tax_year: z.number().optional().describe('Direct-input mode: tax year. Required if return_id is not passed.'),
      textract_kvs: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe('Direct-input mode: raw Textract KV pairs to use as grounding.'),
      current_field_values: z.record(z.any()).optional().describe('Direct-input mode: canonical-keyed values already extracted by the mapper. Gaps are computed as expected_keys − keys(current_field_values). Default {} (fills everything expected for the form).'),
    },
    async (params) => text(await call('POST', '/api/intake/gap-fill', params))
  )

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
    return text(stripEntityInternals(await call('PUT', `/api/entities/${entity_id}`, updates)))
  })

  // ─── Tool: delete_entity ───
  server.tool('delete_entity', 'Delete an entity and everything linked to it: returns, scenarios, documents, and QBO/Stripe connections. Destructive and irreversible — confirm with the user first.', {
    entity_id: z.string().describe('Entity UUID'),
  }, async ({ entity_id }) => {
    return text(await call('DELETE', `/api/entities/${entity_id}`))
  })

  // ─── Tool: connect_qbo ───
  // Also reports current connection status (folds in the old qbo_status tool).
  server.tool('connect_qbo', `Start or check a QuickBooks OAuth connection. Pass entity_id to link to existing entity, or "new" to auto-create from QBO CompanyInfo. Response includes current connection status — if already connected, no auth_url is needed.

Auto-created entities land with meta.form_type_inferred:true and meta.qbo_company_type. QBO CANNOT distinguish S-corp from C-corp (tax election, not a QBO record), so after connection confirm with the user: "QBO reports this as Corporation — has the company elected S-corp status (Form 2553)?" If yes, update_entity(form_type:'1120S'); entity_type auto-syncs. LLC inference is similarly ambiguous (1065 / 1120 / 1120S / Schedule C).`, {
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

  // ─── Tool: tax_calendar ───
  // The deadline surface. Obligations are generated from rules, not authored,
  // so this is accurate the moment an entity exists.
  server.tool('tax_calendar',
    'List upcoming and overdue tax obligations across all entities — return due dates, extension deadlines, quarterly estimated payments, and state filings (Florida annual report and F-1120 where applicable). Due dates account for weekends and federal holidays, and reflect filed extensions automatically. Each item carries days_until (negative = overdue) and urgency (overdue / due_soon / upcoming). Use this to answer "what is due next", "did we miss anything", or to build a client-facing status update. Defaults to everything pending; pass within_days to narrow to a horizon (overdue items are always included).',
    {
      entity_id: z.string().optional().describe('Limit to one entity. Omit for the whole account.'),
      within_days: z.number().optional().describe('Only show obligations due within this many days. Overdue items are always shown regardless.'),
      include_dismissed: z.boolean().optional().describe('Include obligations marked not-applicable. Default false.'),
    },
    async ({ entity_id, within_days, include_dismissed }) => {
      const qs = new URLSearchParams()
      if (entity_id) qs.set('entity_id', entity_id)
      if (within_days !== undefined) qs.set('within_days', String(within_days))
      if (include_dismissed) qs.set('include_dismissed', 'true')
      const q = qs.toString()
      return text(await call('GET', `/api/calendar${q ? `?${q}` : ''}`))
    })

  // ─── Tool: update_obligation ───
  server.tool('update_obligation',
    'Mark a tax calendar obligation done or not-applicable, or record the amount paid and a note. Use status="done" when a filing or payment has been made, and status="dismissed" when it genuinely does not apply to this entity (for example an S-corp that owes no Florida F-1120). Generated obligations cannot be deleted — dismiss them instead.',
    {
      obligation_id: z.string().describe('Obligation UUID from tax_calendar'),
      status: z.enum(['pending', 'done', 'dismissed']).optional().describe('done = filed/paid. dismissed = not applicable to this entity.'),
      amount: z.number().optional().describe('Amount paid, for estimated payments'),
      notes: z.string().optional().describe('Free-text note — confirmation number, who filed it, why it was dismissed'),
    },
    async ({ obligation_id, ...patch }) => {
      return text(await call('PATCH', `/api/calendar/${obligation_id}`, patch))
    })

  // ─── Tool: add_obligation ───
  server.tool('add_obligation',
    'Add a custom deadline to the tax calendar that the rules engine does not generate — an insurance renewal, a business licence, a trust review, a board meeting. For tax filings and estimated payments, do NOT use this: those are generated automatically and adding them by hand creates duplicates.',
    {
      entity_id: z.string().describe('Entity UUID this deadline belongs to'),
      title: z.string().describe('What is due, in plain language'),
      due_date: z.string().describe('Due date as YYYY-MM-DD'),
      notes: z.string().optional().describe('Detail — policy number, who owns it, what happens if missed'),
      amount: z.number().optional().describe('Amount due, if there is one'),
    },
    async (params) => text(await call('POST', '/api/calendar', params)))

  // ─── Tool: query_catalog ───
  // The owner's rule (2026-10-17): every question about a return is answered
  // from the catalog, never by going back to the PDF. In-band in the
  // description as well as INSTRUCTIONS, because instructions-only rules
  // demonstrably don't hold (see list_entities).
  server.tool('query_catalog',
    'Answer a question about a filed or computed return FROM ITS CATALOG — every box, checkbox, K-1 item, statement row and worksheet line of every page, each with its form, section, line, column and page. This is THE way to read a return: do not open the PDF, and do not use the filed_import tax_return row (partial). Filter by any combination: years, forms ("1120-S", "K-1", "Schedule E", "8960", or IRS slugs like f1120ssk), section ("Schedule L", "Part II", or a statement title), line ("19", "17a", "A", "J(2)"), col ("d"), row ("A"), canonical key, or free text (matches the IRS line label, its official description and the printed text — e.g. "passive", "loans from shareholders", "material participation"). Each hit has `where` — cite it in your answer. No hits means the catalog has no such line for that return: say so; check catalog_status for coverage.',
    {
      entity_id: z.string().describe('Entity UUID'),
      years: z.array(z.number()).optional().describe('Tax years to search; omit for all catalogued years'),
      forms: z.array(z.string()).optional().describe('Form names or IRS slugs, e.g. ["1120-S"], ["K-1"], ["Schedule E"], ["8960"], ["statement"]'),
      section: z.string().optional().describe('Section or statement title substring, e.g. "Schedule L", "Schedule B", "Part II", "Other Deductions"'),
      line: z.string().optional().describe('Printed line exactly as on the form: "19", "17a", "A", "J(2)"'),
      col: z.string().optional().describe('Column letter/number, e.g. "d" for Schedule L end of year'),
      row: z.string().optional().describe('Table row, e.g. "A" for the first Schedule E Part II row'),
      canonical: z.string().optional().describe('Canonical field_values key, or a prefix ending in "." (e.g. "schedK.")'),
      text: z.string().optional().describe('Words that must all appear in the label, the IRS description or the printed text'),
      kinds: z.array(z.enum(['amount', 'text', 'check', 'row'])).optional().describe('Restrict to amounts, text boxes, ticked checkboxes, or statement rows'),
      include_copies: z.boolean().optional().describe('Include second printed copies of a form (default false)'),
      limit: z.number().optional().describe('Max hits (default 200)'),
    },
    async ({ entity_id, years, forms, kinds, ...rest }) => {
      const qs = new URLSearchParams()
      if (years?.length) qs.set('years', years.join(','))
      if (forms?.length) qs.set('forms', forms.join(','))
      if (kinds?.length) qs.set('kinds', kinds.join(','))
      for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      return text(await call('GET', `/api/catalog/${entity_id}/query?${qs.toString()}`))
    })

  // ─── Tool: catalog_status ───
  server.tool('catalog_status',
    'Is every filed return (and IRS transcript) for this entity catalogued, and catalogued completely? Lists each filed-return document by year with its catalog status (complete / incomplete / not catalogued) and the blocking problems. Check this before answering about a year: a return that is not catalogued or incomplete must be called out, and catalogued (catalog_document) before its contents are relied on.',
    { entity_id: z.string().describe('Entity UUID') },
    async ({ entity_id }) => text(await call('GET', `/api/catalog/${entity_id}/status`)))

  // ─── Tool: catalog_document ───
  server.tool('catalog_document',
    'Catalogue a return PDF already stored as a document (list_documents): every page is matched to its IRS form and revision, and every box, check, statement row and worksheet line is stored with its line and page. Returns coverage only (no values). Re-running supersedes the previous catalog of that document; nothing is overwritten.',
    {
      document_id: z.string().describe('Document UUID'),
      tax_year: z.number().optional().describe('Tax year, if the document row lacks it'),
    },
    async ({ document_id, tax_year }) => text(await call('POST', `/api/catalog/documents/${document_id}`, tax_year ? { tax_year } : {})))

  // ─── Tool: catalog_upload ───
  server.tool('catalog_upload',
    'Store a filed return PDF (or an IRS transcript) for an entity and catalogue it in one step. Use this — not ingest_document — for returns: ingest_document runs the old partial extraction and creates another filed_import row. Returns coverage only. IRS transcripts (doc_type tax_transcript): account transcripts, return transcripts and records of account are all read into structured lines (query_catalog forms irs_transcript = account part, irs_return_transcript = the IRS\'s line-by-line copy of the return, section = its heading). The transcript\'s own period sets the tax year, and ONE golden account transcript and ONE golden return transcript are kept per entity and year: the newest by the IRS response date supersedes the older (the response says whether this one is golden).',
    {
      entity_id: z.string().describe('Entity UUID'),
      tax_year: z.number().describe('Tax year of the return'),
      filename: z.string().describe('File name, ending .pdf'),
      content_base64: z.string().describe('The PDF, base64-encoded'),
      doc_type: z.string().optional().describe('prior_return_1040 | prior_return_1120 | prior_return_1120s | prior_return_1065 | tax_transcript | irs_notice'),
    },
    async (params) => text(await call('POST', '/api/catalog/upload', params)))

  // ─── Tool: golden_view ───
  server.tool('golden_view',
    'One return year, every box side by side on the golden schema: the filed return, the IRS\'s record of it (return transcript — the figure as filed and the IRS\'s recomputation) and the returns stored here (filed import, proforma, amendment), each row with the golden value and whether the sources agree (agrees / differs / irs_only / irs_recomputed / filed_only / returns_only). Headline rows (income, deductions, taxable income, tax, payments) come first. When the IRS holds another year\'s return in this period, sources.irs_return_transcript.holds_return_of says which, and those figures are never golden. Amounts only unless include_text is true. Use this for any "does X match Y" question across sources — it replaces comparing PDFs or transcripts by hand.',
    {
      entity_id: z.string().describe('Entity UUID'),
      tax_year: z.number().describe('Tax year'),
      include_text: z.boolean().optional().describe('Also compare text and check boxes (names, addresses, Yes/No answers). Default false.'),
    },
    async ({ entity_id, tax_year, include_text }) => text(await call('GET', `/api/golden/${entity_id}?year=${tax_year}${include_text ? '&text=1' : ''}`)))

  // ─── Tool: run_review ───
  server.tool('run_review',
    'Run the FIXED review framework on an entity\'s catalogued returns for one or more tax years: catalog completeness and arithmetic, corporate status and elections, K-1 consistency, balance-sheet continuity, stock basis and distributions above basis, suspended losses, NIIT on nonpassive income, QBI/SSTB, loans, carryovers, information returns, the IRS account (transcripts, penalties, duplicates) and statute windows — plus AI judgement checks when ai=true. Every run is stored and diffed with the last: each new finding says WHY it is new (new document, new fact, framework change, or a miss). Use this instead of reviewing a return ad hoc; report what it returns, grouped by severity, with the dollar effects and deadlines, and ask the owner every fact in `asks` at once.',
    {
      entity_id: z.string().describe('Entity UUID'),
      years: z.array(z.number()).describe('Tax years to review, e.g. [2022, 2023, 2024, 2025]'),
      ai: z.boolean().optional().describe('Also run the AI judgement checks (slower; runs in the background — read with get_review)'),
    },
    async ({ entity_id, years, ai }) => text(await call('POST', `/api/review/${entity_id}/run`, { years, ai: !!ai })))

  // ─── Tool: get_review ───
  server.tool('get_review',
    'The latest stored review of an entity, per tax year: findings and gaps by severity, each with evidence (the catalog lines it rests on), dollar effect, deadline, the facts to ask, whether it is new since the previous run and why, and any recorded resolution. Also returns the return notes for those years (open and info; closed too with include_passed) — read them before acting on the return.',
    {
      entity_id: z.string().describe('Entity UUID'),
      years: z.array(z.number()).optional().describe('Restrict to these years'),
      include_passed: z.boolean().optional().describe('Include checks that passed'),
    },
    async ({ entity_id, years, include_passed }) => {
      const qs = new URLSearchParams()
      if (years?.length) qs.set('years', years.join(','))
      if (include_passed) qs.set('include_passed', '1')
      return text(await call('GET', `/api/review/${entity_id}${qs.toString() ? '?' + qs.toString() : ''}`))
    })

  // ─── Tool: review_summary ───
  server.tool('review_summary',
    'ONE list of everything to act on across all entities and years from their latest reviews — unresolved findings and gaps, most severe first, then by dollar effect and deadline — plus every fact to ask the owner, every OPEN return note (open_notes: threads no check can see, each saying who it waits on), and BREAKS (breaks: tie findings — figures that must agree within a return, year to year or across returns — in the filed returns, and for each draft version set the breaks it adds, inherits and fixes; a draft set\'s new breaks are items too, titled with the set label). This is the closed list: anything not on it was checked and passed, or is not covered by the framework (say so).',
    { entity_ids: z.array(z.string()).optional().describe('Limit to these entities') },
    async ({ entity_ids }) => text(await call('GET', `/api/review/summary${entity_ids?.length ? '?entity_ids=' + entity_ids.join(',') : ''}`)))

  // ─── Tool: resolve_finding ───
  server.tool('resolve_finding',
    'Record the owner\'s decision about a finding (fixed, accepted, not_an_issue, reopened) with a note. Keyed by the finding\'s fingerprint, so the decision carries into later runs; superseded, never overwritten.',
    {
      entity_id: z.string().describe('Entity UUID'),
      fingerprint: z.string().describe('The finding fingerprint from get_review / review_summary'),
      resolution: z.enum(['fixed', 'accepted', 'not_an_issue', 'reopened']),
      note: z.string().optional().describe('Why — what was done or decided, and by whom'),
    },
    async ({ entity_id, ...rest }) => text(await call('POST', `/api/review/${entity_id}/resolve`, rest)))

  // ─── Return notes (services/notes.ts) ───
  // The open threads about a return that are neither a fact nor a finding.
  // Before 2026-10-18 they lived only in conversation and were lost with it.
  const NOTE_RULES = 'Where things go: a question every return of this type should answer is a FACT (record_fact; if the registry has no key for it, say so — it needs adding); a decision about a review finding is resolve_finding; everything else still open about the return, or that a new session must know, is a NOTE. Never leave an open item only in the conversation.'
  const noteFields = {
    tax_year: z.number().nullable().optional().describe('The return year; null for the whole entity (a thread spanning years, e.g. a payroll refund)'),
    title: z.string().optional().describe('One line saying what is open, with the amount if there is one, e.g. "ERC refund 19,919.70 reissued 5/4/2026 — not in the books; confirm deposited"'),
    body: z.string().nullable().optional().describe('Everything a new session needs: what is known, from which document or person and when, what was tried, what settles it. Replaces the previous body (the old version is kept), so carry forward what still matters.'),
    status: z.enum(['open', 'closed', 'info']).optional().describe('open = needs something (default); closed = settled — say in body what settled it; info = standing context a new session must know, nothing to do'),
    waiting_on: z.enum(['owner', 'irs', 'preparer', 'agent', 'third_party']).nullable().optional().describe('Who must act next. Required while open. owner = the taxpayer or their representative; agent = this assistant/system'),
    fact_key: z.string().nullable().optional().describe('The registry fact this note concerns, if any'),
    finding_fingerprint: z.string().nullable().optional().describe('The review finding this note concerns, if any (from get_review / review_summary)'),
    due_date: z.string().nullable().optional().describe('YYYY-MM-DD deadline, if any'),
  }
  server.tool('add_note',
    `Add a note to a return (entity + tax year, or the whole entity). ${NOTE_RULES} Open notes appear in review_summary until closed.`,
    { entity_id: z.string().describe('Entity UUID'), ...noteFields, title: z.string().describe(noteFields.title.description!) },
    async ({ entity_id, ...rest }) => text(await call('POST', `/api/notes/${entity_id}`, rest)))

  server.tool('update_note',
    `Edit a note or close it — pass only what changes. A new version is written and the old one kept (list_notes include_history shows them). To close: status "closed" and a body that says what settled it. ${NOTE_RULES}`,
    { entity_id: z.string().describe('Entity UUID'), note_key: z.string().describe('The note_key from add_note / list_notes'), ...noteFields },
    async ({ entity_id, note_key, ...rest }) => text(await call('PATCH', `/api/notes/${entity_id}/${note_key}`, rest)))

  server.tool('list_notes',
    'The notes on a return: with tax_year, that year plus the entity-wide ones. Open and info notes by default — read them before working on the return; they hold what earlier sessions learned and what is still waiting on someone.',
    {
      entity_id: z.string().describe('Entity UUID'),
      tax_year: z.number().optional().describe('Return year (entity-wide notes are always included)'),
      include_closed: z.boolean().optional().describe('Also list closed notes'),
      include_history: z.boolean().optional().describe('Also list superseded versions'),
    },
    async ({ entity_id, tax_year, include_closed, include_history }) => {
      const qs = new URLSearchParams()
      if (tax_year !== undefined) qs.set('year', String(tax_year))
      if (!include_closed) qs.set('status', 'open,info')
      if (include_history) qs.set('history', '1')
      return text(await call('GET', `/api/notes/${entity_id}?${qs.toString()}`))
    })

  // ─── Entity map (services/entity_map.ts, review/map.ts) ───
  // How the entities in one account are tied together, stored once. Before
  // 2026-10-18 the review re-derived K-1 links from printed EINs each run and
  // everything else (ownership of the C corporations, intercompany fees and
  // balances, a disregarded payroll LLC) lived in conversation.
  const linkFields = {
    kind: z.enum(['owns', 'disregarded', 'intercompany']).optional().describe('owns: from (the owner\'s return) holds pct of to. disregarded: to is a disregarded entity of from. intercompany: from and to deal with each other; from is the side that pays or owes'),
    from_entity_id: z.string().optional().describe('Entity UUID: the owner\'s return (owns), the parent (disregarded), or the paying/owing side (intercompany)'),
    to_entity_id: z.string().nullable().optional().describe('Entity UUID of the other side, when it is in this account'),
    to_name: z.string().nullable().optional().describe('Name of the other side when it has no return in this account (give this OR to_entity_id)'),
    subject: z.string().nullable().optional().describe('owns from a joint 1040: the person who holds the interest, as named on the 1040'),
    pct: z.number().nullable().optional().describe('owns: the percentage held (required for owns)'),
    nature: z.enum(['services', 'loan', 'rent', 'settlement', 'other']).nullable().optional().describe('intercompany: how they deal (required for intercompany)'),
    from_year: z.number().nullable().optional().describe('First tax year the link holds; null = from the start'),
    to_year: z.number().nullable().optional().describe('Last tax year the link holds; null = still holds'),
    source: z.enum(['owner', 'filed_return', 'fact', 'entity_record']).optional().describe('Where the link comes from (default owner = the owner said so)'),
    evidence: z.string().nullable().optional().describe('Citation, e.g. "2025 Form 1120-S Schedule K-1 items F/G: Mansoor Razzaq, 100%". Required unless the source is the owner'),
    detail: z.string().nullable().optional().describe('Anything a new session needs about the link: what the fee is for, who decided, open questions'),
    removed: z.boolean().optional().describe('true retires a link recorded in error (kept, so its evidence is not suggested again)'),
  }
  server.tool('entity_map',
    'The entity map of the account: every entity with the years on file and what a change to its return touches; every link (owns / disregarded / intercompany) with years, source and evidence; owners and what each holds (the controlled-group picture); and "unrecorded" — evidence on file of a link nobody has recorded. Read it before reasoning across entities.',
    { include_history: z.boolean().optional().describe('Also return every version of every link') },
    async ({ include_history }) => text(await call('GET', `/api/entity-map${include_history ? '?history=1' : ''}`)))

  server.tool('record_link',
    'Record a link in the entity map — from evidence (a filed return, a fact, an entity record) or the owner\'s statement, never from inference. Take the fields from entity_map\'s "unrecorded" list when the evidence is there; add the years the link holds.',
    { ...linkFields, kind: linkFields.kind.unwrap(), from_entity_id: linkFields.from_entity_id.unwrap() },
    async (args) => text(await call('POST', '/api/entity-map/links', args)))

  server.tool('update_link',
    'Change a link in the entity map — pass only what changes (e.g. to_year when a relationship ended, pct when ownership changed, removed: true for a link recorded in error, with detail saying why). A new version is written and the old one kept.',
    { link_key: z.string().describe('The link_key from entity_map'), ...linkFields },
    async ({ link_key, ...rest }) => text(await call('PATCH', `/api/entity-map/links/${link_key}`, rest)))

  // ─── Version sets (services/versions.ts, review/versions.ts) ───
  // Restatement packages across the group, each held to the tie checks. Before
  // 2026-10-18 amendments were prepared one return at a time and nothing
  // checked that a package tied with the returns it left alone.
  const changeSchema = z.object({
    form: z.string().optional().describe('Catalog form slug: f1120, f1120s, f1120ssk (K-1), f1040, f1040se, f1125a, f1125e, f1120so … (query_catalog shows the slug as the entry form)'),
    section: z.string().optional().describe('Section as catalogued, e.g. "Schedule L", "Schedule K", "Part III"'),
    line: z.string().optional().describe('Printed line, e.g. "1a", "28", "19"'),
    col: z.string().optional().describe('Column, e.g. "d" for Schedule L end of year'),
    row: z.string().optional().describe('Table row, e.g. "A"'),
    instance: z.string().optional().describe('Repeated form instance (e.g. "k1:2"); omit for the first'),
    to: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional().describe('The line\'s value in the amended return'),
    delta: z.number().optional().describe('For an intercompany-amount change with no line of its own: the amount it moves'),
    reason: z.string().describe('Why this line changes'),
    fact_key: z.enum(['intercompany.fee_expense', 'intercompany.fee_revenue', 'intercompany.balance_end']).optional().describe('The intercompany amount this change moves (so the cross-entity ties see it)'),
    subject: z.string().optional().describe('With fact_key: the related company, as named in the entity map'),
    add: z.boolean().optional().describe('true when the line is not on the filed return (the amendment adds it)'),
  })
  server.tool('version_sets',
    'Every version set (restatement package): label, title, status (draft / filed / abandoned), and each amended return in it with its changed lines (from → to, reason). "filed" is not listed: it is the filed returns plus every filed set.',
    {},
    async () => text(await call('GET', '/api/version-sets')))

  server.tool('create_version_set',
    'Start a draft version set — a restatement package across the group (label v1, v2, …). Add amended returns with put_return_version; check it ties with review_version_set.',
    {
      label: z.string().describe('Short lowercase label, e.g. v1'),
      title: z.string().optional().describe('What the package does, e.g. "Intercompany fee true-up 2023"'),
      description: z.string().optional().describe('Why, decided by whom, and what it is expected to fix'),
    },
    async (args) => text(await call('POST', '/api/version-sets', args)))

  server.tool('put_return_version',
    'Add (or replace) one amended return in a draft set: the lines it changes. Each change is checked against the return it amends (the filed return plus filed sets); a line that is not there is refused unless add: true, and the value it replaces is recorded. List every line the amendment changes — totals included — or the arithmetic tie breaks. A change that moves an intercompany fee or balance names fact_key and subject so the cross-entity ties see it.',
    {
      label: z.string().describe('The draft set, e.g. v1'),
      entity_id: z.string().describe('Entity UUID'),
      tax_year: z.number().describe('Tax year of the return amended'),
      form: z.string().optional().describe('The amended return, e.g. 1120-X, 1040-X, 1120-S (amended)'),
      note: z.string().optional().describe('Anything a reviewer needs: what drove the amendment, what is still uncertain'),
      changes: z.array(changeSchema).describe('The lines this version changes'),
    },
    async ({ label, ...rest }) => text(await call('PUT', `/api/version-sets/${encodeURIComponent(label)}/versions`, rest)))

  server.tool('remove_return_version',
    'Take one amended return out of a draft set (the return goes back to as filed in that set).',
    { label: z.string(), entity_id: z.string().describe('Entity UUID'), tax_year: z.number() },
    async ({ label, entity_id, tax_year }) => text(await call('DELETE', `/api/version-sets/${encodeURIComponent(label)}/versions/${entity_id}/${tax_year}`)))

  server.tool('update_version_set',
    'Rename or describe a draft set, or change its status: filed (the package was sent — give filed_on; the filed view then includes it and is re-reviewed) or abandoned (dropped; in no view). Filed and abandoned sets are frozen.',
    {
      label: z.string(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      status: z.enum(['filed', 'abandoned']).optional(),
      filed_on: z.string().optional().describe('YYYY-MM-DD the package was filed'),
    },
    async ({ label, ...rest }) => text(await call('PATCH', `/api/version-sets/${encodeURIComponent(label)}`, rest)))

  server.tool('review_version_set',
    'Check that a set ties. For a draft set: runs the tie checks on every return as the set has it and reports its breaks — each marked new (the package caused or exposed it) or inherited (already in the filed returns) — and the filed breaks it fixes; ties: true means no breaks at all. For "filed": re-runs the full rules review of every filed return and lists its breaks. Report new breaks first: a package is not ready while it has any.',
    { label: z.string().describe('A draft set label, or "filed"') },
    async ({ label }) => text(await call('POST', `/api/version-sets/${encodeURIComponent(label)}/review`, {})))

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
  server.tool('stripe_data', `Query Stripe data for an entity. Single dispatcher for all Stripe pulls.

- data_type='revenue', year → annual gross/fees/net summary for tax reporting (small, cache-friendly). Pages internally; no cursor needed.
- data_type='invoices'|'payments'|'payouts'|'customers' (+ filters) → lists. Default 50 rows per page, max 100 (Stripe's own ceiling).

PAGING: a list response carries has_more and next_cursor. To get the next page, pass next_cursor back as cursor. Repeat until next_cursor is null. A list is NOT the whole set just because it came back — check has_more before concluding something is absent.

FINDING A CUSTOMER: data_type='customers' with name='acme' does a substring name search; with email= it filters by exact email. Invoice rows carry the customer ID in 'customer', so you do not need a lookup to act on an invoice you can already see.

Year-long invoice/payment pulls can be huge — pass spill_to to park the payload in scratch storage and get shape+preview back.`, {
    entity_id: z.string().describe('Entity UUID'),
    data_type: z.enum(['invoices', 'payments', 'payouts', 'customers', 'revenue']).describe('What to pull'),
    year: z.number().optional().describe('Tax year (revenue only)'),
    status: z.string().optional().describe('Invoice status: draft, open, paid, void, uncollectible'),
    customer: z.string().optional().describe('Stripe customer ID (invoices only)'),
    email: z.string().optional().describe('Exact email filter (customers only)'),
    name: z.string().optional().describe('Substring name search (customers only) — e.g. name="acme" matches "Acme Holdings LLC"'),
    limit: z.number().optional().describe('Rows per page, max 100'),
    cursor: z.string().optional().describe("next_cursor from the previous response, to fetch the next page"),
    created_gte: z.string().optional().describe('Date floor (Unix ts or YYYY-MM-DD) — invoices/payments'),
    created_lte: z.string().optional().describe('Date ceiling — invoices/payments'),
    spill_to: z.string().optional().describe('Scratch key to park the full response under. Use for year-spanning invoice/payment/customer lists.'),
  }, async ({ entity_id, data_type, year, spill_to, ...filters }) => {
    let response: any
    if (data_type === 'revenue') {
      const qs = year ? `?year=${year}` : ''
      response = await call('GET', `/api/stripe/${entity_id}/revenue${qs}`)
    } else {
      // Cap list responses to keep chat context small. The ceiling is Stripe's
      // own: it 400s on limit > 100, so the old HARD_MAX of 200 here turned a
      // request for a big page into an error rather than a page. Paging past
      // this is what `cursor` is for.
      const effectiveLimit = Math.min(Number(filters.limit) || DEFAULT_LIMIT, STRIPE_PAGE_MAX)
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

  // ─── Tool: stripe_invoice ───
  // Write-side sibling of stripe_data. The confirmation rule rides in-band
  // in the description because instructions-only rules don't hold (see the
  // id-citation postmortem): pay moves real money and void is terminal.
  server.tool('stripe_invoice', `Create and act on Stripe invoices for an entity. This is the LIVE Stripe account — real invoices, real charges.

- action='create' → make a DRAFT invoice from explicit line items (amounts in DOLLARS, e.g. 349.5 = $349.50). Nothing is emailed or charged; report the draft back for review.
- action='finalize' → lock the draft: assigns the invoice number and mints hosted_invoice_url / invoice_pdf. Does not email or charge by itself.
- action='pay' → immediately charges the customer's default payment method for the full amount due.
- action='void' → permanently cancels a finalized invoice. Cannot be undone (delete drafts in the Stripe dashboard instead).

RULE — no exceptions: before 'pay' or 'void', state the invoice number, customer, and amount to the user and get an explicit yes in THIS conversation. Never chain create→finalize→pay in one turn on your own judgment. Find customer ids via stripe_data data_type='customers'.`, {
    entity_id: z.string().describe('Entity UUID'),
    action: z.enum(['create', 'finalize', 'pay', 'void']).describe('Invoice lifecycle action'),
    invoice_id: z.string().optional().describe('Stripe invoice id (in_...) — required for finalize/pay/void'),
    customer: z.string().optional().describe('Stripe customer id (cus_...) — required for create'),
    lines: z.array(z.object({
      description: z.string(),
      amount: z.number().describe('Line amount in DOLLARS'),
    })).optional().describe('Line items — required for create'),
    currency: z.string().optional().describe("ISO currency (default 'usd')"),
    description: z.string().optional().describe('Invoice memo shown to the customer (create only)'),
    footer: z.string().optional().describe('Invoice footer text (create only)'),
    collection_method: z.enum(['send_invoice', 'charge_automatically']).optional().describe("How the finalized invoice collects (default 'send_invoice')"),
    days_until_due: z.number().optional().describe('Payment terms for send_invoice (default 30)'),
  }, async ({ entity_id, action, invoice_id, ...body }) => {
    if (action === 'create') {
      return text(await call('POST', `/api/stripe/${entity_id}/invoices`, body))
    }
    if (!invoice_id) throw new Error(`invoice_id is required for action='${action}'`)
    return text(await call('POST', `/api/stripe/${entity_id}/invoices/${encodeURIComponent(invoice_id)}/${action}`))
  })

  // ─── Tool: generate_k1s ───
  server.tool('generate_k1s', `Generate distributable Schedule K-1 PDFs — the ISSUER side of pass-throughs. Two modes:

- S-corp: pass return_id of a computed/filed 1120S return whose inputs carry shareholders [{name, pct}] — one K-1 per shareholder from the engine's pro-rata allocation. Shareholder TIN/address fill in from the entity's meta.owners when names match; otherwise those boxes stay blank for hand completion.
- Partnership: pass p1065 with the partnership header, Schedule K totals, and partners — Cati has NO 1065 return engine, so totals are the caller's numbers; the allocator splits pro-rata (profit_pct for income, capital_pct for distributions; guaranteed payments are per-partner; SE earnings computed for general partners only). Special allocations are NOT supported — say so instead of forcing them through.

Coded boxes (1120-S 10/12/16/17; 1065 13/14/19/20), including the Section 199A Statement A (QBI, W-2 wages, UBIA), are carried on an attached supplemental statement page. Returned URLs expire in 1 hour. These are filing documents: show the user the allocation summary and remind them to verify before distributing.`, {
    return_id: z.string().optional().describe('1120S return UUID (S-corp mode)'),
    p1065: z.object({
      tax_year: z.number(),
      partnership: z.object({
        name: z.string(), ein: z.string().optional(), address: z.string().optional(),
        city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(),
      }),
      totals: z.record(z.number()).optional().describe('Schedule K totals: ordinary_business_income, rental_real_estate, other_rental, interest_income, dividends_ordinary, dividends_qualified, royalties, st_cap_gain, lt_cap_gain, net_1231_gain, section_179, charitable, distributions, w2_wages, ubia'),
      partners: z.array(z.object({
        name: z.string(), tin: z.string().optional(), address: z.string().optional(),
        entity_type: z.string().optional(), is_general: z.boolean().optional(),
        profit_pct: z.number(), loss_pct: z.number().optional(), capital_pct: z.number().optional(),
        guaranteed_payments_services: z.number().optional(), guaranteed_payments_capital: z.number().optional(),
      })),
    }).optional().describe('Partnership mode payload'),
  }, async ({ return_id, p1065 }) => {
    if (!!return_id === !!p1065) throw new Error('Pass exactly one of return_id (1120S) or p1065 (partnership)')
    if (return_id) return text(await call('POST', `/api/returns/${return_id}/k1s`))
    return text(await call('POST', '/api/returns/k1s/1065', p1065))
  })

  // ─── Tool: file_extension ───
  server.tool('file_extension', `File a tax extension (4868 individual, 7004 business, 8868 exempt org). Generates a filled PDF on generate_pdf:true.

Extensions are time-sensitive. Collect the minimum: taxpayer_name, taxpayer_id (SSN/EIN), address/city/state/zip, estimated_tax_liability, total_payments, amount_paying. Flow: validate_extension → file_extension(generate_pdf:true).

Form-specific extras:
  4868 — nothing extra beyond the minimums.
  7004 — form_code: "12"=1120, "25"=1120-S, "09"=1065, "13"=1041 (trust), etc.
  8868 — return_code: "01"=990, "02"=990-EZ, "03"=990-PF, "04"=990-T.`, {
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
    // ── Protocol-version forward-compat shim ──────────────────────────
    // Anthropic's connector gateway stamps follow-up requests with the
    // NEWEST MCP protocol version it speaks (seen live: 2026-07-28), which
    // can be newer than any published SDK. The SDK transport hard-400s an
    // unknown MCP-Protocol-Version header, and the gateway surfaces that to
    // Claude as "failed to connect (502)" — which broke every fresh
    // connector connection while established sessions kept working.
    //
    // Per spec the server negotiates DOWN at initialize anyway, so treating
    // an unknown header version as our newest supported one is the graceful
    // reading. Pinned to the SDK's own list: the moment the SDK learns the
    // new version, this becomes a no-op.
    const hdrVer = req.headers['mcp-protocol-version']
    if (typeof hdrVer === 'string' && !SUPPORTED_PROTOCOL_VERSIONS.includes(hdrVer)) {
      console.warn(`[mcp] downgrading unknown protocol version ${hdrVer} -> ${LATEST_PROTOCOL_VERSION}`)
      req.headers['mcp-protocol-version'] = LATEST_PROTOCOL_VERSION
      // SDK 1.30's Node wrapper converts to a web Request via Hono's
      // getRequestListener, which builds headers from rawHeaders — so the
      // parsed-headers rewrite above is invisible to it. Rewrite the raw
      // pair too ([k, v, k, v, ...], case-insensitive keys).
      for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'mcp-protocol-version') {
          req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION
        }
      }
    }

    const apiKey = extractApiKey(req)
    if (!apiKey) {
      // RFC 9728: point the client at our protected-resource metadata so it
      // can discover the authorization server AND verify the resource URL
      // matches the MCP endpoint it's connecting to. The metadata must live
      // under the same origin as the MCP endpoint (fin.catipult.ai), not
      // under tax-api.catalogshub.com, or the MCP SDK will reject auth with
      // "Protected resource X does not match expected Y".
      const resourceOrigin = process.env.OAUTH_RESOURCE_ORIGIN || 'https://fin.catipult.ai'
      const resourceMetadataUrl = `${resourceOrigin}/.well-known/oauth-protected-resource`
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl}"`,
      )
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
