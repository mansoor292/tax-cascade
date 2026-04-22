/**
 * OAuth 2.1 consent screen for MCP clients (primarily Claude.ai).
 *
 * Claude.ai opens this page with PKCE params in the query string:
 *   ?client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256
 *   &state=...&scope=...
 *
 * Flow:
 *   1. Preserve query params across any Supabase login redirect via sessionStorage.
 *   2. If unauthenticated — render inline sign-in/sign-up. On success, Supabase
 *      session materializes and we fall through to the consent view.
 *   3. Consent — show what's being authorized + Approve/Cancel.
 *   4. Approve → POST to oauth-issue-code with session JWT → get signed code.
 *      Top-level navigate back to redirect_uri with ?code=&state=.
 *   5. Cancel → redirect with ?error=access_denied&state=.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Shield, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

interface OAuthParams {
  client_id:             string
  redirect_uri:          string
  code_challenge:        string
  code_challenge_method: string
  state:                 string
  scope:                 string
  response_type:         string
}

const STORAGE_KEY = 'catipult.oauth.pending'

function readParams(): OAuthParams | null {
  const url = new URL(window.location.href)
  const q   = url.searchParams
  const p: OAuthParams = {
    client_id:             q.get('client_id')             || '',
    redirect_uri:          q.get('redirect_uri')          || '',
    code_challenge:        q.get('code_challenge')        || '',
    code_challenge_method: q.get('code_challenge_method') || 'S256',
    state:                 q.get('state')                 || '',
    scope:                 q.get('scope')                 || 'tax-api',
    response_type:         q.get('response_type')         || 'code',
  }
  // Required fields for a valid authorization request.
  if (!p.redirect_uri || !p.code_challenge) {
    // Fall back to sessionStorage in case we got bounced through a login flow.
    const cached = sessionStorage.getItem(STORAGE_KEY)
    if (cached) {
      try { return JSON.parse(cached) as OAuthParams } catch { return null }
    }
    return null
  }
  // Stash for survival across any auth round-trip.
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  return p
}

function buildRedirect(params: OAuthParams, addQuery: Record<string, string>): string {
  const url = new URL(params.redirect_uri)
  for (const [k, v] of Object.entries(addQuery)) url.searchParams.set(k, v)
  if (params.state) url.searchParams.set('state', params.state)
  return url.toString()
}

export default function OAuthAuthorize() {
  const nav = useNavigate()
  const { session, loading } = useAuth()
  const params = useMemo(readParams, [])

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')

  const [approveBusy, setApproveBusy] = useState(false)
  const [approveError, setApproveError] = useState('')

  // If we reached this page without valid params, show a hard error.
  if (!params) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <XCircle className="w-6 h-6 text-red-400 mb-3" />
          <h1 className="text-lg font-semibold mb-2">Invalid authorization request</h1>
          <p className="text-sm text-zinc-500 leading-relaxed">
            This page needs <code className="text-zinc-300">client_id</code>, <code className="text-zinc-300">redirect_uri</code>,
            and <code className="text-zinc-300">code_challenge</code> in the URL. Ask the MCP client that sent
            you here to retry the connection.
          </p>
          <button onClick={() => nav('/')} className="mt-4 text-sm text-blue-400 hover:underline">← Back to home</button>
        </div>
      </div>
    )
  }

  const cancel = () => {
    sessionStorage.removeItem(STORAGE_KEY)
    window.location.assign(buildRedirect(params, { error: 'access_denied', error_description: 'User denied the request' }))
  }

  const signInSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthBusy(true); setAuthError('')
    const { error } = mode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } })
    setAuthBusy(false)
    if (error) setAuthError(error.message)
  }

  const approve = async () => {
    if (!session) { setApproveError('No active session'); return }
    setApproveBusy(true); setApproveError('')
    try {
      const resp = await fetch('/.netlify/functions/oauth-issue-code', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code_challenge:        params.code_challenge,
          code_challenge_method: params.code_challenge_method,
          redirect_uri:          params.redirect_uri,
          state:                 params.state,
          client_id:             params.client_id,
          scope:                 params.scope,
          supabase_jwt:          session.access_token,
        }),
      })
      const data = await resp.json()
      if (!resp.ok || !data.code) {
        throw new Error(data.error_description || data.error || 'Failed to issue authorization code')
      }
      sessionStorage.removeItem(STORAGE_KEY)
      // Top-level navigation; React Router would not send us to an external URL correctly.
      window.location.assign(buildRedirect(params, { code: data.code }))
    } catch (e: unknown) {
      setApproveError(e instanceof Error ? e.message : String(e))
      setApproveBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
      </div>
    )
  }

  const signedIn = Boolean(session)

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-lg">Catipult</span>
          <span className="text-zinc-500 text-sm ml-1">Tax API</span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          {!signedIn ? (
            <>
              <h1 className="text-xl font-bold mb-1">Sign in to authorize</h1>
              <p className="text-sm text-zinc-500 mb-5">Connect Claude to your tax data.</p>
              <div className="flex gap-4 mb-5 border-b border-zinc-800 pb-3 text-sm">
                {(['signin', 'signup'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { setMode(m); setAuthError('') }}
                    className={`pb-1 border-b-2 font-medium ${mode === m ? 'border-blue-500 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                  >
                    {m === 'signin' ? 'Sign In' : 'Create Account'}
                  </button>
                ))}
              </div>
              <form onSubmit={signInSubmit} className="space-y-3">
                {mode === 'signup' && (
                  <input
                    value={fullName} onChange={e => setFullName(e.target.value)}
                    placeholder="Full name" required
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                )}
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email" required autoComplete="email"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password" required
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
                {authError && <p className="text-red-400 text-xs">{authError}</p>}
                <button
                  type="submit" disabled={authBusy}
                  className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium disabled:opacity-50"
                >
                  {authBusy ? '…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <Bot className="w-5 h-5 text-blue-400" />
                <h1 className="text-xl font-bold">Authorize Claude</h1>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed mb-5">
                <span className="text-zinc-200 font-medium">Claude</span> is requesting access to your
                Catipult Tax API data. If you approve, Claude will be able to:
              </p>
              <ul className="space-y-2 text-sm text-zinc-400 mb-5">
                <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" /><span>Read your tax entities, returns, scenarios, and documents.</span></li>
                <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" /><span>Pull QuickBooks data for entities you've connected.</span></li>
                <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" /><span>Compute returns, run scenarios, and generate filled IRS PDFs on your behalf.</span></li>
              </ul>
              <p className="text-xs text-zinc-500 mb-5">
                Signed in as <span className="text-zinc-300">{session?.user.email}</span>. You can revoke access any time from the Catipult dashboard.
              </p>
              {approveError && (
                <div className="bg-red-950/40 border border-red-900 text-red-300 text-xs rounded px-3 py-2 mb-3">
                  {approveError}
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={approve} disabled={approveBusy}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {approveBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {approveBusy ? 'Approving…' : 'Approve'}
                </button>
                <button
                  onClick={cancel} disabled={approveBusy}
                  className="flex-1 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
        <p className="text-xs text-zinc-600 text-center mt-4">
          Protected by OAuth 2.1 with PKCE. <a href="/security" className="text-zinc-500 hover:text-zinc-300">Security details</a>
        </p>
      </div>
    </div>
  )
}
