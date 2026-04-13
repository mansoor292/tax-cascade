import { supabase } from './supabase'

const BASE = import.meta.env.VITE_API_URL || ''

async function headers() {
  const { data } = await supabase.auth.getSession()
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (data.session?.access_token) h['Authorization'] = `Bearer ${data.session.access_token}`
  return h
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const h = await headers()
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...h, ...(opts.headers as Record<string, string> || {}) } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `${res.status}`)
  }
  return res.json()
}
