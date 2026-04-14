import { useState, useEffect } from 'react'
import { FileText, Download, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'

interface Return {
  id: string
  tax_year: number
  form_type: string
  status: string
  source: string
  scenario_id?: string
  computed_at: string
  pdf_s3_path?: string
  tax_entity?: { name: string; form_type: string; ein: string }
}

export default function Returns() {
  const [returns, setReturns] = useState<Return[]>([])
  const [loading, setLoading] = useState(true)
  const [generatingPdf, setGeneratingPdf] = useState<string | null>(null)

  useEffect(() => {
    api<{ returns: Return[] }>('/api/returns')
      .then(d => setReturns(d.returns || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filed = returns.filter(r => r.source === 'filed')
  const proforma = returns.filter(r => r.source === 'proforma')
  const extensions = returns.filter(r => r.source === 'extension')

  async function getPdf(id: string) {
    setGeneratingPdf(id)
    try {
      const data = await api<{ url: string }>(`/api/returns/${id}/pdf?regenerate=true`)
      window.open(data.url, '_blank')
    } catch { /* ignore */ }
    setGeneratingPdf(null)
  }

  function ReturnCard({ r }: { r: Return }) {
    return (
      <Card key={r.id}>
        <CardContent className="py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <div>
              <div className="font-medium">
                {r.tax_entity?.name || 'Unknown Entity'}
                <Badge variant="outline" className="ml-2 text-xs">{r.form_type}</Badge>
                <Badge variant="secondary" className="ml-1 text-xs">{r.tax_year}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {r.source} · {r.status} · {new Date(r.computed_at).toLocaleDateString()}
              </div>
            </div>
          </div>
          <Button
            variant="ghost" size="sm"
            onClick={() => getPdf(r.id)}
            disabled={generatingPdf === r.id}
          >
            {generatingPdf === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (loading) return <div className="space-y-3">{Array.from({length:5}).map((_,i) => <Skeleton key={i} className="h-16" />)}</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Returns</h1>
        <p className="text-muted-foreground text-sm">All tax returns across entities</p>
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All ({returns.length})</TabsTrigger>
          <TabsTrigger value="filed">Filed ({filed.length})</TabsTrigger>
          <TabsTrigger value="proforma">Proforma ({proforma.length})</TabsTrigger>
          <TabsTrigger value="extension">Extensions ({extensions.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-2 mt-4">
          {returns.map(r => <ReturnCard key={r.id} r={r} />)}
        </TabsContent>
        <TabsContent value="filed" className="space-y-2 mt-4">
          {filed.length === 0 ? <p className="text-muted-foreground text-sm">No filed returns. Upload prior returns to get started.</p> : filed.map(r => <ReturnCard key={r.id} r={r} />)}
        </TabsContent>
        <TabsContent value="proforma" className="space-y-2 mt-4">
          {proforma.length === 0 ? <p className="text-muted-foreground text-sm">No proforma returns. Use Compute or Scenarios to create one.</p> : proforma.map(r => <ReturnCard key={r.id} r={r} />)}
        </TabsContent>
        <TabsContent value="extension" className="space-y-2 mt-4">
          {extensions.length === 0 ? <p className="text-muted-foreground text-sm">No extensions filed.</p> : extensions.map(r => <ReturnCard key={r.id} r={r} />)}
        </TabsContent>
      </Tabs>
    </div>
  )
}
