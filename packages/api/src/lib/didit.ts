/**
 * Didit (didit.me): the identity check of the person who signs a client's
 * Form 8821 (services/signer_idv.ts).
 *
 * Why Didit (Mansoor, 2026-10-24): the IRS requires whoever submits an
 * electronically signed 8821 for a taxpayer they have no relationship with to
 * authenticate the signer — a government photo ID compared to the person by
 * selfie or video, and name/address/SSN checked against a second source
 * (irs.gov "Submit forms 2848 and 8821 online"). Catipult submits under the
 * platform designee's CAF and knows none of the practices' clients, so every
 * remote signer is checked. Didit was the cheapest that does it: ID +
 * liveness + face match $0.33, US identity lookup (credit bureau + financial
 * services, with the SSN) about $0.27. Stripe Identity ($2) and Veriff
 * ($0.80 + $49/month) were the alternatives.
 *
 * Two applications, two keys (SSM): DIDIT_API_KEY / DIDIT_WORKFLOW_ID is the
 * live one, used for real practices; DIDIT_SANDBOX_API_KEY /
 * DIDIT_SANDBOX_WORKFLOW_ID mocks every provider and bills nothing, used for
 * the fictional demo practice and the e2e tests. A sandbox result never counts
 * for a real client — the environment is chosen by the practice, not by the
 * caller.
 *
 * The ID images stay with Didit; nothing here downloads them.
 */

const BASE = 'https://verification.didit.me'

export type DiditEnv = 'live' | 'sandbox'

export class DiditError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function diditConfig(env: DiditEnv): { apiKey: string; workflowId: string } | null {
  const apiKey = env === 'live' ? process.env.DIDIT_API_KEY : process.env.DIDIT_SANDBOX_API_KEY
  const workflowId = env === 'live' ? process.env.DIDIT_WORKFLOW_ID : process.env.DIDIT_SANDBOX_WORKFLOW_ID
  return apiKey && workflowId ? { apiKey, workflowId } : null
}

function config(env: DiditEnv) {
  const c = diditConfig(env)
  if (!c) throw new DiditError(503, 'Identity checks are not set up yet.')
  return c
}

async function call<T>(env: DiditEnv, path: string, init: RequestInit = {}): Promise<T> {
  const { apiKey } = config(env)
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { 'x-api-key': apiKey, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) })
  const text = await r.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  // Didit's error bodies name the field and the rule; never the key.
  if (!r.ok) throw new DiditError(r.status >= 500 ? 502 : r.status, `Didit ${r.status}: ${JSON.stringify(body ?? text).slice(0, 300)}`)
  return body as T
}

export interface DiditSession { session_id: string; url: string; status: string; session_token?: string }

/** A hosted verification: the signer is sent to `url`, then back to `callback`. */
export async function createSession(env: DiditEnv, p: { vendorData: string; callback: string; metadata?: Record<string, unknown> }): Promise<DiditSession> {
  const { workflowId } = config(env)
  return call<DiditSession>(env, '/v3/session/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_id: workflowId, vendor_data: p.vendorData, callback: p.callback, metadata: p.metadata ?? {}, language: 'en' }),
  })
}

/** The parts of a session decision this product reads. */
export interface DiditDecision {
  session_id: string
  status: string // Not Started | In Progress | Approved | Declined | In Review | Abandoned | Expired | …
  environment?: string
  id_verifications?: Array<{
    status: string; document_type?: string; issuing_state?: string; expiration_date?: string
    first_name?: string; last_name?: string; full_name?: string; date_of_birth?: string
    formatted_address?: string
    parsed_address?: { street_1?: string | null; street_2?: string | null; city?: string | null; region?: string | null; postal_code?: string | null; country?: string | null }
    warnings?: unknown[]
  }> | null
  liveness_checks?: Array<{ status: string }> | null
  face_matches?: Array<{ status: string; score?: number }> | null
}

export async function getDecision(env: DiditEnv, sessionId: string): Promise<DiditDecision> {
  return call<DiditDecision>(env, `/v3/session/${encodeURIComponent(sessionId)}/decision/`)
}

export interface UsIdentityInput {
  first_name: string; last_name: string; date_of_birth?: string; ssn: string
  address?: { street_1?: string; street_2?: string; city?: string; region?: string; postal_code?: string }
  vendor_data?: string
}

export interface UsIdentityResult {
  status: string // Approved | Declined | In Review
  match_type: string // full_match | partial_match | no_match
  validations: Record<string, string> // identification_number (the SSN), full_name, date_of_birth, address …
  services_used: string[]
}

/** The SSN, name, birth date and address against US credit-bureau and
 *  financial-services records (Didit "Database Validation", USA). */
export async function validateUsIdentity(env: DiditEnv, input: UsIdentityInput): Promise<UsIdentityResult> {
  const form = new FormData()
  form.set('issuing_state', 'USA')
  // Two independent sources when the birth date is known (it always is from
  // an ID); the financial-services file cannot be queried without it.
  form.append('services', 'usa_states_credit_bureau')
  if (input.date_of_birth) form.append('services', 'usa_states_financial_services')
  form.set('first_name', input.first_name)
  form.set('last_name', input.last_name)
  form.set('ssn', input.ssn)
  if (input.date_of_birth) form.set('date_of_birth', input.date_of_birth)
  if (input.vendor_data) form.set('vendor_data', input.vendor_data)
  for (const [k, v] of Object.entries(input.address ?? {})) if (v) form.set(`address.${k}`, v)
  const r = await call<{ database_validation?: UsIdentityResult } & Partial<UsIdentityResult>>(env, '/v3/database-validation/', { method: 'POST', body: form })
  const d = r.database_validation ?? (r as UsIdentityResult)
  return { status: d.status, match_type: d.match_type, validations: d.validations ?? {}, services_used: d.services_used ?? [] }
}

export interface DocField { key: string; name: string; instruction: string; type?: 'text' | 'number' | 'date'; required?: boolean; is_full_name?: boolean }

export interface DocumentResult {
  request_id: string
  status: string // Approved | In Review | Declined
  extracted: Record<string, string | number | null>
  name_match_score: number | null
  warnings: Array<{ risk?: string; short_description?: string } & Record<string, unknown>>
}

/** Read the fields we name from one document (Didit "Document AI", $0.20).
 *  The document is kept at Didit (save_api_request) as the evidence; nothing
 *  of it is stored here beyond the fields read. Typically 5–30 s. */
export async function readDocument(env: DiditEnv, p: { file: Buffer; fileName: string; mime: string; fields: DocField[]; expectedCompanyName?: string; vendorData?: string }): Promise<DocumentResult> {
  const form = new FormData()
  form.set('document', new Blob([new Uint8Array(p.file)], { type: p.mime }), p.fileName)
  form.set('fields', JSON.stringify(p.fields))
  if (p.expectedCompanyName) form.set('expected_company_name', p.expectedCompanyName)
  if (p.vendorData) form.set('vendor_data', p.vendorData)
  form.set('save_api_request', 'true')
  const { apiKey } = config(env)
  const r = await fetch(`${BASE}/v3/document-ai/`, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form, signal: AbortSignal.timeout(60_000) })
  const text = await r.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!r.ok) throw new DiditError(r.status >= 500 ? 502 : r.status, `Didit ${r.status}: ${JSON.stringify(body ?? text).slice(0, 300)}`)
  const d = body?.document_ai ?? {}
  return { request_id: body?.request_id ?? '', status: d.status ?? '', extracted: d.extracted_data ?? {}, name_match_score: d.name_match_score ?? null, warnings: d.warnings ?? [] }
}
