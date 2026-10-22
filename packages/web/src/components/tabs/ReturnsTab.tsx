import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, FileText, Loader2, GitBranch, BarChart3, ChevronRight, Upload } from 'lucide-react'
import { type Entity } from '@/hooks/use-entities'
import { useReturns, type TaxReturn } from '@/hooks/use-returns'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'
import { fmtMoney, fmtDelta } from '@/lib/format'
import { SOURCE_LABEL, SOURCE_VARIANT } from '@/lib/labels'
import { keyMetric as keyMetricShared } from '@taxengine/shared'
import { groupByYear } from './returns/helpers'
import { useFiling } from '@/hooks/use-filing'
import AcceptedBadge from './returns/AcceptedBadge'
import ComputeDialog from './returns/ComputeDialog'
import YearDetail from './returns/YearDetail'
import LoadError from '@/components/LoadError'

const keyMetric = (r: TaxReturn | undefined) => keyMetricShared(r?.form_type, r?.field_values)

const fmt = (n: unknown) => fmtMoney(n, '—')

interface Props {
  entityId: string
  entity: Entity
  onUpdate: () => void
  /** Switch the entity page to another tab (the empty state's "Upload documents"). */
  onOpenTab?: (tab: string) => void
}


// Metric ordering/labels and the keyMetric headline live in @taxengine/shared —
// the sectioned canonical keys are the API's contract, not this component's.

export default function ReturnsTab({ entityId, entity, onUpdate, onOpenTab }: Props) {
  const nav = useNavigate()
  const { returns, loading, error, reload, compute, computeFromQbo, createAmendment, validate, getPdf, remove, fillGaps } = useReturns(entityId)
  const [showCompute, setShowCompute] = useState(false)
  const [expandedYear, setExpandedYear] = useState<number | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [gapFilling, setGapFilling] = useState<string | null>(null)
  const [creatingAmendment, setCreatingAmendment] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState<string | null>(null)
  const [editing, setEditing] = useState<TaxReturn | null>(null)
  const { entities: filingEntities } = useFiling(entityId)
  const filing = filingEntities[0]?.years
  const grouped = useMemo(() => groupByYear(returns, filing), [returns, filing])

  // Pick the column label off whichever form-type is dominant for this entity.
  // Single-entity view almost always has one form_type anyway.
  const deltaColLabel = useMemo(() => {
    const anyReturn = returns[0]
    return anyReturn?.form_type === '1120S' ? 'Δ Ord. income' : 'Δ Tax'
  }, [returns])

  const handlePdf = async (returnId: string) => {
    setDownloading(returnId)
    try {
      const data = await getPdf(returnId)
      if (data.url) window.open(data.url, '_blank')
      else toast.info('PDF generated — check return details')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'PDF generation failed')
    }
    setDownloading(null)
  }

  const handleCreateAmendment = async (year: number) => {
    // SOP-03 finding: one accidental click created a blank amendment. It
    // confirms, and now starts from the filed figures rather than blank.
    if (!confirm(`Start a ${year} amendment from the filed return? It begins with the filed figures; then change the lines that need changing.`)) return
    setCreatingAmendment(String(year))
    try {
      const r = await createAmendment(entityId, year)
      const n = r.differs_from_base.length
      toast.success(`${year} amendment started from ${r.base.label}.` + (n
        ? ` ${n} ${n === 1 ? 'line computes' : 'lines compute'} differently from how ${n === 1 ? 'it was' : 'they were'} filed — check them in Compare vs filed.`
        : ' It matches the filed return line for line.'))
      setExpandedYear(year)
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

  // The amendment beside the filed return and the books, every line labelled
  // by the IRS (the Sources view). The old amendment-vs-filed page printed
  // internal keys and each line twice (UI audit #24).
  const handleCompareAmendment = (amendment: TaxReturn) => {
    const q = new URLSearchParams({ view: 'sources', year: String(amendment.tax_year), base: 'filed', with: `ret:${amendment.id.slice(0, 8)},books` })
    nav(`/app/compare/${entityId}?${q}`)
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


  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
  }

  if (error) {
    return <LoadError message={`Couldn't load returns: ${error}`} onRetry={reload} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-lg font-medium">Tax Returns</h3>
        <div className="flex items-center gap-2">
          {/* Always shown: the all-sources view reads the filed PDF, the IRS
              transcripts and the books, so it needs no stored return. It once
              sat only behind "Compare years" (amendments only) and no entity
              had one, so nobody could reach it (2026-10-21). */}
          <Button variant="outline" size="sm" className="gap-2"
            onClick={() => nav(`/app/compare/${entityId}?view=sources&year=${Math.max(new Date().getFullYear() - 1, ...grouped.map(g => g.year))}`)}>
            <BarChart3 className="h-4 w-4" />
            Compare sources
          </Button>
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

      {grouped.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
            {/* A day-one owner holds papers, not line figures: the first step
                is the last return they filed and this year's W-2s and 1099s.
                This used to offer only "Compute First Return" — a form of 40
                blank inputs (UI audit, 2026-10-22). */}
            <p className="text-sm font-medium mb-1">No returns here yet.</p>
            <p className="text-sm text-muted-foreground mb-4 max-w-md">
              Start with the last return you filed and this year's W-2s, 1099s and K-1s. Each filed
              return you upload becomes that year's filed return here.
            </p>
            <div className="flex gap-2">
              {onOpenTab && (
                <Button onClick={() => onOpenTab('documents')} size="sm" className="gap-2">
                  <Upload className="h-4 w-4" />
                  Upload documents
                </Button>
              )}
              <Button onClick={() => setShowCompute(true)} size="sm" variant="outline" className="gap-2">
                <Plus className="h-4 w-4" />
                Enter figures instead
              </Button>
            </div>
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
                // SOP-03: a freshly created amendment has no real inputs yet.
                // Showing its $0 headline against the filed return read as a
                // −$34k tax change to a tester. field_values can't signal
                // blankness (an empty compute still writes the standard
                // deduction), so blank = nothing in input_data but tax_year.
                const amendInputs = (latestAmendment?.input_data || {}) as Record<string, unknown>
                const amendIsBlank = !!latestAmendment &&
                  Object.keys(amendInputs).filter(k => k !== 'tax_year').length === 0
                const deltaTax = (!amendIsBlank && amendTax !== undefined && filedTax !== undefined) ? amendTax - filedTax : null
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
                        {g.filed || g.filing?.filed ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.filed_import}`}>Filed</Badge>
                              {g.filed && <span className="text-sm font-mono">{fmt(filedTax)}</span>}
                              {g.filing && <AcceptedBadge filing={g.filing} />}
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
                            {amendIsBlank ? (
                              <span className="text-xs text-muted-foreground italic" title="This amendment has no values yet — expand the year to compute or delete it.">
                                blank — not yet computed
                              </span>
                            ) : (
                              <span className="text-sm font-mono">{fmt(amendTax)}</span>
                            )}
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
                        ) : g.filed || g.filing?.filed ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={e => { e.stopPropagation(); handleCreateAmendment(g.year) }}
                            disabled={creatingAmendment === String(g.year)}
                            className="gap-1 text-xs h-7"
                          >
                            {creatingAmendment === String(g.year) ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
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
                            entityId={entityId}
                            group={g}
                            onPdf={handlePdf}
                            onDelete={handleDelete}
                            onFillGaps={handleFillGaps}
                            onRecompute={handleRecompute}
                            onCompareAmendment={handleCompareAmendment}
                            onEditLines={setEditing}
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

      {/* Edit an amendment's lines: its inputs, prefilled, recomputed in place */}
      {editing && (
        <ComputeDialog
          key={editing.id}
          open
          onOpenChange={o => { if (!o) setEditing(null) }}
          entityId={entityId}
          defaultFormType={editing.form_type}
          edit={{ returnId: editing.id, taxYear: editing.tax_year, inputs: (editing.input_data || {}) as Record<string, unknown> }}
          compute={compute}
          validate={validate}
          onComputed={onUpdate}
        />
      )}

      {/* Compute dialog */}
      <ComputeDialog
        open={showCompute}
        onOpenChange={setShowCompute}
        entityId={entityId}
        defaultFormType={entity.form_type || '1040'}
        compute={compute}
        validate={validate}
        onComputed={onUpdate}
      />
    </div>
  )
}
