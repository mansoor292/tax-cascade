import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/lib/auth'
import Landing from '@/pages/Landing'
import Security from '@/pages/Security'
import OAuthAuthorize from '@/pages/OAuthAuthorize'
import Login from '@/pages/Login'
import Layout from '@/pages/Layout'
import Dashboard from '@/pages/Dashboard'
import Calendar from './pages/Calendar'
import Group from '@/pages/Group'
import Entities from '@/pages/Entities'
import EntityDetail from '@/pages/EntityDetail'
import Scenarios from '@/pages/Scenarios'
import Compute from '@/pages/Compute'
import CompareEntity from '@/pages/Compare'
import ConnectClaude from '@/pages/ConnectClaude'
import Cascade from '@/pages/Cascade'
import Extensions from '@/pages/Extensions'
import TaxTables from '@/pages/TaxTables'
import Settings from '@/pages/Settings'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import PracticeLayout from '@/pages/practice/PracticeLayout'
import PracticeClients from '@/pages/practice/Clients'
import PracticeClient from '@/pages/practice/Client'
import PracticeOpportunities from '@/pages/practice/Opportunities'
import PracticeDeadlines from '@/pages/practice/Deadlines'
import PracticeIrsAccess from '@/pages/practice/IrsAccess'
import PracticeSettings from '@/pages/practice/PracticeSettings'
import PracticeFilingDesk from '@/pages/practice/FilingDesk'
import PracticeImports from '@/pages/practice/Imports'
import Sign from '@/pages/Sign'

/**
 * Signed out, a link into the app goes to sign-in and comes back to itself.
 * It used to go to the landing page and, after sign-in, to the Dashboard — a
 * link Claude gave, or one a reviewer was sent, was lost (UI audit,
 * 2026-10-22).
 */
function Guard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <>{children}</>
}

function Home() {
  const { session, loading } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>
  if (session) return <Navigate to="/app" />
  return <Landing />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/security" element={<Security />} />
          <Route path="/oauth/authorize" element={<OAuthAuthorize />} />
          <Route path="/login" element={<Login />} />
          {/* The 8821 signature link a preparer sends a client: no login. */}
          <Route path="/sign/:token" element={<Sign />} />
          <Route path="/app" element={<Guard><Layout /></Guard>}>
            <Route index element={<Dashboard />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="group" element={<Group />} />
            <Route path="scenarios" element={<Scenarios />} />
            <Route path="entities" element={<Entities />} />
            <Route path="entities/:id" element={<EntityDetail />} />
            <Route path="compare/:entityId" element={<CompareEntity />} />
            <Route path="connect-claude" element={<ConnectClaude />} />
            <Route path="compute" element={<Compute />} />
            <Route path="cascade" element={<Cascade />} />
            <Route path="extensions" element={<Extensions />} />
            <Route path="tax-tables" element={<TaxTables />} />
            <Route path="settings" element={<Settings />} />
            {/* The practice workspace (2026-10-24): one preparer, many clients. */}
            <Route path="practice" element={<PracticeLayout />}>
              <Route index element={<PracticeClients />} />
              <Route path="clients/:id" element={<PracticeClient />} />
              <Route path="opportunities" element={<PracticeOpportunities />} />
              <Route path="deadlines" element={<PracticeDeadlines />} />
              <Route path="irs-access" element={<PracticeIrsAccess />} />
              <Route path="settings" element={<PracticeSettings />} />
              <Route path="filing" element={<PracticeFilingDesk />} />
              <Route path="imports" element={<PracticeImports />} />
            </Route>
          </Route>
          {/* Legacy route redirects */}
          <Route path="/compute" element={<Navigate to="/app/compute" />} />
          <Route path="/returns" element={<Navigate to="/app" />} />
          <Route path="/documents" element={<Navigate to="/app" />} />
          <Route path="/scenarios" element={<Navigate to="/app/scenarios" />} />
          <Route path="/keys" element={<Navigate to="/app/settings" />} />
        </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </AuthProvider>
  )
}
