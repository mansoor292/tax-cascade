import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Download, FileText, Loader2, GitBranch, Sparkles, BarChart3, Trash2, ChevronRight, RefreshCw, Scale } from 'lucide-react'
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
  /** All amendments for the year, newest first. Duplicates (same supersedes_id,
   *  separate compute runs) are intentionally preserved so the UI can surface
   *  them — they're almost always cruft the user needs to see and delete. */
  amendments: TaxReturn[]
  proforma?: TaxReturn
  extensions: TaxReturn[]
  others: TaxReturn[]
}

function groupByYear(returns: TaxReturn[]): GroupedYear[] {
  const byYear = new Map<number, GroupedYear>()
  for (const r of returns) {
    if (!byYear.has(r.tax_year)) {
      byYear.set(r.tax_year, { year: r.tax_year, amendments: [], extensions: [], others: [] })
    }
    const slot = byYear.get(r.tax_year)!
    const pickLatest = (cur: TaxReturn | undefined, next: TaxReturn) => {
      if (!cur) return next
      return (next.computed_at || '') > (cur.computed_at || '') ? next : cur
    }
    switch (r.source) {
      case 'filed_import': slot.filed     = pickLatest(slot.filed, r); break
      case 'amendment':    slot.amendments.push(r); break
      case 'proforma':     slot.proforma  = pickLatest(slot.proforma, r); break
      case 'extension':    slot.extensions.push(r); break
      default:             slot.others.push(r)
    }
  }
  // Sort amendments newest-first within each year
  for (const g of byYear.values()) {
    g.amendments.sort((a, b) => (b.computed_at || '').localeCompare(a.computed_at || ''))
  }
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year)
}

// Canonical ordered metric list per form type. Always render these 8 rows
// in this order for any Filed / Amendment / Proforma / Extension of that
// form, so the reader can scan filed-vs-amended-vs-proforma without the
// fields shuffling based on object key insertion order.
const METRICS_BY_FORM: Record<string, Array<{ key: string; label: string }>> = {
  '1120': [
    { key: 'gross_receipts',   label: 'Gross receipts' },
    { key: 'total_income',     label: 'Total income' },
    { key: 'total_deductions', label: 'Total deductions' },
    { key: 'taxable_income',   label: 'Taxable income' },
    { key: 'income_tax',       label: 'Income tax' },
    { key: 'total_tax',        label: 'Total tax' },
    { key: 'total_payments',   label: 'Total payments' },
    { key: 'overpayment',      label: 'Overpayment' },
  ],
  '1120S': [
    { key: 'gross_receipts',        label: 'Gross receipts' },
    { key: 'gross_profit',          label: 'Gross profit' },
    { key: 'total_income',          label: 'Total income' },
    { key: 'total_deductions',      label: 'Total deductions' },
    { key: 'ordinary_income_loss',  label: 'Ordinary income/loss' },
    { key: 'total_tax',             label: 'Total tax' },
    { key: 'total_payments',        label: 'Total payments' },
    { key: 'overpayment',           label: 'Overpayment' },
  ],
  '1040': [
    { key: 'total_income',     label: 'Total income' },
    { key: 'agi',              label: 'AGI' },
    { key: 'taxable_income',   label: 'Taxable income' },
    { key: 'income_tax',       label: 'Income tax' },
    { key: 'total_tax',        label: 'Total tax' },
    { key: 'total_payments',   label: 'Total payments' },
    { key: 'refund',           label: 'Refund' },
    { key: 'balance_due',      label: 'Balance due' },
  ],
  '7004': [
    { key: 'tentative_tax',    label: 'Tentative tax' },
    { key: 'total_payments',   label: 'Total payments' },
    { key: 'balance_due',      label: 'Balance due' },
    { key: 'overpayment',      label: 'Overpayment' },
  ],
  '4868': [
    { key: 'tentative_tax',    label: 'Tentative tax' },
    { key: 'total_payments',   label: 'Total payments' },
    { key: 'balance_due',      label: 'Balance due' },
    { key: 'overpayment',      label: 'Overpayment' },
  ],
}

function metricsForForm(form_type: string): Array<{ key: string; label: string }> {
  return METRICS_BY_FORM[form_type] || METRICS_BY_FORM['1120']
}

// Column metric: what moves most on an amendment for this form.
//   1120  → corporate total_tax
//   1120S → ordinary_income_loss (pass-through to K-1s; no corp tax)
//   1040  → total_tax
function keyMetric(r: TaxReturn | undefined): { value: number | undefined; label: string } {
  if (!r) return { value: undefined, label: 'Δ Tax' }
  const c = r.computed_data?.computed as Record<string, number> | undefined
  if (!c) return { value: undefined, label: 'Δ Tax' }
  if (r.form_type === '1120S') {
    return { value: c.ordinary_income_loss, label: 'Δ Ord. income' }
  }
  return { value: c.total_tax, label: 'Δ Tax' }
}

export default function ReturnsTab({ entityId, entity, onUpdate }: Props) {
  const nav = useNavigate()
  const { returns, loading, compute, computeFromQbo, createAmendment, validate, getPdf, remove, fillGaps } = useReturns(entityId)
  const [showCompute, setShowCompute] = useState(false)
  const [formType, setFormType] = useState(entity.form_type || '1040')
  const [taxYear, setTaxYear] = useState(2024)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [computing, setComputing] = useState(false)
  const [expandedYear, setExpandedYear] = useState<number | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [gapFilling, setGapFilling] = useState<string | null>(null)
  const [creatingAmendment, setCreatingAmendment] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState<string | null>(null)
  const { schema, loading: schemaLoading } = useSchema(showCompute ? formType : undefined, showCompute ? taxYear : undefined)

  const grouped = useMemo(() => groupByYear(returns), [returns])

  // Pick the column label off whichever form-type is dominant for this entity.
  // Single-entity view almost always has one form_type anyway.
  const deltaColLabel = useMemo(() => {
    const anyReturn = returns[0]
    return anyReturn?.form_type === '1120S' ? 'Δ Ord. income' : 'Δ Tax'
  }, [returns])

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

  const handleRecompute = async (r: TaxReturn) => {
    setRecomputing(r.id)
    try {
      const isCorporate = r.form_type === '1120' || r.form_type === '1120S'
      if (isCorporate) {
        await computeFromQbo({
          entity_id:  r.entity_id,
          tax_year:   r.tax_year,
          form_type:  r.form_type,
          return_id:  r.id,
          overrides:  (r.input_data as Record<string, unknown>) || {},
        })
        toast.success(`Recomputed ${r.tax_year} ${r.form_type} from QBO`)
      } else {
        await compute({
          entity_id:  r.entity_id,
          tax_year:   r.tax_year,
          form_type:  r.form_type,
          return_id:  r.id,
          inputs:     { tax_year: r.tax_year, ...(r.input_data as Record<string, unknown> || {}) },
        })
        toast.success(`Recomputed ${r.tax_year} ${r.form_type}`)
      }
      onUpdate()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Recompute failed')
    }
    setRecomputing(null)
  }

  const handleCompareAmendment = (amendment: TaxReturn) => {
    nav(`/app/compare/${entityId}?amendment_id=${amendment.id}`)
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
          {grouped.some(g => g.filed && g.amendments.length > 0) && (
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
                <TableHead className="text-right">{deltaColLabel}</TableHead>
                <TableHead>Other</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grouped.map(g => {
                const latestAmendment = g.amendments[0]
                const filedMetric = keyMetric(g.filed)
                const amendMetric = keyMetric(latestAmendment)
                const filedTax = filedMetric.value
                const amendTax = amendMetric.value
                const deltaTax = (amendTax !== undefined && filedTax !== undefined) ? amendTax - filedTax : null
                const gapStats = g.filed?.verification?.gemini_gap_fill
                const otherCount = g.extensions.length + g.others.length + (g.proforma ? 1 : 0)
                const isExpanded = expandedYear === g.year
                const extraAmendmentCount = Math.max(0, g.amendments.length - 1)
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
                        {latestAmendment ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.amendment}`}>Amended</Badge>
                            <span className="text-sm font-mono">{fmt(amendTax)}</span>
                            {extraAmendmentCount > 0 && (
                              <Badge
                                variant="outline"
                                className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/30"
                                title={`${g.amendments.length} amendments on file for ${g.year}. Expand the row to review and delete duplicates.`}
                              >
                                +{extraAmendmentCount} more
                              </Badge>
                            )}
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
                              Proforma {fmt(keyMetric(g.proforma).value)}
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
                            onRecompute={handleRecompute}
                            onCompareAmendment={handleCompareAmendment}
                            downloading={downloading}
                            gapFilling={gapFilling}
                            recomputing={recomputing}
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
  onRecompute,
  onCompareAmendment,
  downloading,
  gapFilling,
  recomputing,
}: {
  group: GroupedYear
  onPdf: (id: string) => void
  onDelete: (r: TaxReturn) => void
  onFillGaps: (id: string) => void
  onRecompute: (r: TaxReturn) => void
  onCompareAmendment: (r: TaxReturn) => void
  downloading: string | null
  gapFilling: string | null
  recomputing: string | null
}) {
  const rows = [
    group.filed,
    ...group.amendments,
    group.proforma,
    ...group.extensions,
    ...group.others,
  ].filter((r): r is TaxReturn => !!r)

  // Read the filed return's accounting method (Schedule K line 1: cash/accrual/other)
  const readMethod = (r?: TaxReturn): string | null => {
    if (!r) return null
    const fv = (r.field_values || {}) as Record<string, unknown>
    const m = fv['meta.sched_k.K1_method'] ?? fv['schedK.K1_method'] ?? fv['meta.accounting_method']
    if (typeof m === 'string') return m
    if (typeof m === 'number') return ['cash', 'accrual', 'other'][m] || null
    return null
  }
  const methodStr = readMethod(group.filed) || readMethod(group.amendments[0])

  return (
    <div className="space-y-3">
      {(methodStr || group.amendments.length > 1) && (
        <div className="flex items-center gap-2 flex-wrap">
          {methodStr && (
            <Badge variant="outline" className="text-xs capitalize gap-1">
              <Scale className="h-3 w-3" />
              Return basis: {methodStr}
            </Badge>
          )}
          {group.amendments.length > 1 && (
            <Badge
              variant="outline"
              className="text-xs gap-1 bg-amber-500/10 text-amber-400 border-amber-500/30"
              title="Multiple amendments exist for this year. Review each and delete the stale ones."
            >
              {group.amendments.length} amendments — delete duplicates below
            </Badge>
          )}
        </div>
      )}
      {rows.map(r => {
        const c = r.computed_data?.computed as Record<string, number> | undefined
        const gap = r.verification?.gemini_gap_fill
        const canRecompute = r.source === 'amendment' || r.source === 'proforma'
        const isCorp = r.form_type === '1120' || r.form_type === '1120S'
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
                {r.source === 'amendment' && group.filed && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCompareAmendment(r)}
                    className="gap-1 text-xs h-7"
                    title={`Line-by-line compare of this amendment (${r.id.slice(0, 8)}) against filed ${group.filed.id.slice(0, 8)}`}
                  >
                    <Scale className="h-3 w-3" />
                    Compare vs filed
                  </Button>
                )}
                {canRecompute && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRecompute(r)}
                    disabled={recomputing === r.id}
                    className="gap-1 text-xs h-7"
                    title={isCorp
                      ? 'Pull latest QBO data and recompute this return'
                      : 'Recompute this return with its saved inputs'}
                  >
                    {recomputing === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    {isCorp ? 'Recompute from QBO' : 'Recompute'}
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
              {c && metricsForForm(r.form_type).map(({ key, label }) => {
                const v = c[key]
                const isNum = typeof v === 'number' && !isNaN(v)
                return (
                  <div key={key} className="flex flex-col">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`font-mono ${isNum ? '' : 'text-muted-foreground'}`}>
                      {isNum ? fmt(v) : '—'}
                    </span>
                  </div>
                )
              })}
              {c && metricsForForm(r.form_type).every(({ key }) => {
                const v = c[key]
                return typeof v !== 'number' || isNaN(v)
              }) && (
                <div className="col-span-full text-center text-muted-foreground py-1 italic">
                  No computed values — extract values from field_values below or re-archive.
                </div>
              )}
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
