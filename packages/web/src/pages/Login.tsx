import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const { signIn, signUp } = useAuth()
  const nav = useNavigate()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true)
    const err = mode === 'in' ? await signIn(email, password) : await signUp(email, password, { full_name: name })
    setBusy(false)
    if (err) setError(err); else nav('/')
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white mb-1">Tax Engine</h1>
        <p className="text-zinc-500 mb-6 text-sm">Compute, fill, and verify IRS returns</p>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="flex gap-4 mb-5 border-b border-zinc-800 pb-3">
            {(['in', 'up'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`text-sm font-medium pb-1 border-b-2 ${mode === m ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-500'}`}>
                {m === 'in' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-3">
            {mode === 'up' && <input value={name} onChange={e => setName(e.target.value)} placeholder="Full Name"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500" />}
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500" />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button type="submit" disabled={busy}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium disabled:opacity-50">
              {busy ? '...' : mode === 'in' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
