import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, FileText, FlaskConical, Link2, Clock, ArrowRight, GitBranch, Bot, CalendarClock } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCalendar } from '@/hooks/use-calendar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { CompareReturnsResponse } from '@/hooks/use-returns'
import { maskTaxId } from '@/lib/mask'
import { fmtMoneyCompact as fmtMoney } from '@/lib/format'
import { FORM_TYPE_LABEL, SOURCE_LABEL, SOURCE_VARIANT, type ReturnSource } from '@/lib/labels'

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


function fmtSigned(n: number): string {
  const s = fmtMoney(Math.abs(n))
  return n >= 0 ? `+${s}` : `-${s}`
}

export default function Dashboard() {
  const nav = useNavigate()
  const { data: calendar } = useCalendar()
  const nextDue = calendar?.obligations?.find(o => o.status === 'pending')
  const [entities, setEntities] = useState<Entity[]>([])
  const [returns, setReturns] = useState<Return[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [compareData, setCompareData] = useState<Record<string, CompareReturnsResponse>>({})

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

  // Pull compare_returns for each entity so the amendment Δ card has real numbers.
  useEffect(() => {
    if (entities.length === 0) return
    Promise.all(
      entities.map(e =>
        api<CompareReturnsResponse>(`/api/returns/compare/${e.id}`)
          .then(data => [e.id, data] as const)
          .catch(() => null)
      )
    ).then(results => {
      const map: Record<string, CompareReturnsResponse> = {}
      for (const entry of results) if (entry) map[entry[0]] = entry[1]
      setCompareData(map)
    })
  }, [entities])

  const filed       = returns.filter(r => r.source === 'filed_import')
  const proforma    = returns.filter(r => r.source === 'proforma')
  const amendments  = returns.filter(r => r.source === 'amendment')
  const extensions  = returns.filter(r => r.source === 'extension')
  const recent = [...returns].sort((a, b) => new Date(b.computed_at).getTime() - new Date(a.computed_at).getTime()).slice(0, 5)

  // Amendment refund delta: sum over all entities of (amendment.total_tax - filed.total_tax) per year.
  const refundDelta = (() => {
    let totalDelta = 0
    let years = 0
    for (const cd of Object.values(compareData)) {
      const rows = cd.all_rows || []
      const byYear = new Map<number, { filed?: Return; amend?: Return }>()
      for (const r of rows) {
        if (!byYear.has(r.tax_year)) byYear.set(r.tax_year, {})
        const slot = byYear.get(r.tax_year)!
        if (r.source === 'filed_import' && (!slot.filed || (r.computed_at || '') > (slot.filed.computed_at || ''))) {
          slot.filed = r as Return
        } else if (r.source === 'amendment' && (!slot.amend || (r.computed_at || '') > (slot.amend.computed_at || ''))) {
          slot.amend = r as Return
        }
      }
      for (const { filed, amend } of byYear.values()) {
        if (!filed || !amend) continue
        // Read total_tax from field_values (golden model) per form. 1120 → tax.L31,
        // 1120S → tax.L22, 1040 → tax.L24. Fall back to 0 if absent.
        const totalTaxKey = (r: Return): string =>
          r.form_type === '1120S' ? 'tax.L22_total_tax'
          : r.form_type === '1040' ? 'tax.L24_total_tax'
          : 'tax.L31_total_tax'
        const fv = (r: Return) => ((r as any).field_values || {}) as Record<string, number>
        const filedTax  = fv(filed)[totalTaxKey(filed)]   ?? 0
        const amendTax  = fv(amend)[totalTaxKey(amend)]   ?? 0
        totalDelta += (filedTax - amendTax)      // positive = amendment lowers tax = refund potential
        years += 1
      }
    }
    return { totalDelta, years }
  })()

  if (loading) return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-4 gap-4">{Array.from({length:4}).map((_,i) => <Skeleton key={i} className="h-24" />)}</div>
      <Skeleton className="h-64" />
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {entities.length} {entities.length === 1 ? 'entity' : 'entities'}
            {filed.length > 0 ? ` · ${filed.length} filed` : ''}
            {amendments.length > 0 ? ` · ${amendments.length} ${amendments.length === 1 ? 'amendment' : 'amendments'}` : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => nav('/app/connect-claude')} className="gap-2 shrink-0">
          <Bot className="h-4 w-4" />
          <span className="hidden sm:inline">Connect Claude</span>
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {/* Next deadline — the client-facing "due in N days" line */}
        <Card className="cursor-pointer hover:border-primary/50 transition" onClick={() => nav('/app/calendar')}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">
                  {calendar?.overdue ? 'Overdue' : 'Next deadline'}
                </p>
                {calendar?.overdue ? (
                  <p className="text-2xl font-bold text-red-400">{calendar.overdue}</p>
                ) : nextDue ? (
                  <>
                    <p className={`text-2xl font-bold ${nextDue.days_until <= 30 ? 'text-amber-400' : ''}`}>
                      {nextDue.days_until === 0 ? 'Today' : `${nextDue.days_until}d`}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{nextDue.title}</p>
                  </>
                ) : (
                  <p className="text-2xl font-bold">—</p>
                )}
              </div>
              <CalendarClock className="w-8 h-8 text-muted-foreground/30 shrink-0" />
            </div>
          </CardContent>
        </Card>

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
                <p className="text-xs text-muted-foreground mt-0.5">{proforma.length} proforma · {extensions.length} ext</p>
              </div>
              <FileText className="w-8 h-8 text-emerald-500/30" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">Amendments</p>
                <p className="text-2xl font-bold">{amendments.length}</p>
                {refundDelta.years > 0 && (
                  <p
                    className={`text-xs mt-0.5 font-mono ${refundDelta.totalDelta > 0 ? 'text-emerald-400' : refundDelta.totalDelta < 0 ? 'text-red-400' : 'text-muted-foreground'}`}
                  >
                    {refundDelta.totalDelta !== 0 ? fmtSigned(refundDelta.totalDelta) : '±$0'} over {refundDelta.years}y
                  </p>
                )}
              </div>
              <GitBranch className="w-8 h-8 text-amber-500/30" />
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
              const cd = compareData[e.id]
              const hasAmendments = (cd?.all_rows || []).some(r => r.source === 'amendment')
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
                        {FORM_TYPE_LABEL[e.form_type] || e.form_type}
                        {e.ein ? ` · ${maskTaxId(e.ein)}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">{entityReturns.length} returns</Badge>
                    {hasAmendments && (
                      <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.amendment}`}>amended</Badge>
                    )}
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
                    {tax !== undefined && <span className="text-xs font-mono text-muted-foreground">{fmtMoney(tax)}</span>}
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
                    <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className={`text-xs px-1.5 py-0 ${SOURCE_VARIANT[r.source as ReturnSource] || ''}`}>
                        {SOURCE_LABEL[r.source as ReturnSource] || r.source}
                      </Badge>
                      <span>{new Date(r.computed_at).toLocaleDateString()}</span>
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
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" /> Extensions Filed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {extensions.map(r => (
                <div key={r.id} className="flex items-center justify-between py-2 px-3">
                  <div className="flex items-center gap-3">
                    <Link2 className="w-4 h-4 text-muted-foreground" />
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
