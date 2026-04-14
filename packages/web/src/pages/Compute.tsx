import { useState } from 'react'
import { Calculator, Loader2 } from 'lucide-react'
import { useSchema } from '@/hooks/use-schema'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

export default function Compute() {
  const [formType, setFormType] = useState('1120')
  const [taxYear, setTaxYear] = useState(2024)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [computing, setComputing] = useState(false)
  const { schema, loading: schemaLoading } = useSchema(formType, taxYear)

  const handleCompute = async () => {
    setComputing(true)
    setResult(null)
    try {
      const numericInputs: Record<string, unknown> = { tax_year: taxYear }
      for (const [k, v] of Object.entries(inputs)) {
        const num = Number(v)
        numericInputs[k] = isNaN(num) ? v : num
      }
      const data = await api(`/api/compute/${formType}`, {
        method: 'POST',
        body: JSON.stringify(numericInputs),
      })
      setResult(data)
      toast.success('Computed successfully')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Computation failed')
    }
    setComputing(false)
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

  const computed = (result as any)?.result?.computed || result

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Quick Compute</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run a standalone tax computation without saving to an entity.
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
                  <SelectItem value="1120s">1120-S (S-Corp)</SelectItem>
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

          <Button onClick={handleCompute} disabled={computing} className="w-full gap-2">
            {computing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
            {computing ? 'Computing...' : 'Compute'}
          </Button>
        </div>

        {/* Result panel */}
        <div>
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
                  Fill in the form fields and click Compute to see results.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
