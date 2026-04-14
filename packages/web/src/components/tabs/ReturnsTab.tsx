import { useState, useEffect } from 'react'
import { Plus, Download, FileText, BarChart3, Loader2 } from 'lucide-react'
import { type Entity } from '@/hooks/use-entities'
import { useReturns, type TaxReturn } from '@/hooks/use-returns'
import { useSchema } from '@/hooks/use-schema'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

export default function ReturnsTab({ entityId, entity, onUpdate }: Props) {
  const { returns, loading, reload, compute, validate, getPdf } = useReturns(entityId)
  const [showCompute, setShowCompute] = useState(false)
  const [formType, setFormType] = useState(entity.form_type || '1040')
  const [taxYear, setTaxYear] = useState(2024)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [computing, setComputing] = useState(false)
  const [expandedReturn, setExpandedReturn] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const { schema, loading: schemaLoading } = useSchema(showCompute ? formType : undefined, showCompute ? taxYear : undefined)

  const handleCompute = async () => {
    setComputing(true)
    try {
      const numericInputs: Record<string, unknown> = { tax_year: taxYear }
      for (const [k, v] of Object.entries(inputs)) {
        const num = Number(v)
        numericInputs[k] = isNaN(num) ? v : num
      }

      const valResult = await validate({ form_type: formType, tax_year: taxYear, inputs: numericInputs })
      if (valResult.errors && valResult.errors.length > 0) {
        toast.error(valResult.errors.join(', '))
        setComputing(false)
        return
      }
      if (valResult.warnings && valResult.warnings.length > 0) {
        valResult.warnings.forEach(w => toast.warning(w))
      }

      await compute({ entity_id: entityId, tax_year: taxYear, form_type: formType, inputs: numericInputs })
      toast.success('Return computed successfully')
      setShowCompute(false)
      setInputs({})
      onUpdate()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Computation failed')
    }
    setComputing(false)
  }

  const handlePdf = async (returnId: string) => {
    setDownloading(returnId)
    try {
      const data = await getPdf(returnId)
      if (data.pdf_url) window.open(data.pdf_url, '_blank')
      else toast.info('PDF generated — check return details')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'PDF generation failed')
    }
    setDownloading(null)
  }

  const updateInput = (key: string, value: string) => {
    setInputs(prev => ({ ...prev, [key]: value }))
  }

  // Group schema fields by section
  const sections = schema?.fields?.reduce((acc, field) => {
    const section = field.section || 'General'
    if (!acc[section]) acc[section] = []
    acc[section].push(field)
    return acc
  }, {} as Record<string, typeof schema.fields>) || {}

  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Tax Returns</h3>
        <Button onClick={() => setShowCompute(true)} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Compute Return
        </Button>
      </div>

      {returns.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">No returns computed yet for this entity.</p>
            <Button onClick={() => setShowCompute(true)} size="sm" variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Compute First Return
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Year</TableHead>
                <TableHead>Form</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tax Due</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {returns.map((ret: TaxReturn) => {
                const computed = ret.computed_data as Record<string, unknown> | undefined
                const taxDue = computed?.total_tax ?? computed?.tax_liability
                return (
                  <TableRow
                    key={ret.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedReturn(expandedReturn === ret.id ? null : ret.id)}
                  >
                    <TableCell className="font-medium">{ret.tax_year}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{ret.form_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ret.status === 'computed' ? 'default' : 'secondary'}>
                        {ret.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmt(taxDue)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={e => { e.stopPropagation(); handlePdf(ret.id) }}
                        disabled={downloading === ret.id}
                      >
                        {downloading === ret.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Expanded return detail */}
      {expandedReturn && (() => {
        const ret = returns.find(r => r.id === expandedReturn)
        const computed = (ret?.computed_data || {}) as Record<string, number>
        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {ret?.form_type} — {ret?.tax_year} Detail
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                {Object.entries(computed)
                  .filter(([, v]) => typeof v === 'number')
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between py-1 border-b border-border/50">
                      <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                      <span className="font-mono">{fmt(v)}</span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        )
      })()}

      {/* Compute dialog */}
      <Dialog open={showCompute} onOpenChange={setShowCompute}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Compute Tax Return</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Form Type</Label>
                <Select value={formType} onValueChange={setFormType}>
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
                <Select value={String(taxYear)} onValueChange={v => setTaxYear(Number(v))}>
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
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : schema?.fields ? (
              Object.entries(sections).map(([section, fields]) => (
                <div key={section}>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wide">{section}</h4>
                  <div className="grid grid-cols-2 gap-3">
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
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No schema available for this form/year. You can enter fields manually.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCompute(false)}>Cancel</Button>
            <Button onClick={handleCompute} disabled={computing}>
              {computing ? 'Computing...' : 'Compute'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
