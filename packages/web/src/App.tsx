import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/lib/auth'
import Landing from '@/pages/Landing'
import Login from '@/pages/Login'
import Layout from '@/pages/Layout'
import Entities from '@/pages/Entities'
import EntityDetail from '@/pages/EntityDetail'
import Returns from '@/pages/Returns'
import Scenarios from '@/pages/Scenarios'
import Compute from '@/pages/Compute'
import Cascade from '@/pages/Cascade'
import Extensions from '@/pages/Extensions'
import TaxTables from '@/pages/TaxTables'
import Settings from '@/pages/Settings'

function Guard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>
  if (!session) return <Navigate to="/" />
  return <>{children}</>
}

function Home() {
  const { session, loading } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>
  if (session) return <Navigate to="/app/returns" />
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
            <Route index element={<Navigate to="/app/returns" />} />
            <Route path="returns" element={<Returns />} />
            <Route path="scenarios" element={<Scenarios />} />
            <Route path="entities" element={<Entities />} />
            <Route path="entities/:id" element={<EntityDetail />} />
            <Route path="compute" element={<Compute />} />
            <Route path="cascade" element={<Cascade />} />
            <Route path="extensions" element={<Extensions />} />
            <Route path="tax-tables" element={<TaxTables />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          {/* Legacy route redirects */}
          <Route path="/compute" element={<Navigate to="/app/compute" />} />
          <Route path="/returns" element={<Navigate to="/app/entities" />} />
          <Route path="/documents" element={<Navigate to="/app/entities" />} />
          <Route path="/scenarios" element={<Navigate to="/app/entities" />} />
          <Route path="/keys" element={<Navigate to="/app/settings" />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
