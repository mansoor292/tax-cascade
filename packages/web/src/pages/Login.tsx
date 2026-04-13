import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const err = mode === 'signin'
      ? await signIn(email, password)
      : await signUp(email, password, { full_name: name, company_name: company })
    setLoading(false)
    if (err) setError(err)
    else navigate('/')
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-white mb-1">Tax Engine</h1>
        <p className="text-zinc-500 mb-8">Compute, fill, and verify IRS returns</p>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex gap-4 mb-6">
            <button onClick={() => setMode('signin')}
              className={`pb-2 text-sm font-medium border-b-2 ${mode === 'signin' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-500'}`}>
              Sign In
            </button>
            <button onClick={() => setMode('signup')}
              className={`pb-2 text-sm font-medium border-b-2 ${mode === 'signup' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-500'}`}>
              Sign Up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'signup' && (
              <>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Full Name"
                  className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm focus:outline-none focus:border-indigo-500" />
                <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Company (optional)"
                  className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm focus:outline-none focus:border-indigo-500" />
              </>
            )}
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required
              className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm focus:outline-none focus:border-indigo-500" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required
              className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm focus:outline-none focus:border-indigo-500" />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm font-medium disabled:opacity-50">
              {loading ? '...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
