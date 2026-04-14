import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import Landing from './pages/Landing'
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
  if (!session) return <Navigate to="/" />
  return <>{children}</>
}

function Home() {
  const { session, loading } = useAuth()
  if (loading) return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-600">Loading...</div>
  if (session) return <Navigate to="/compute" />
  return <Landing />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/app" element={<Guard><Layout /></Guard>}>
            <Route index element={<Navigate to="/app/compute" />} />
            <Route path="compute" element={<Compute />} />
            <Route path="returns" element={<Returns />} />
            <Route path="documents" element={<Documents />} />
            <Route path="scenarios" element={<Scenarios />} />
            <Route path="keys" element={<Keys />} />
          </Route>
          {/* Legacy routes redirect to /app */}
          <Route path="/compute" element={<Navigate to="/app/compute" />} />
          <Route path="/returns" element={<Navigate to="/app/returns" />} />
          <Route path="/documents" element={<Navigate to="/app/documents" />} />
          <Route path="/scenarios" element={<Navigate to="/app/scenarios" />} />
          <Route path="/keys" element={<Navigate to="/app/keys" />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
