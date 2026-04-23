import { useMemo, useState } from 'react'
import { Calculator, Loader2, Link2, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useSchema } from '@/hooks/use-schema'
import { useEntities } from '@/hooks/use-entities'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

interface ComputeResult {
  computed?: Record<string, number>
  result?: { computed?: Record<string, number> }
  qbo_warnings?: Array<{ code: string; message: string; fix_hint?: string }>
  supporting_documents?: {
    auto_merged?: Array<{ field: string; value: number; sources?: string[] }>
  }
  missing_fields?: {
    count?: number
    fields?: Array<{ field: string; description?: string; severity?: string; category?: string; note?: string }>
  }
  qbo_mapper?: {
    audit?: Array<{ tax_field: string; qbo_source?: string; amount: number; confidence: string }>
    warnings?: Array<{ code: string; message: string; fix_hint?: string }>
    sources?: Array<string>
  }
}

export default function Compute() {
  const [formType, setFormType] = useState('1120')
  const [taxYear, setTaxYear] = useState(2024)
  const [entityId, setEntityId] = useState<string>('')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ComputeResult | null>(null)
  const [computing, setComputing] = useState<'manual' | 'qbo' | null>(null)
  const { schema, loading: schemaLoading } = useSchema(formType, taxYear)
  const { entities } = useEntities()

  const compatibleEntities = useMemo(
    () => entities.filter(e => {
      const ef = (e.form_type || '').toLowerCase()
      return ef === formType.toLowerCase() || (formType === '1120s' && ef === '1120s')
    }),
    [entities, formType],
  )

  const handleCompute = async () => {
    setComputing('manual')
    setResult(null)
    try {
      const numericInputs: Record<string, unknown> = { tax_year: taxYear }
      for (const [k, v] of Object.entries(inputs)) {
        const num = Number(v)
        numericInputs[k] = isNaN(num) ? v : num
      }
      // If entity is selected, hit compute_return (saves). Otherwise hit raw engine.
      const path = entityId ? '/api/returns/compute' : `/api/compute/${formType}`
      const body = entityId
        ? { entity_id: entityId, form_type: formType, tax_year: taxYear, inputs: numericInputs }
        : numericInputs
      const data = await api<ComputeResult>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setResult(data)
      toast.success('Computed successfully')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Computation failed')
    }
    setComputing(null)
  }

  const handleComputeFromQbo = async () => {
    if (!entityId) return
    setComputing('qbo')
    setResult(null)
    try {
      const numericInputs: Record<string, unknown> = { tax_year: taxYear }
      for (const [k, v] of Object.entries(inputs)) {
        const num = Number(v)
        if (!isNaN(num) && v !== '') numericInputs[k] = num
      }
      const data = await api<ComputeResult>('/api/returns/compute_from_qbo', {
        method: 'POST',
        body: JSON.stringify({
          entity_id: entityId,
          form_type: formType,
          tax_year: taxYear,
          overrides: numericInputs,
        }),
      })
      setResult(data)
      const warns = data.qbo_mapper?.warnings?.length || 0
      toast.success(`Computed from QBO${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'QBO compute failed')
    }
    setComputing(null)
  }

  const updateInput = (key: string, value: string) => {
    setInputs(prev => ({ ...prev, [key]: value }))
  }

  const sections = schema?.fields?.reduce((acc, field) => {
    const section = field.section || 'General'
    if (!acc[section]) acc[section] = []
    acc[section].push(field)
    return acc
  }, {} as Record<string, typeof schema.fields>) || {}

  const computed = result?.result?.computed || result?.computed
  const warnings = result?.qbo_mapper?.warnings || result?.qbo_warnings || []
  const autoMerged = result?.supporting_documents?.auto_merged || result?.qbo_mapper?.audit?.map(a => ({ field: a.tax_field, value: a.amount, sources: [a.qbo_source || a.confidence] })) || []
  const missing = result?.missing_fields?.fields || []
  const criticalMissing = missing.filter(f => f.severity === 'critical')

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Quick Compute</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run a tax computation. Select an entity with QBO to use one-shot compute-from-QBO.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Input panel */}
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Form Type</Label>
              <Select value={formType} onValueChange={v => { if (v) { setFormType(v); setInputs({}); setResult(null) } }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1040">1040 (Individual)</SelectItem>
                  <SelectItem value="1120">1120 (C-Corp)</SelectItem>
                  <SelectItem value="1120S">1120-S (S-Corp)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tax Year</Label>
              <Select value={String(taxYear)} onValueChange={v => { setTaxYear(Number(v)); setResult(null) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Entity (optional — enables save + QBO)</Label>
            <Select value={entityId || '__none__'} onValueChange={v => setEntityId(!v || v === '__none__' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="No entity (standalone compute)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No entity (standalone)</SelectItem>
                {compatibleEntities.map(e => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name} — {e.form_type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {schemaLoading ? (
            <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : schema?.fields ? (
            Object.entries(sections).map(([section, fields]) => (
              <Card key={section}>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">{section}</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-0">
                  {fields.map(field => (
                    <div key={field.key} className="space-y-1">
                      <Label className="text-xs">{field.label || field.key.replace(/_/g, ' ')}</Label>
                      <Input
                        type={field.type === 'number' ? 'number' : 'text'}
                        placeholder={field.default !== undefined ? String(field.default) : '0'}
                        value={inputs[field.key] || ''}
                        onChange={e => updateInput(field.key, e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                No schema available. Fields will use engine defaults.
              </CardContent>
            </Card>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            {entityId && formType !== '1040' && (
              <Button
                onClick={handleComputeFromQbo}
                disabled={computing !== null}
                className="flex-1 gap-2"
                variant="default"
              >
                {computing === 'qbo' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                {computing === 'qbo' ? 'Pulling from QBO…' : 'Compute from QBO'}
              </Button>
            )}
            <Button
              onClick={handleCompute}
              disabled={computing !== null}
              className="flex-1 gap-2"
              variant={entityId && formType !== '1040' ? 'outline' : 'default'}
            >
              {computing === 'manual' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
              {computing === 'manual' ? 'Computing…' : entityId ? 'Compute (manual)' : 'Compute'}
            </Button>
          </div>
          {entityId && formType !== '1040' && (
            <p className="text-xs text-muted-foreground">
              <Sparkles className="h-3 w-3 inline mr-1" />
              QBO one-shot auto-maps P&L and balance sheet. Fill fields above only to override specific lines.
            </p>
          )}
        </div>

        {/* Result panel */}
        <div className="space-y-4">
          {/* Warnings */}
          {warnings.length > 0 && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-400" />
                  {warnings.length} QBO warning{warnings.length === 1 ? '' : 's'}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {warnings.map((w, i) => (
                  <div key={i} className="text-xs">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Badge variant="outline" className="text-xs">{w.code}</Badge>
                      <span className="font-medium">{w.message}</span>
                    </div>
                    {w.fix_hint && (
                      <p className="text-muted-foreground ml-1">{w.fix_hint}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Auto-merged fields */}
          {autoMerged.length > 0 && (
            <Card className="border-blue-500/30 bg-blue-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-blue-400" />
                  Auto-merged from QBO / documents ({autoMerged.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-1 gap-1 max-h-40 overflow-y-auto">
                  {autoMerged.slice(0, 20).map((m, i) => (
                    <div key={i} className="text-xs flex items-center justify-between py-0.5">
                      <code className="text-xs text-muted-foreground">{m.field}</code>
                      <span className="font-mono">{fmt(m.value)}</span>
                    </div>
                  ))}
                  {autoMerged.length > 20 && (
                    <p className="text-xs text-muted-foreground italic mt-1">+{autoMerged.length - 20} more</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Missing fields */}
          {criticalMissing.length > 0 && (
            <Card className="border-red-500/30 bg-red-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-400" />
                  {criticalMissing.length} critical field{criticalMissing.length === 1 ? '' : 's'} missing
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-1">
                {criticalMissing.slice(0, 10).map((f, i) => (
                  <div key={i} className="text-xs">
                    <code className="text-xs">{f.field}</code>
                    {f.description && <span className="text-muted-foreground"> — {f.description}</span>}
                  </div>
                ))}
                {criticalMissing.length > 10 && (
                  <p className="text-xs text-muted-foreground italic">+{criticalMissing.length - 10} more</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Computed totals */}
          {computed ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Results</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {Object.entries(computed as Record<string, unknown>)
                    .filter(([, v]) => typeof v === 'number')
                    .map(([k, v]) => (
                      <div
                        key={k}
                        className={`flex justify-between py-1.5 px-2 rounded text-sm ${
                          k.includes('tax') || k.includes('total') || k.includes('income')
                            ? 'bg-muted font-medium'
                            : ''
                        }`}
                      >
                        <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono">{fmt(v)}</span>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Calculator className="h-10 w-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {entityId && formType !== '1040'
                    ? 'Click Compute from QBO to auto-pull and calculate.'
                    : 'Fill in the form fields and click Compute to see results.'}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
