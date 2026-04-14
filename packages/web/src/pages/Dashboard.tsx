import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, FileText, FlaskConical, Link2, Clock, ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

interface Entity {
  id: string; name: string; form_type: string; ein: string
  returns?: Array<{ id: string; tax_year: number; form_type: string; status: string; source?: string }>
}
interface Return {
  id: string; tax_year: number; form_type: string; status: string; source: string
  computed_at: string; tax_entity?: { name: string; form_type: string }
}
interface Scenario {
  id: string; name: string; tax_year: number; status: string
  computed_result?: any; tax_entity?: { name: string; form_type: string }
  created_at: string
}

const FORM_LABEL: Record<string, string> = { '1040': 'Individual', '1120': 'C-Corp', '1120S': 'S-Corp' }

export default function Dashboard() {
  const nav = useNavigate()
  const [entities, setEntities] = useState<Entity[]>([])
  const [returns, setReturns] = useState<Return[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api<{ entities: Entity[] }>('/api/entities').catch(() => ({ entities: [] })),
      api<{ returns: Return[] }>('/api/returns').catch(() => ({ returns: [] })),
      api<{ scenarios: Scenario[] }>('/api/scenarios').catch(() => ({ scenarios: [] })),
    ]).then(([e, r, s]) => {
      setEntities(e.entities)
      setReturns(r.returns)
      setScenarios(s.scenarios)
    }).finally(() => setLoading(false))
  }, [])

  const filed = returns.filter(r => r.source === 'filed')
  const proforma = returns.filter(r => r.source === 'proforma')
  const extensions = returns.filter(r => r.source === 'extension')
  const recent = [...returns].sort((a, b) => new Date(b.computed_at).getTime() - new Date(a.computed_at).getTime()).slice(0, 5)

  if (loading) return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-4 gap-4">{Array.from({length:4}).map((_,i) => <Skeleton key={i} className="h-24" />)}</div>
      <Skeleton className="h-64" />
    </div>
  )

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="cursor-pointer hover:border-primary/50 transition" onClick={() => nav('/app/entities')}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Entities</p>
                <p className="text-2xl font-bold">{entities.length}</p>
              </div>
              <Building2 className="w-8 h-8 text-muted-foreground/30" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Filed Returns</p>
                <p className="text-2xl font-bold">{filed.length}</p>
              </div>
              <FileText className="w-8 h-8 text-muted-foreground/30" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Proformas</p>
                <p className="text-2xl font-bold">{proforma.length}</p>
              </div>
              <FileText className="w-8 h-8 text-blue-500/30" />
            </div>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:border-primary/50 transition" onClick={() => nav('/app/scenarios')}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Scenarios</p>
                <p className="text-2xl font-bold">{scenarios.length}</p>
              </div>
              <FlaskConical className="w-8 h-8 text-muted-foreground/30" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Entities */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              Entities
              <Button variant="ghost" size="sm" onClick={() => nav('/app/entities')}>View all <ArrowRight className="w-3 h-3 ml-1" /></Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {entities.map(e => {
              const entityReturns = returns.filter(r => r.tax_entity?.name === e.name)
              const hasQbo = false // TODO: check qbo_connection
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 cursor-pointer transition"
                  onClick={() => nav(`/app/entities/${e.id}`)}
                >
                  <div className="flex items-center gap-3">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-sm">{e.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {FORM_LABEL[e.form_type] || e.form_type}
                        {e.ein ? ` · ${e.ein}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">{entityReturns.length} returns</Badge>
                    {hasQbo && <Link2 className="w-3 h-3 text-green-500" />}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        {/* Scenarios */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              Scenarios
              <Button variant="ghost" size="sm" onClick={() => nav('/app/scenarios')}>View all <ArrowRight className="w-3 h-3 ml-1" /></Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {scenarios.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No scenarios. Use Claude to create what-if scenarios.</p>
            ) : scenarios.slice(0, 5).map(s => {
              const tax = s.computed_result?.computed?.total_tax
              return (
                <div key={s.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition">
                  <div>
                    <div className="font-medium text-sm">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.tax_entity?.name || ''} · {s.tax_year}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={s.status === 'computed' ? 'default' : 'secondary'} className="text-xs">{s.status}</Badge>
                    {tax !== undefined && <span className="text-xs font-mono text-muted-foreground">${tax.toLocaleString()}</span>}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent Returns</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {recent.map(r => (
              <div key={r.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition">
                <div className="flex items-center gap-3">
                  {r.source === 'extension' ? <Clock className="w-4 h-4 text-muted-foreground" /> : <FileText className="w-4 h-4 text-muted-foreground" />}
                  <div>
                    <div className="text-sm font-medium">
                      {r.tax_entity?.name || 'Unknown'}
                      <Badge variant="outline" className="ml-2 text-xs">{r.form_type}</Badge>
                      <Badge variant="secondary" className="ml-1 text-xs">{r.tax_year}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.source} · {new Date(r.computed_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Extensions */}
      {extensions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Extensions Filed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {extensions.map(r => (
                <div key={r.id} className="flex items-center justify-between py-2 px-3">
                  <div className="flex items-center gap-3">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{r.tax_entity?.name}</span>
                      <Badge variant="outline" className="ml-2 text-xs">{r.form_type}</Badge>
                      <Badge variant="secondary" className="ml-1 text-xs">{r.tax_year}</Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
