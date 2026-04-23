import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Download, FileText, Loader2, GitBranch, Sparkles, BarChart3, Trash2, ChevronRight } from 'lucide-react'
import { type Entity } from '@/hooks/use-entities'
import { useReturns, type TaxReturn, type ReturnSource } from '@/hooks/use-returns'
import { useSchema } from '@/hooks/use-schema'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  if (typeof n !== 'number') return String(n ?? '—')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

function fmtDelta(n: number | null | undefined): string {
  if (typeof n !== 'number' || n === 0) return '—'
  const abs = Math.abs(n).toLocaleString()
  return n > 0 ? `+$${abs}` : `-$${abs}`
}

const SOURCE_LABEL: Record<ReturnSource, string> = {
  filed_import: 'Filed',
  amendment:    'Amendment',
  proforma:     'Proforma',
  extension:    'Extension',
}

const SOURCE_VARIANT: Record<ReturnSource, string> = {
  filed_import: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  amendment:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
  proforma:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
  extension:    'bg-purple-500/10 text-purple-400 border-purple-500/20',
}

interface Props {
  entityId: string
  entity: Entity
  onUpdate: () => void
}

interface GroupedYear {
  year: number
  filed?: TaxReturn
  amendment?: TaxReturn
  proforma?: TaxReturn
  extensions: TaxReturn[]
  others: TaxReturn[]
}

function groupByYear(returns: TaxReturn[]): GroupedYear[] {
  const byYear = new Map<number, GroupedYear>()
  for (const r of returns) {
    if (!byYear.has(r.tax_year)) {
      byYear.set(r.tax_year, { year: r.tax_year, extensions: [], others: [] })
    }
    const slot = byYear.get(r.tax_year)!
    const pickLatest = (cur: TaxReturn | undefined, next: TaxReturn) => {
      if (!cur) return next
      return (next.computed_at || '') > (cur.computed_at || '') ? next : cur
    }
    switch (r.source) {
      case 'filed_import': slot.filed     = pickLatest(slot.filed, r); break
      case 'amendment':    slot.amendment = pickLatest(slot.amendment, r); break
      case 'proforma':     slot.proforma  = pickLatest(slot.proforma, r); break
      case 'extension':    slot.extensions.push(r); break
      default:             slot.others.push(r)
    }
  }
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year)
}

function totalTax(r: TaxReturn | undefined): number | undefined {
  if (!r) return undefined
  const c = r.computed_data?.computed as Record<string, number> | undefined
  return c?.total_tax
}

export default function ReturnsTab({ entityId, entity, onUpdate }: Props) {
  const nav = useNavigate()
  const { returns, loading, compute, createAmendment, validate, getPdf, remove, fillGaps } = useReturns(entityId)
  const [showCompute, setShowCompute] = useState(false)
  const [formType, setFormType] = useState(entity.form_type || '1040')
  const [taxYear, setTaxYear] = useState(2024)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [computing, setComputing] = useState(false)
  const [expandedYear, setExpandedYear] = useState<number | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [gapFilling, setGapFilling] = useState<string | null>(null)
  const [creatingAmendment, setCreatingAmendment] = useState<string | null>(null)
  const { schema, loading: schemaLoading } = useSchema(showCompute ? formType : undefined, showCompute ? taxYear : undefined)

  const grouped = useMemo(() => groupByYear(returns), [returns])

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
      valResult.warnings?.forEach(w => toast.warning(w))

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

  const handleCreateAmendment = async (filed: TaxReturn) => {
    setCreatingAmendment(filed.id)
    try {
      await createAmendment(filed)
      toast.success(`Amendment for ${filed.tax_year} ${filed.form_type} created`)
      onUpdate()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Create amendment failed')
    }
    setCreatingAmendment(null)
  }

  const handleFillGaps = async (returnId: string) => {
    setGapFilling(returnId)
    try {
      const result = await fillGaps(returnId)
      toast.success(`Gap-fill: filled ${result.gaps_filled} of ${result.gaps_total}`)
      onUpdate()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Gap-fill failed')
    }
    setGapFilling(null)
  }

  const handleDelete = async (r: TaxReturn) => {
    if (!confirm(`Delete ${SOURCE_LABEL[r.source!] || r.source} ${r.tax_year} ${r.form_type}? This is permanent.`)) return
    try {
      await remove(r.id)
      toast.success('Return deleted')
      onUpdate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
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

  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-lg font-medium">Tax Returns</h3>
        <div className="flex items-center gap-2">
          {grouped.some(g => g.filed && g.amendment) && (
            <Button variant="outline" size="sm" onClick={() => nav(`/app/compare/${entityId}`)} className="gap-2">
              <BarChart3 className="h-4 w-4" />
              Compare years
            </Button>
          )}
          <Button onClick={() => setShowCompute(true)} size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            Compute Return
          </Button>
        </div>
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
                <TableHead>Filed</TableHead>
                <TableHead>Amendment</TableHead>
                <TableHead className="text-right">Δ Tax</TableHead>
                <TableHead>Other</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grouped.map(g => {
                const filedTax = totalTax(g.filed)
                const amendTax = totalTax(g.amendment)
                const deltaTax = (amendTax !== undefined && filedTax !== undefined) ? amendTax - filedTax : null
                const gapStats = g.filed?.verification?.gemini_gap_fill
                const otherCount = g.extensions.length + g.others.length + (g.proforma ? 1 : 0)
                const isExpanded = expandedYear === g.year
                return (
                  <Fragment key={g.year}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpandedYear(isExpanded ? null : g.year)}
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                          {g.year}
                        </div>
                      </TableCell>
                      <TableCell>
                        {g.filed ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.filed_import}`}>Filed</Badge>
                              <span className="text-sm font-mono">{fmt(filedTax)}</span>
                            </div>
                            {gapStats && typeof gapStats.gaps_total === 'number' && (
                              <p className="text-xs text-muted-foreground">
                                Gap-fill {gapStats.gaps_filled ?? 0}/{gapStats.gaps_total}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {g.amendment ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.amendment}`}>Amended</Badge>
                            <span className="text-sm font-mono">{fmt(amendTax)}</span>
                          </div>
                        ) : g.filed ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={e => { e.stopPropagation(); handleCreateAmendment(g.filed!) }}
                            disabled={creatingAmendment === g.filed.id}
                            className="gap-1 text-xs h-7"
                          >
                            {creatingAmendment === g.filed.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                            Create
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {deltaTax === null ? <span className="text-muted-foreground">—</span> : (
                          <span className={deltaTax < 0 ? 'text-emerald-400' : deltaTax > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                            {fmtDelta(deltaTax)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {g.proforma && (
                            <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.proforma}`}>
                              Proforma {fmt(totalTax(g.proforma))}
                            </Badge>
                          )}
                          {g.extensions.map(e => (
                            <Badge key={e.id} variant="outline" className={`text-xs ${SOURCE_VARIANT.extension}`}>
                              {e.form_type}
                            </Badge>
                          ))}
                          {otherCount === 0 && !g.proforma && <span className="text-xs text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={5} className="py-3">
                          <YearDetail
                            group={g}
                            onPdf={handlePdf}
                            onDelete={handleDelete}
                            onFillGaps={handleFillGaps}
                            downloading={downloading}
                            gapFilling={gapFilling}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Compute dialog */}
      <Dialog open={showCompute} onOpenChange={setShowCompute}>
        <DialogContent className="w-[95vw] max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Compute Tax Return</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Form Type</Label>
                <Select value={formType} onValueChange={(v) => v && setFormType(v)}>
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

// ─── Year detail expansion ───

function YearDetail({
  group,
  onPdf,
  onDelete,
  onFillGaps,
  downloading,
  gapFilling,
}: {
  group: GroupedYear
  onPdf: (id: string) => void
  onDelete: (r: TaxReturn) => void
  onFillGaps: (id: string) => void
  downloading: string | null
  gapFilling: string | null
}) {
  const rows = [
    group.filed,
    group.amendment,
    group.proforma,
    ...group.extensions,
    ...group.others,
  ].filter((r): r is TaxReturn => !!r)

  return (
    <div className="space-y-3">
      {rows.map(r => {
        const c = r.computed_data?.computed as Record<string, number> | undefined
        const gap = r.verification?.gemini_gap_fill
        return (
          <div key={r.id} className="bg-background rounded-lg border px-3 py-2">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT[r.source!] || ''}`}>
                  {SOURCE_LABEL[r.source!] || r.source}
                </Badge>
                <Badge variant="outline" className="text-xs">{r.form_type}</Badge>
                <span className="text-xs text-muted-foreground font-mono">
                  {r.id.slice(0, 8)}
                </span>
                {r.computed_at && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.computed_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {r.source === 'filed_import' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onFillGaps(r.id)}
                    disabled={gapFilling === r.id}
                    className="gap-1 text-xs h-7"
                    title="Re-run Gemini gap-fill on this filed return"
                  >
                    {gapFilling === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    Fill gaps
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onPdf(r.id)}
                  disabled={downloading === r.id}
                  title="Generate / download PDF"
                >
                  {downloading === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                </Button>
                {r.source !== 'filed_import' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(r)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {c && Object.entries(c).slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                  <span className="font-mono">{fmt(v)}</span>
                </div>
              ))}
            </div>
            {gap && (typeof gap.gaps_total === 'number' || gap.model) && (
              <div className="mt-2 pt-2 border-t text-xs text-muted-foreground">
                Gap-fill: {gap.gaps_filled ?? 0} of {gap.gaps_total ?? 0} filled
                {gap.model ? ` · ${gap.model}` : ''}
                {gap.error ? ` · error: ${gap.error}` : ''}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
