/**
 * Multi-year Filed vs Amended line-by-line comparison for an entity.
 *
 * Three layers:
 *   1. Summary card — 3-year filed vs amended tax total + refund Δ
 *   2. Year-over-year matrix — key totals × year with YoY Δ
 *   3. Per-year Filed vs Amended table — click a year to expand and see a
 *      full canonical-key-by-canonical-key matrix: every line of the form
 *      where at least one side has a non-zero value.
 *
 * compare_returns provides (1) and (2) in a single response. For (3) we
 * fetch /api/returns/:id on demand for the filed + amendment IDs and
 * diff their field_values + computed_data.computed into canonical rows.
 */
import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BarChart3, Loader2, GitBranch } from 'lucide-react'
import { useCompareReturns, type TaxReturn } from '@/hooks/use-returns'
import { useEntity } from '@/hooks/use-entities'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fmtMoney, fmtDelta as fmtDeltaBase } from '@/lib/format'
import { COMPARE_METRICS, COMPARE_METRIC_LABELS, readMetric } from '@taxengine/shared'
import FocusedCompare from './compare/FocusedCompare'
import YearRow from './compare/YearRow'

// Derived from the API's own COMPARE_METRICS so a row can't exist that the
// matrix endpoint never populates (a hand-kept copy here once carried a
// taxable_income_before_nol row that silently never had data).
const METRICS = COMPARE_METRICS.map(key => ({ key, label: COMPARE_METRIC_LABELS[key] }))

const fmt = (n: unknown) => (typeof n === 'number' ? fmtMoney(n, '—') : '—')
const fmtDelta = (n: number) => fmtDeltaBase(n, '±$0')


export default function Compare() {
  const { entityId } = useParams<{ entityId: string }>()
  const [searchParams] = useSearchParams()
  const focusYearRaw = searchParams.get('year')
  const focusYear = focusYearRaw ? Number(focusYearRaw) : null
  const focusAmendmentId = searchParams.get('amendment_id')
  const nav = useNavigate()
  const { entity } = useEntity(entityId)
  const { data, loading, error } = useCompareReturns(entityId)

  // Build Filed vs Amended pairings per year. Flat metrics are derived from
  // the row's sectioned field_values through the shared metric map —
  // computed_data.computed is no longer persisted (golden model:
  // field_values). "Taxable income" deliberately falls back to ordinary
  // income/loss on 1120S, which has no taxable-income line of its own.
  const metricsFromFieldValues = (r?: TaxReturn): { total_tax?: number; taxable_income?: number; overpayment?: number } => {
    if (!r?.field_values) return {}
    const fv = r.field_values as Record<string, unknown>
    return {
      total_tax:      readMetric(fv, r.form_type, 'total_tax') ?? undefined,
      taxable_income: (readMetric(fv, r.form_type, 'taxable_income')
                        ?? readMetric(fv, r.form_type, 'ordinary_income_loss')) ?? undefined,
      overpayment:    readMetric(fv, r.form_type, 'overpayment') ?? undefined,
    }
  }
  const filedVsAmended = useMemo(() => {
    if (!data) return []
    const byYear = new Map<number, { filed?: TaxReturn; amendment?: TaxReturn }>()
    for (const r of (data.all_rows ?? [])) {
      if (!byYear.has(r.tax_year)) byYear.set(r.tax_year, {})
      const slot = byYear.get(r.tax_year)!
      const ts = (row?: TaxReturn) => row?.computed_at || ''
      if (r.source === 'filed_import' && (!slot.filed || ts(r) > ts(slot.filed))) slot.filed = r
      if (r.source === 'amendment' && (!slot.amendment || ts(r) > ts(slot.amendment))) slot.amendment = r
    }
    return Array.from(byYear.entries())
      .filter(([, v]) => v.filed || v.amendment)
      .map(([year, v]) => ({
        year,
        filed:     metricsFromFieldValues(v.filed),
        amendment: metricsFromFieldValues(v.amendment),
        filedRow:  v.filed,
        amendRow:  v.amendment,
      }))
      .sort((a, b) => a.year - b.year)
  }, [data])

  const refundSummary = useMemo(() => {
    let filedTax = 0, amendTax = 0, years = 0
    for (const row of filedVsAmended) {
      // Guard on the ROWS, not the metrics objects — metricsFromFieldValues
      // returns a truthy {} for a missing side, so the old `!row.filed`
      // check never fired and every filed year was summed against
      // amendments that mostly didn't exist. A tester saw three years of
      // filed tax ($134,909) "compared" against one year's amendment
      // ($55,264) and a phantom +$79,645 refund. Only years that actually
      // HAVE both a filed return and an amendment belong in this total.
      if (!row.filedRow || !row.amendRow) continue
      filedTax += row.filed.total_tax || 0
      amendTax += row.amendment.total_tax || 0
      years += 1
    }
    return { filedTax, amendTax, delta: filedTax - amendTax, years }
  }, [filedVsAmended])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">{error || 'Failed to load comparison'}</p>
        <Button variant="link" onClick={() => nav(-1)}>← Back</Button>
      </div>
    )
  }

  // Focused filed-vs-amended views. ?amendment_id=<id> takes precedence
  // over ?year=. Both resolve a (filed, amendment) pair and render the same
  // FocusedCompare layout.
  if (focusAmendmentId) {
    const rows = data.all_rows ?? []
    const amendRow = rows.find(r => r.id === focusAmendmentId && r.source === 'amendment')
    let filedRow: TaxReturn | undefined
    if (amendRow?.supersedes_id) {
      filedRow = rows.find(r => r.id === amendRow.supersedes_id)
    }
    if (!filedRow && amendRow) {
      // Fallback: latest filed_import for same year
      filedRow = rows
        .filter(r => r.source === 'filed_import' && r.tax_year === amendRow.tax_year)
        .sort((a, b) => (b.computed_at || '').localeCompare(a.computed_at || ''))[0]
    }
    return (
      <FocusedCompare
        entityId={entityId}
        title={`${entity?.name || data.entity?.name || 'Entity'} — ${amendRow?.tax_year ?? '?'} Amendment vs Filed`}
        subtitle={amendRow
          ? `${amendRow.form_type} · amended ${amendRow.id.slice(0, 8)}`
            + (amendRow.computed_at ? ` (${new Date(amendRow.computed_at).toLocaleDateString()})` : '')
            + (filedRow ? ` vs filed ${filedRow.id.slice(0, 8)}` : ' — no filed parent found')
          : undefined}
        emptyMessage={!amendRow
          ? 'Amendment not found.'
          : `No filed parent found for amendment ${amendRow.id.slice(0, 8)}.`}
        filedRow={filedRow}
        amendRow={amendRow}
        year={amendRow?.tax_year ?? 0}
      />
    )
  }

  if (focusYear !== null) {
    const focused = filedVsAmended.find(r => r.year === focusYear)
    return (
      <FocusedCompare
        entityId={entityId}
        title={`${entity?.name || data.entity?.name || 'Entity'} — ${focusYear} Filed vs Amended`}
        subtitle={focused?.filedRow && focused?.amendRow
          ? `${focused.filedRow.form_type} · filed ${focused.filedRow.id.slice(0, 8)} vs amended ${focused.amendRow.id.slice(0, 8)}`
          : undefined}
        emptyMessage={
          focused?.filedRow && !focused?.amendRow ? 'No amendment exists for this year yet.'
          : focused?.amendRow && !focused?.filedRow ? 'No filed return on file for this year.'
          : `No returns found for ${focusYear}.`}
        filedRow={focused?.filedRow}
        amendRow={focused?.amendRow}
        year={focusYear}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => nav(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">
              {entity?.name || data.entity?.name || 'Entity'} — Year over year
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {data.years.length} {data.years.length === 1 ? 'year' : 'years'}: {data.years.join(', ')}
          </p>
        </div>
      </div>

      {/* Refund summary if there are amendments */}
      {refundSummary.years > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-amber-400" />
              Filed vs Amended tax summary — {refundSummary.years}-year
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Filed total tax</p>
                <p className="text-lg font-mono font-semibold">{fmt(refundSummary.filedTax)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Amendment total tax</p>
                <p className="text-lg font-mono font-semibold">{fmt(refundSummary.amendTax)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Potential Δ refund</p>
                <p className={`text-lg font-mono font-semibold ${refundSummary.delta > 0 ? 'text-emerald-400' : refundSummary.delta < 0 ? 'text-red-400' : ''}`}>
                  {fmtDelta(refundSummary.delta)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Year-over-year matrix */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Year over year</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                {data.years.map(y => (
                  <TableHead key={y} className="text-right">{y}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {METRICS.map(({ key, label }) => {
                const row = data.matrix[key] || {}
                const hasAny = data.years.some(y => typeof row[y] === 'number' || typeof row[String(y)] === 'number')
                if (!hasAny) return null
                return (
                  <TableRow key={key}>
                    <TableCell className="font-medium text-sm">{label}</TableCell>
                    {data.years.map(y => {
                      const v = row[y] ?? row[String(y)]
                      const change = data.changes[key]?.[y] ?? data.changes[key]?.[String(y)]
                      return (
                        <TableCell key={y} className="text-right font-mono text-sm">
                          <div>{fmt(v)}</div>
                          {change && typeof change.delta === 'number' && change.delta !== 0 && (
                            <div className={`text-xs ${change.delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {fmtDelta(change.delta)}
                              {Number.isFinite(change.pct) && change.pct !== 0 && ` (${change.pct > 0 ? '+' : ''}${change.pct}%)`}
                            </div>
                          )}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Filed vs Amended per year, with expandable per-year line-by-line matrix */}
      {filedVsAmended.some(r => r.filed && r.amendment) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Filed vs Amendment by year</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Click a year to expand the full canonical-key matrix.
            </p>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead></TableHead>
                  <TableHead>Year</TableHead>
                  <TableHead className="text-right">Filed taxable</TableHead>
                  <TableHead className="text-right">Amend taxable</TableHead>
                  <TableHead className="text-right">Filed tax</TableHead>
                  <TableHead className="text-right">Amend tax</TableHead>
                  <TableHead className="text-right">Δ tax</TableHead>
                  <TableHead className="text-right">Δ refund</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filedVsAmended.map(row => (
                  <YearRow key={row.year} row={row} autoExpand={focusYear === row.year} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
