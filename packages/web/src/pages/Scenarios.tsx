import { useState } from 'react'
import { FlaskConical, Loader2, FileText } from 'lucide-react'
import { useScenarios } from '@/hooks/use-scenarios'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export default function Scenarios() {
  const { scenarios, loading, getPdf } = useScenarios()
  const [generatingPdf, setGeneratingPdf] = useState<string | null>(null)

  async function getScenarioPdf(id: string) {
    setGeneratingPdf(id)
    try {
      const data = await getPdf(id)
      if (data.url) window.open(data.url, '_blank')
    } catch { /* ignore */ }
    setGeneratingPdf(null)
  }

  if (loading) return <div className="space-y-3">{Array.from({length:3}).map((_,i) => <Skeleton key={i} className="h-20" />)}</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Scenarios</h1>
        <p className="text-muted-foreground text-sm">What-if tax scenarios across all entities</p>
      </div>

      {scenarios.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <FlaskConical className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No scenarios yet. Use Claude to create what-if scenarios.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {scenarios.map(s => {
            const computed = (s.computed_result?.computed || {}) as Record<string, number | undefined>
            return (
              <Card key={s.id}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <FlaskConical className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium">{s.name}</span>
                        <Badge variant="outline" className="text-xs">{s.tax_year}</Badge>
                        <Badge variant={s.status === 'computed' ? 'default' : 'secondary'} className="text-xs">{s.status}</Badge>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {s.tax_entity?.name || 'Unknown Entity'} · {s.tax_entity?.form_type || ''}
                        {s.base_return_id && <span> · Based on return</span>}
                      </div>
                      {s.description && <p className="text-sm text-muted-foreground mt-1">{s.description}</p>}
                    </div>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => getScenarioPdf(s.id)}
                      disabled={generatingPdf === s.id || s.status !== 'computed'}
                    >
                      {generatingPdf === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                    </Button>
                  </div>
                  {computed.total_tax !== undefined && (
                    <div className="grid grid-cols-4 gap-4 mt-3 text-sm">
                      <div>
                        <div className="text-muted-foreground text-xs">Total Income</div>
                        <div className="font-mono">${(computed.total_income || 0).toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">Taxable Income</div>
                        <div className="font-mono">${(computed.taxable_income || 0).toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">Total Tax</div>
                        <div className="font-mono">${(computed.total_tax || 0).toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">Balance Due</div>
                        <div className="font-mono">${(computed.balance_due || 0).toLocaleString()}</div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
