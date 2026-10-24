/**
 * The practice workspace's server state (packages/api/src/routes/practice.ts).
 * Response shapes follow services/practice.ts; amounts are in cents.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { supabase } from '@/lib/supabase'

export type PeriodStatus = 'filed' | 'no_return_filed' | 'activity_no_return' | 'no_irs_account' | 'not_authorized' | 'never_synced'
export type Stage = 'draft' | 'awaiting_signature' | 'signed' | 'submitted' | 'readable' | 'claimed'

export interface Designee { name?: string; caf?: string; ptin?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string; fax?: string; source?: 'platform' | 'own' }
export interface Practice { id: string; name: string; designee_mode: 'platform' | 'own'; designee: Designee; provider: 'taxnow' | 'fixture' }
export interface ClientSummary {
  balance_due_cents: number; credit_held_cents: number; deposits_awaiting_cents: number; penalties_standing_cents: number
  filed_through: number | null; income_form: string | null; oldest_sync: string | null; newest_sync: string | null; other_viewers?: string[]
}
export interface ClientRow {
  id: string; entity_id: string; name: string; form_type: string; stage: Stage; tin_last4: string | null
  summary: ClientSummary | null; status_counts: Partial<Record<PeriodStatus, number>>
  findings: { count: number; amount_cents: number; by_section: Record<string, number> }
  last_read_at: string | null; oldest_sync: string | null; submitted_at: string | null; last_check_at: string | null; check_count: number; signed: boolean
}
export interface Finding {
  id: string; practice_client_id: string; client_name?: string; section: 'income' | 'payroll' | 'risk'; type: string; severity: string
  form: string; tax_year: number; period_month: number | null; amount_cents: number | null; note: string
}
export interface Txn { seq: number; code: string; explanation: string; date: string | null; amountCents: number | null; family: string; action: string | null }
export interface Transcript {
  type: 'ACTR' | 'RETR'; form: string; tax_year: number; period_month: number; status: PeriodStatus; synced_at: string | null; response_date: string | null
  parsed: { balanceCents: number | null; txns: Txn[]; formTitle: string; returnLines: Array<{ label: string; valueText: string }> } | null
  retr: Array<{ name: string; items: Array<{ key: string; value: string }> }> | null
}
export interface ClientDetail {
  client: {
    id: string; entity_id: string; name: string; form_type: string; stage: Stage; tin_last4: string | null
    authorization_scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number; year_end_month?: number; imported?: boolean }
    signed_at: string | null; submitted_at: string | null; last_check_at: string | null; check_count: number; readable_at: string | null; last_read_at: string | null
    summary: ClientSummary | null; signer: { name: string; title: string; id_verified_at: string | null; method: string } | null
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
  const [state, setState] = useState<{ practice: Practice | null; designee: Designee | null; admin: boolean; none: boolean }>({ practice: null, designee: null, admin: false, none: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api<{ practice: Practice; designee: Designee; admin: boolean }>('/api/practice')
      setState({ practice: r.practice, designee: r.designee, admin: r.admin, none: false })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      if (/No practice yet/.test(msg)) setState({ practice: null, designee: null, admin: false, none: true })
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

/** Fetch the client's filled Form 8821 (authenticated) and save it. */
export async function download8821(clientId: string, name: string) {
  const { data } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/practice/clients/${clientId}/8821.pdf`, { headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {} })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make the 8821')
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/[^A-Za-z0-9]+/g, '_')}_8821.pdf`
  a.click()
  URL.revokeObjectURL(url)
}

export const practiceApi = {
  create: (name: string) => api('/api/practice', { method: 'POST', body: JSON.stringify({ name }) }),
  update: (body: Partial<Pick<Practice, 'name' | 'designee_mode' | 'designee'>>) => api('/api/practice', { method: 'PATCH', body: JSON.stringify(body) }),
  createClient: (body: { name: string; form_type: string; tin?: string; year_end_month?: number; scope?: { income?: boolean; payroll?: string[] } }) =>
    api<{ id: string; entity_id: string }>('/api/practice/clients', { method: 'POST', body: JSON.stringify(body) }),
  signLink: (id: string) => api<{ path: string; expires: string }>(`/api/practice/clients/${id}/sign-link`, { method: 'POST' }),
  signInApp: (id: string, body: { signer_name: string; signer_title: string; typed_signature: string; agree: boolean }) =>
    api(`/api/practice/clients/${id}/sign`, { method: 'POST', body: JSON.stringify(body) }),
  idVerified: (id: string, method: string) => api(`/api/practice/clients/${id}/id-verified`, { method: 'POST', body: JSON.stringify({ method }) }),
  submitted: (id: string) => api(`/api/practice/clients/${id}/submitted`, { method: 'POST' }),
  check: (id: string) => api<{ found: boolean }>(`/api/practice/clients/${id}/check`, { method: 'POST' }),
  read: (id: string) => api<{ job_id: string }>(`/api/practice/clients/${id}/read`, { method: 'POST' }),
  irsRequests: (id: string, transcripts: Array<{ type: 'ACTR' | 'RETR'; form: string; year: number; month: number }>) =>
    api<{ job_id: string; count: number }>(`/api/practice/clients/${id}/irs-requests`, { method: 'POST', body: JSON.stringify({ transcripts, confirm: true }) }),
  job: (id: string) => api<{ job: { status: string; error: string | null; result: unknown } }>(`/api/practice/jobs/${id}`),
  claimAll: () => api<{ claimed: number; skipped: number }>('/api/practice/claim', { method: 'POST', body: JSON.stringify({ all: true }) }),
}
