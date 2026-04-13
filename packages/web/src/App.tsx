import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import Login from './pages/Login'
import Layout from './pages/Layout'
import Compute from './pages/Compute'
import Returns from './pages/Returns'
import Scenarios from './pages/Scenarios'
import Keys from './pages/Keys'
import Documents from './pages/Documents'

function Guard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-600">Loading...</div>
  if (!session) return <Navigate to="/login" />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Guard><Layout /></Guard>}>
            <Route index element={<Navigate to="/compute" />} />
            <Route path="compute" element={<Compute />} />
            <Route path="returns" element={<Returns />} />
            <Route path="documents" element={<Documents />} />
            <Route path="scenarios" element={<Scenarios />} />
            <Route path="keys" element={<Keys />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
