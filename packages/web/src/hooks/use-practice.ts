/**
 * The practice workspace's server state (packages/api/src/routes/practice.ts).
 * Response shapes follow services/practice.ts; amounts are in cents.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { supabase } from '@/lib/supabase'

export type PeriodStatus = 'filed' | 'no_return_filed' | 'activity_no_return' | 'no_irs_account' | 'not_authorized' | 'never_synced' | 'no_transactions'
export type Stage = 'draft' | 'awaiting_signature' | 'signed' | 'submitted' | 'readable' | 'claimed' | 'imported'

export interface Designee { name?: string; caf?: string; ptin?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string; fax?: string; source?: 'platform' | 'own' }
export interface Practice { id: string; name: string; designee_mode: 'platform' | 'own'; designee: Designee; provider: 'taxnow' | 'fixture' | 'import' }
export interface ClientSummary {
  balance_due_cents: number; credit_held_cents: number; deposits_awaiting_cents: number; penalties_standing_cents: number
  filed_through: number | null; income_form: string | null; oldest_sync: string | null; newest_sync: string | null; other_viewers?: string[]
}
export interface ClientRow {
  id: string; entity_id: string; name: string; form_type: string; stage: Stage; tin_last4: string | null
  /** A test client (Didit sandbox; its 8821 stamped not for filing). */
  test?: boolean
  summary: ClientSummary | null; status_counts: Partial<Record<PeriodStatus, number>>
  findings: { count: number; amount_cents: number; by_section: Record<string, number> }
  last_read_at: string | null; oldest_sync: string | null; submitted_at: string | null; last_check_at: string | null; check_count: number; signed: boolean
  /** An imported client's number in the export. */
  import_key: string | null
}
export interface Finding {
  id: string; practice_client_id: string; client_name?: string; section: 'income' | 'payroll' | 'risk'; type: string; severity: string
  form: string; tax_year: number; period_month: number | null; amount_cents: number | null; note: string
  /** Penalties: what abatement would refund, and take off the balance due. */
  refund_cents?: number | null; lowers_owed_cents?: number | null
  rules_version?: string | null
  /** Stable across recomputes: what a verdict is keyed by. */
  key: string
  verdict: Verdict | null
}
export interface Verdict { verdict: 'valid' | 'invalid' | 'unsure'; note: string; amount_cents: number | null; rules_version: string | null; decided_at: string }
/** An import of an export, or a re-run of the analysis. Counts only. */
export interface Run {
  id: string; kind: 'import' | 'analysis'; status: 'uploading' | 'queued' | 'running' | 'done' | 'failed'
  file_name: string | null; bytes: number | null; as_of: string | null; rules_version: string; sha256: string | null
  stats: { rows?: number; clients?: number; periods?: number; transactions?: number; by_status?: Record<string, number>; by_form?: Record<string, number> } | null
  changes: {
    clients_added: number; clients_absent: number; clients_seen: number; clients_changed: number; periods_written: number; periods_unchanged: number; periods_removed: number
    findings_before: number; findings_after: number; findings_new: Record<string, number>; findings_gone: Record<string, number>; changed_clients: string[]
  } | null
  error: string | null; created_at: string; started_at: string | null; finished_at: string | null; batches_total: number | null; batches_done: number | null
}
export interface Txn { seq: number; code: string; explanation: string; date: string | null; amountCents: number | null; family: string; action: string | null; reverses?: string | null }
export interface Transcript {
  type: 'ACTR' | 'RETR'; form: string; tax_year: number; period_month: number; status: PeriodStatus; synced_at: string | null; response_date: string | null
  parsed: { balanceCents: number | null; txns: Txn[]; formTitle: string; returnLines: Array<{ label: string; valueText: string }> } | null
  retr: Array<{ name: string; items: Array<{ key: string; value: string }> }> | null
}
/** The signer's identity check (Didit): where it stands, never the SSN beyond its last four. */
export interface IdentityCheck {
  status: 'started' | 'approved' | 'declined' | 'review'; didit_status: string; environment: 'live' | 'sandbox'
  started_at: string; decided_at: string | null; attempts: number; ssn_last4: string; reason: string | null
  person: { name: string; document: { type: string | null; issuing_state: string | null; expires: string | null } } | null
  checks: { id_document: string | null; liveness: string | null; face_match: string | null; name_matches_signer: boolean; ssn: string | null } | null
}
/** A business signer's proof they belong to the business: what was read from it. */
export interface MembershipProof {
  status: 'approved' | 'declined' | 'review'; environment: 'live' | 'sandbox'; uploaded_at: string; attempts: number; file_name: string; reason: string | null
  read: { doc_kind: string | null; entity_name: string | null; ein_last4: string | null; person_name: string | null; role: string | null }
  checks: { ein_matches: boolean | null; person_matches: boolean; entity_name_matches: boolean }
}
export interface ClientDetail {
  client: {
    id: string; entity_id: string; name: string; form_type: string; stage: Stage; tin_last4: string | null; import_key?: string | null; test?: boolean
    authorization_scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number; year_end_month?: number; imported?: boolean }
    signed_at: string | null; submitted_at: string | null; last_check_at: string | null; check_count: number; readable_at: string | null; last_read_at: string | null
    summary: ClientSummary | null
    /** Verified first, signed second: `signed_at` is set only once they have drawn. */
    signer: {
      name: string; title: string; id_verified_at: string | null; id_method: string | null; method: 'link' | 'in_app' | null
      idv: IdentityCheck | null; proof: MembershipProof | null; print_name: string | null; signed_copy_sha256: string | null
    } | null
    filing: { sent_at: string | null; confirmed_at: string | null }
  }
  transcripts: Transcript[]
  findings: Finding[]
}
export interface Coverage {
  designee: Designee; provider: string
  clients: Array<Pick<ClientRow, 'id' | 'name' | 'stage' | 'status_counts' | 'oldest_sync' | 'last_read_at' | 'submitted_at' | 'last_check_at' | 'check_count' | 'signed'>>
  gaps: Array<{ client_id: string; client_name: string; form: string; periods: string[] }>
  ages: { under_30: number; d30_90: number; d90_365: number; over_365: number; never: number; refused: number }
}

/** A signed 8821 on the staff filing desk. */
export interface FilingItem {
  id: string; client: string; form_type: string; practice: string; tin_last4: string | null; stage: Stage
  signed_at: string; signer: string; test_check: boolean; sha256: string
  submission: { sent_at: string; sent_by: string; sent_to: string; note: string | null; confirmed_at?: string; confirmation_note?: string | null } | null
  confirmed_at: string | null
}
export interface DrawnSignature { signature_png: string; signer_title: string; agree: boolean }
export interface CheckStart { signer_name?: string; signer_title?: string; ssn: string }

function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!path) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      setData(await api<T>(path))
    } catch (e: unknown) {
      setData(null)
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
    setLoading(false)
  }, [path])
  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

/** The practice, or `none` when this login has not created one yet. */
export function usePractice() {
  const [state, setState] = useState<{ practice: Practice | null; designee: Designee | null; admin: boolean; staff: boolean; none: boolean }>({ practice: null, designee: null, admin: false, staff: false, none: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api<{ practice: Practice; designee: Designee; admin: boolean; staff: boolean }>('/api/practice')
      setState({ practice: r.practice, designee: r.designee, admin: r.admin, staff: !!r.staff, none: false })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      if (/No practice yet/.test(msg)) setState({ practice: null, designee: null, admin: false, staff: false, none: true })
      else setError(msg)
    }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  return { ...state, loading, error, reload: load }
}

export const usePracticeClients = () => {
  const r = useResource<{ clients: ClientRow[] }>('/api/practice/clients')
  return { clients: r.data?.clients ?? [], loading: r.loading, error: r.error, reload: r.reload }
}
export const useOpportunities = () => {
  const r = useResource<{ findings: Finding[] }>('/api/practice/opportunities')
  return { findings: r.data?.findings ?? [], loading: r.loading, error: r.error, reload: r.reload }
}
export const usePracticeClient = (id: string | undefined) => useResource<ClientDetail>(id ? `/api/practice/clients/${id}` : null)
export const useCoverage = () => useResource<Coverage>('/api/practice/coverage')
export const useRuns = () => {
  const r = useResource<{ runs: Run[] }>('/api/practice/imports')
  return { runs: r.data?.runs ?? [], loading: r.loading, error: r.error, reload: r.reload }
}
export const useFilingDesk = () => {
  const r = useResource<{ items: FilingItem[] }>('/api/practice/filing')
  return { items: r.data?.items ?? [], loading: r.loading, error: r.error, reload: r.reload }
}

async function savePdf(path: string, filename: string) {
  const { data } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_API_URL || ''}${path}`, { headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {} })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not get the 8821')
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** The client's Form 8821 (authenticated): the fillable draft, or once signed the signed copy. */
export const download8821 = (clientId: string, name: string, signed = false) =>
  savePdf(`/api/practice/clients/${clientId}/8821.pdf`, `${name.replace(/[^A-Za-z0-9]+/g, '_')}_8821${signed ? '_signed' : ''}.pdf`)
/** Staff: the kept signed copy, exactly as it is sent. */
export const downloadSigned8821 = (clientId: string, name: string) =>
  savePdf(`/api/practice/filing/${clientId}/8821.pdf`, `${name.replace(/[^A-Za-z0-9]+/g, '_')}_8821_signed.pdf`)

export const practiceApi = {
  create: (name: string) => api('/api/practice', { method: 'POST', body: JSON.stringify({ name }) }),
  update: (body: Partial<Pick<Practice, 'name' | 'designee_mode' | 'designee'>>) => api('/api/practice', { method: 'PATCH', body: JSON.stringify(body) }),
  createClient: (body: { name: string; form_type: string; tin?: string; year_end_month?: number; scope?: { income?: boolean; payroll?: string[] }; test?: boolean }) =>
    api<{ id: string; entity_id: string }>('/api/practice/clients', { method: 'POST', body: JSON.stringify(body) }),
  signLink: (id: string) => api<{ path: string; expires: string }>(`/api/practice/clients/${id}/sign-link`, { method: 'POST' }),
  signInApp: (id: string, body: DrawnSignature) => api(`/api/practice/clients/${id}/sign`, { method: 'POST', body: JSON.stringify(body) }),
  verifySigner: (id: string, body: CheckStart) => api<{ url: string; session_id: string }>(`/api/practice/clients/${id}/verify`, { method: 'POST', body: JSON.stringify(body) }),
  submitProof: (id: string, body: { file_name: string; content_base64: string }) => api<MembershipProof>(`/api/practice/clients/${id}/proof`, { method: 'POST', body: JSON.stringify(body) }),
  idVerified: (id: string, body: { method: string; signer_name?: string; signer_title?: string }) => api(`/api/practice/clients/${id}/id-verified`, { method: 'POST', body: JSON.stringify(body) }),
  filingSent: (id: string, body: { sent_to: string; note?: string }) => api(`/api/practice/filing/${id}/sent`, { method: 'POST', body: JSON.stringify(body) }),
  filingConfirmed: (id: string, body: { note?: string }) => api(`/api/practice/filing/${id}/confirmed`, { method: 'POST', body: JSON.stringify(body) }),
  check: (id: string) => api<{ found: boolean }>(`/api/practice/clients/${id}/check`, { method: 'POST' }),
  read: (id: string) => api<{ job_id: string }>(`/api/practice/clients/${id}/read`, { method: 'POST' }),
  irsRequests: (id: string, transcripts: Array<{ type: 'ACTR' | 'RETR'; form: string; year: number; month: number }>) =>
    api<{ job_id: string; count: number }>(`/api/practice/clients/${id}/irs-requests`, { method: 'POST', body: JSON.stringify({ transcripts, confirm: true }) }),
  job: (id: string) => api<{ job: { status: string; error: string | null; result: unknown } }>(`/api/practice/jobs/${id}`),
  beginImport: (body: { file_name: string; bytes: number; as_of?: string }) =>
    api<{ run_id: string; upload_url: string; content_type: string }>('/api/practice/imports', { method: 'POST', body: JSON.stringify(body) }),
  importUploaded: (id: string) => api<{ run: Run }>(`/api/practice/imports/${id}/uploaded`, { method: 'POST' }),
  run: (id: string) => api<{ run: Run }>(`/api/practice/imports/${id}`),
  rerun: () => api<{ run: Run }>('/api/practice/analysis', { method: 'POST' }),
  verdict: (body: { client_id: string; key: string; verdict: 'valid' | 'invalid' | 'unsure' | 'clear'; note?: string }) =>
    api<{ verdict: Verdict | null }>('/api/practice/verdicts', { method: 'PUT', body: JSON.stringify(body) }),
  claimAll: () => api<{ claimed: number; skipped: number }>('/api/practice/claim', { method: 'POST', body: JSON.stringify({ all: true }) }),
}
