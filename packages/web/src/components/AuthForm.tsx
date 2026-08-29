/**
 * The one sign-in / sign-up form. Login and the OAuth consent screen used
 * to carry independent copies — the OAuth one bypassed useAuth() and called
 * supabase directly, so anything added to the auth context never reached
 * it. Both now render this and go through useAuth.
 *
 * Tab labels ("Sign In" / "Sign Up") are e2e-visible — signup.spec drives
 * them by text. Don't rename without updating the specs.
 */
import { useState } from 'react'
import { useAuth } from '@/lib/auth'

interface Props {
  /** Called after a successful sign-in/up. Login navigates; the OAuth
   *  consent page does nothing (onAuthStateChange re-renders it). */
  onSuccess?: () => void
  nameRequired?: boolean
  /** Tailwind accent color stem, e.g. 'indigo' | 'blue'. */
  accent?: 'indigo' | 'blue'
}

export default function AuthForm({ onSuccess, nameRequired = false, accent = 'indigo' }: Props) {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const border = accent === 'blue' ? 'focus:border-blue-500' : 'focus:border-indigo-500'
  const tabBorder = accent === 'blue' ? 'border-blue-500' : 'border-indigo-500'
  const button = accent === 'blue' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-indigo-600 hover:bg-indigo-500'
  const inputCls = `w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none ${border}`

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true)
    const err = mode === 'in'
      ? await signIn(email, password)
      : await signUp(email, password, { full_name: name })
    setBusy(false)
    if (err) setError(err)
    else onSuccess?.()
  }

  return (
    <>
      <div className="flex gap-4 mb-5 border-b border-zinc-800 pb-3">
        {(['in', 'up'] as const).map(m => (
          <button key={m} type="button" onClick={() => { setMode(m); setError('') }}
            className={`text-sm font-medium pb-1 border-b-2 ${mode === m ? `${tabBorder} text-white` : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
            {m === 'in' ? 'Sign In' : 'Sign Up'}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'up' && (
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Full Name"
            required={nameRequired} autoComplete="name" className={inputCls} />
        )}
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="Email" required autoComplete="email" className={inputCls} />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="Password" required
          autoComplete={mode === 'in' ? 'current-password' : 'new-password'} className={inputCls} />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button type="submit" disabled={busy}
          className={`w-full py-2 ${button} text-white rounded text-sm font-medium disabled:opacity-50`}>
          {busy ? '…' : mode === 'in' ? 'Sign In' : 'Create Account'}
        </button>
      </form>
    </>
  )
}
