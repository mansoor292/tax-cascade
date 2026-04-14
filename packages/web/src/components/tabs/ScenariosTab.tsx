import { useState } from 'react'
import {
  Plus,
  Play,
  Sparkles,
  ArrowUpRight,
  FileDown,
  Loader2,
  FlaskConical,
  ArrowUpIcon,
  ArrowDownIcon,
} from 'lucide-react'
import { type Entity } from '@/hooks/use-entities'
import { useScenarios, type Scenario } from '@/hooks/use-scenarios'
import { useReturns } from '@/hooks/use-returns'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

interface Props {
  entityId: string
  entity: Entity
  onUpdate: () => void
}

export default function ScenariosTab({ entityId, entity: _entity, onUpdate }: Props) {
  const { scenarios, loading, create, compute, analyze, promote, getPdf } = useScenarios(entityId)
  const { returns } = useReturns(entityId)
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [taxYear, setTaxYear] = useState(2024)
  const [baseReturnId, setBaseReturnId] = useState('')
  const [adjJson, setAdjJson] = useState('{\n  \n}')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const handleCreate = async () => {
    setCreating(true)
    try {
      const adj = JSON.parse(adjJson)
      const scenario = await create({
        entity_id: entityId,
        name,
        description: description || undefined,
        tax_year: taxYear,
        adjustments: adj,
        base_return_id: baseReturnId || undefined,
      })
      if (scenario?.id) {
        await compute(scenario.id)
      }
      toast.success('Scenario created and computed')
      setShowNew(false)
      setName('')
      setDescription('')
      setAdjJson('{\n  \n}')
      onUpdate()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create scenario')
    }
    setCreating(false)
  }

  const handleAction = async (id: string, action: 'compute' | 'analyze' | 'promote' | 'pdf') => {
    setBusy(id)
    try {
      switch (action) {
        case 'compute': await compute(id); toast.success('Scenario computed'); break
        case 'analyze': await analyze(id); toast.success('AI analysis complete'); break
        case 'promote': await promote(id); toast.success('Scenario promoted to return'); onUpdate(); break
        case 'pdf': {
          const data = await getPdf(id)
          if (data.pdf_url) window.open(data.pdf_url, '_blank')
          break
        }
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : `Failed to ${action}`)
    }
    setBusy(null)
  }

  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Scenarios</h3>
        <Button onClick={() => setShowNew(true)} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          New Scenario
        </Button>
      </div>

      {scenarios.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <FlaskConical className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">No what-if scenarios yet.</p>
            <Button onClick={() => setShowNew(true)} size="sm" variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Create Scenario
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {scenarios.map((s: Scenario) => {
            const computed = s.computed_result as Record<string, unknown> | undefined
            const diff = s.diff as Record<string, { base?: number; scenario?: number; delta?: number }> | undefined
            const isExpanded = expandedId === s.id

            return (
              <Card key={s.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div
                      className="flex items-center gap-2 cursor-pointer flex-1"
                      onClick={() => setExpandedId(isExpanded ? null : s.id)}
                    >
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="outline">{s.tax_year}</Badge>
                      <Badge variant={s.status === 'computed' ? 'default' : 'secondary'}>
                        {s.status}
                      </Badge>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAction(s.id, 'compute')}
                        disabled={busy === s.id}
                        className="gap-1 text-xs"
                      >
                        {busy === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        Run
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAction(s.id, 'analyze')}
                        disabled={busy === s.id}
                        className="gap-1 text-xs"
                      >
                        <Sparkles className="h-3 w-3" />
                        AI
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAction(s.id, 'pdf')}
                        disabled={busy === s.id}
                        className="gap-1 text-xs"
                      >
                        <FileDown className="h-3 w-3" />
                        PDF
                      </Button>
                      {s.status === 'computed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleAction(s.id, 'promote')}
                          disabled={busy === s.id}
                          className="gap-1 text-xs text-primary"
                        >
                          <ArrowUpRight className="h-3 w-3" />
                          Promote
                        </Button>
                      )}
                    </div>
                  </div>

                  {s.description && (
                    <p className="text-xs text-muted-foreground mb-2">{s.description}</p>
                  )}

                  {/* Diff viewer */}
                  {isExpanded && diff && Object.keys(diff).length > 0 && (
                    <div className="mt-3 border rounded-md overflow-hidden">
                      <div className="bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                        Changes vs. Base Return
                      </div>
                      <div className="divide-y divide-border/50">
                        {Object.entries(diff)
                          .filter(([, v]) => v.delta !== 0 && v.delta !== undefined)
                          .slice(0, 20)
                          .map(([key, v]) => (
                            <div key={key} className="flex items-center justify-between px-3 py-1.5 text-sm">
                              <span className="text-muted-foreground capitalize">{key.replace(/_/g, ' ')}</span>
                              <div className="flex items-center gap-3 font-mono text-xs">
                                <span className="text-muted-foreground">{fmt(v.base)}</span>
                                <span className="text-muted-foreground">&rarr;</span>
                                <span>{fmt(v.scenario)}</span>
                                {v.delta !== undefined && v.delta !== 0 && (
                                  <Badge
                                    variant="outline"
                                    className={v.delta > 0 ? 'text-red-400 border-red-500/20' : 'text-green-400 border-green-500/20'}
                                  >
                                    {v.delta > 0 ? <ArrowUpIcon className="h-3 w-3 mr-0.5" /> : <ArrowDownIcon className="h-3 w-3 mr-0.5" />}
                                    {fmt(v.delta)}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Computed result summary */}
                  {isExpanded && computed && !diff && (
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-sm">
                      {Object.entries(computed)
                        .filter(([, v]) => typeof v === 'number')
                        .slice(0, 12)
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between py-0.5">
                            <span className="text-muted-foreground text-xs capitalize">{k.replace(/_/g, ' ')}</span>
                            <span className="font-mono text-xs">{fmt(v)}</span>
                          </div>
                        ))}
                    </div>
                  )}

                  {/* AI Analysis */}
                  {isExpanded && s.ai_analysis && (
                    <div className="mt-3 p-3 bg-primary/5 border border-primary/10 rounded-md">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                        <span className="text-xs font-medium">AI Analysis</span>
                      </div>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                        {s.ai_analysis}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* New Scenario dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="w-[95vw] max-w-lg">
          <DialogHeader>
            <DialogTitle>New Scenario</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Higher Revenue Scenario" autoFocus />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What are you testing?" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Tax Year</Label>
                <Select value={String(taxYear)} onValueChange={v => setTaxYear(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[2025, 2024, 2023, 2022].map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Base Return</Label>
                <Select value={baseReturnId} onValueChange={(v) => v && setBaseReturnId(v)}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {returns.map((r: any) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.form_type} — {r.tax_year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Adjustments (JSON)</Label>
              <Textarea
                value={adjJson}
                onChange={e => setAdjJson(e.target.value)}
                rows={6}
                className="font-mono text-sm"
                placeholder='{ "gross_receipts": 1500000 }'
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? 'Creating...' : 'Create & Compute'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
