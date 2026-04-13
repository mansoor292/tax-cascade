import { useAuth } from '../lib/auth'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Calculator, FileText, FlaskConical, Key, LogOut, Upload } from 'lucide-react'

const links = [
  { to: '/compute', label: 'Compute', icon: Calculator },
  { to: '/documents', label: 'Documents', icon: Upload },
  { to: '/returns', label: 'Returns', icon: FileText },
  { to: '/scenarios', label: 'Scenarios', icon: FlaskConical },
  { to: '/keys', label: 'API Keys', icon: Key },
]

export default function Layout() {
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      <header className="border-b border-zinc-800 px-5 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="text-white font-semibold">Tax Engine</span>
          <nav className="flex gap-1">{links.map(l => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
              <l.icon size={15} />{l.label}
            </NavLink>
          ))}</nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-500">{user?.email}</span>
          <button onClick={() => { signOut(); nav('/login') }} className="text-zinc-600 hover:text-zinc-300"><LogOut size={15} /></button>
        </div>
      </header>
      <main className="max-w-5xl mx-auto p-5"><Outlet /></main>
    </div>
  )
}
