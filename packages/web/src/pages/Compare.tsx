/**
 * Multi-year Filed vs Amended line-by-line comparison for an entity.
 *
 * Uses the server-side compare_returns endpoint which already:
 *   - Picks one authoritative row per year (filed_import > amendment > proforma > extension)
 *   - Returns all_rows for drill-down
 *   - Returns a matrix of key metrics × year
 *   - Returns YoY changes
 *
 * This page renders the matrix + changes as a data grid + a filed-vs-amended
 * Δ table per year with refund potential.
 */
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BarChart3, Loader2, GitBranch } from 'lucide-react'
import { useCompareReturns } from '@/hooks/use-returns'
import { useEntity } from '@/hooks/use-entities'
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

const METRICS = [
  { key: 'gross_profit',                label: 'Gross profit' },
  { key: 'total_income',                label: 'Total income' },
  { key: 'total_deductions',            label: 'Total deductions' },
  { key: 'taxable_income_before_nol',   label: 'Taxable (before NOL)' },
  { key: 'taxable_income',              label: 'Taxable income' },
  { key: 'income_tax',                  label: 'Income tax' },
  { key: 'total_tax',                   label: 'Total tax' },
  { key: 'total_payments',              label: 'Total payments' },
  { key: 'overpayment',                 label: 'Overpayment' },
  { key: 'refund',                      label: 'Refund' },
  { key: 'balance_due',                 label: 'Balance due' },
  { key: 'amount_owed',                 label: 'Amount owed' },
  { key: 'ordinary_income_loss',        label: 'Ordinary income/loss (1120S)' },
  { key: 'agi',                         label: 'AGI (1040)' },
]

function fmt(n: unknown): string {
  if (typeof n !== 'number' || isNaN(n)) return '—'
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

function fmtDelta(n: number): string {
  if (n === 0) return '±$0'
  const abs = Math.abs(n).toLocaleString()
  return n > 0 ? `+$${abs}` : `-$${abs}`
}

export default function Compare() {
  const { entityId } = useParams<{ entityId: string }>()
  const nav = useNavigate()
  const { entity } = useEntity(entityId)
  const { data, loading, error } = useCompareReturns(entityId)

  // Build Filed vs Amended Δ per year.
  const filedVsAmended = useMemo(() => {
    if (!data) return []
    const byYear = new Map<number, { filed?: any; amendment?: any }>()
    for (const r of data.all_rows) {
      if (!byYear.has(r.tax_year)) byYear.set(r.tax_year, {})
      const slot = byYear.get(r.tax_year)!
      const ts = (r: any) => r?.computed_at || ''
      if (r.source === 'filed_import' && (!slot.filed || ts(r) > ts(slot.filed))) slot.filed = r
      if (r.source === 'amendment' && (!slot.amendment || ts(r) > ts(slot.amendment))) slot.amendment = r
    }
    return Array.from(byYear.entries())
      .filter(([, v]) => v.filed || v.amendment)
      .map(([year, v]) => {
        const fc = v.filed?.computed_data?.computed as Record<string, number> | undefined
        const ac = v.amendment?.computed_data?.computed as Record<string, number> | undefined
        return { year, filed: fc, amendment: ac, filedRow: v.filed, amendRow: v.amendment }
      })
      .sort((a, b) => a.year - b.year)
  }, [data])

  const refundSummary = useMemo(() => {
    let filedTax = 0, amendTax = 0, years = 0
    for (const row of filedVsAmended) {
      if (!row.filed || !row.amendment) continue
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
              {entity?.name || data.entity.name} — Year over year
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

      {/* Filed vs Amended per year */}
      {filedVsAmended.some(r => r.filed && r.amendment) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Filed vs Amendment by year</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
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
                {filedVsAmended.map(({ year, filed, amendment }) => {
                  const ftax = filed?.total_tax
                  const atax = amendment?.total_tax
                  const ftaxable = filed?.taxable_income
                  const ataxable = amendment?.taxable_income
                  const fref = filed?.overpayment ?? 0
                  const aref = amendment?.overpayment ?? 0
                  const dtax  = (typeof ftax === 'number' && typeof atax === 'number') ? atax - ftax : null
                  const dref  = (filed && amendment) ? aref - fref : null
                  return (
                    <TableRow key={year}>
                      <TableCell className="font-medium">
                        {year}
                        <div className="flex gap-1 mt-0.5">
                          {filed     && <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20">F</Badge>}
                          {amendment && <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/20">A</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(ftaxable)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(ataxable)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(ftax)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(atax)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {dtax === null ? '—' : (
                          <span className={dtax < 0 ? 'text-emerald-400' : dtax > 0 ? 'text-red-400' : ''}>
                            {fmtDelta(dtax)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {dref === null ? '—' : (
                          <span className={dref > 0 ? 'text-emerald-400' : dref < 0 ? 'text-red-400' : ''}>
                            {fmtDelta(dref)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
