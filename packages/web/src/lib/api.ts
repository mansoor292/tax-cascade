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
    // A non-JSON body means the request never reached the API — it was served
    // by the static host instead (an unproxied path falling through to the SPA
    // fallback). Surfacing a bare "404" for that told a user nothing and sent
    // them hunting for a problem with their input. Say what actually happened.
    const body = await res.text().catch(() => '')
    let message = ''
    try {
      message = JSON.parse(body)?.error || ''
    } catch {
      message = res.status === 404
        ? `Not found: ${opts.method || 'GET'} ${path}. The request did not reach the API — this is a configuration problem on our side, not something you did.`
        : `Unexpected ${res.status} response from ${path}.`
    }
    throw new Error(message || `${res.status} ${res.statusText}`.trim())
  }
  return res.json()
}
