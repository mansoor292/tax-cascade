import { supabase } from './supabase'

const API_BASE = import.meta.env.VITE_API_URL || ''

async function getHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (data.session?.access_token) {
    headers['Authorization'] = `Bearer ${data.session.access_token}`
  }
  return headers
}

export async function apiFetch<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = await getHeaders()
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...(opts.headers as Record<string, string> || {}) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `API error: ${res.status}`)
  }
  return res.json()
}

// Compute endpoints
export const compute = {
  form1120: (data: any) => apiFetch('/api/compute/1120', { method: 'POST', body: JSON.stringify(data) }),
  form1120s: (data: any) => apiFetch('/api/compute/1120s', { method: 'POST', body: JSON.stringify(data) }),
  form1040: (data: any) => apiFetch('/api/compute/1040', { method: 'POST', body: JSON.stringify(data) }),
  cascade: (data: any) => apiFetch('/api/compute/cascade', { method: 'POST', body: JSON.stringify(data) }),
  ordinaryTax: (data: any) => apiFetch('/api/compute/ordinary-tax', { method: 'POST', body: JSON.stringify(data) }),
  qbi: (data: any) => apiFetch('/api/compute/qbi', { method: 'POST', body: JSON.stringify(data) }),
  niit: (data: any) => apiFetch('/api/compute/niit', { method: 'POST', body: JSON.stringify(data) }),
}

// Forms + field maps
export const forms = {
  list: () => apiFetch('/api/forms'),
  fieldMap: (form: string, year: number) => apiFetch(`/api/field-map/${form}/${year}`),
  taxTables: (year: number) => apiFetch(`/api/tax-tables/${year}`),
}

// PDF operations
export const pdf = {
  fill: (form: string, year: number, data: Record<string, any>) =>
    apiFetch(`/api/fill/${form}/${year}`, { method: 'POST', body: JSON.stringify({ data }) }),
  label: (form: string, year: number) =>
    apiFetch(`/api/label/${form}/${year}`, { method: 'POST' }),
  verify: (pdfPath: string, expected: Record<string, number>) =>
    apiFetch('/api/verify', { method: 'POST', body: JSON.stringify({ pdfPath, expected }) }),
}

// Auth + API keys
export const auth = {
  me: () => apiFetch('/auth/me'),
  createKey: (name: string) => apiFetch('/auth/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeKey: (id: string) => apiFetch(`/auth/api-keys/${id}`, { method: 'DELETE' }),
}

// Scenarios
export const scenarios = {
  list: () => apiFetch('/api/scenarios'),
  create: (data: any) => apiFetch('/api/scenarios', { method: 'POST', body: JSON.stringify(data) }),
  compute: (id: string) => apiFetch(`/api/scenarios/${id}/compute`, { method: 'POST' }),
  analyze: (id: string) => apiFetch(`/api/scenarios/${id}/analyze`, { method: 'POST' }),
  compare: (ids: string[]) => apiFetch('/api/scenarios/compare', { method: 'POST', body: JSON.stringify({ scenario_ids: ids }) }),
}
