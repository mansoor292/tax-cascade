import { useAuth } from '../lib/auth'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Calculator, FileText, Key, FlaskConical, LogOut } from 'lucide-react'

const nav = [
  { to: '/compute', label: 'Compute', icon: Calculator },
  { to: '/returns', label: 'Returns', icon: FileText },
  { to: '/scenarios', label: 'Scenarios', icon: FlaskConical },
  { to: '/settings', label: 'API Keys', icon: Key },
]

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <h1 className="text-lg font-semibold text-white">Tax Engine</h1>
          <nav className="flex gap-1">
            {nav.map(n => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                <n.icon size={16} />
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-500">{user?.email}</span>
          <button onClick={handleSignOut} className="text-zinc-500 hover:text-zinc-300"><LogOut size={16} /></button>
        </div>
      </header>
      <main className="max-w-5xl mx-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}
