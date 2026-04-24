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
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BarChart3, Loader2, GitBranch, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useCompareReturns, type TaxReturn } from '@/hooks/use-returns'
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

const SECTION_ORDER = [
  'income', 'cogs', 'deductions', 'tax', 'credits', 'payments',
  'result', 'refund', 'owed', 'overpayment',
  'schedJ', 'schedL', 'schedM1', 'schedM2', 'schedK', 'schedB', 'schedE',
  'engine',
  'meta', 'preparer',
]

const SECTION_LABELS: Record<string, string> = {
  income:      'Income (Page 1)',
  cogs:        '1125-A COGS',
  deductions:  'Deductions (Page 1)',
  tax:         'Tax Computation',
  credits:     'Credits',
  payments:    'Payments',
  result:      'Refund / Owed',
  refund:      'Refund',
  owed:        'Balance Due',
  overpayment: 'Overpayment',
  schedJ:      'Schedule J',
  schedL:      'Schedule L (Balance Sheet)',
  schedM1:     'Schedule M-1',
  schedM2:     'Schedule M-2',
  schedK:      'Schedule K',
  schedB:      'Schedule B',
  schedE:      'Schedule E',
  engine:      'Engine-computed totals',
  meta:        'Entity Metadata',
  preparer:    'Preparer',
  other:       'Other',
}

// Engine flat key → sectioned canonical key (matching field_values). When a
// sectioned peer is already in the collected values for a row, we drop the
// flat duplicate; otherwise we promote it into the "engine" section so it
// renders under a meaningful header instead of "Other".
const COMPUTED_TO_SECTIONED: Record<string, string> = {
  total_tax:                 'tax.L31_total_tax',
  taxable_income:            'tax.L30_taxable_income',
  taxable_income_before_nol: 'tax.L28_ti_before_nol',
  income_tax:                'tax.L31_total_tax',
  total_income:              'income.L11_total_income',
  total_deductions:          'deductions.L27_total_deductions',
  gross_profit:              'income.L3_gross_profit',
  gross_receipts:            'income.L1a_gross_receipts',
  cost_of_goods_sold:        'income.L2_cogs',
  cogs:                      'income.L2_cogs',
  total_payments:            'payments.L33_total_payments',
  overpayment:               'payments.L36_overpayment',
  refund:                    'payments.L37_refunded',
  amount_owed:               'payments.L35_amount_owed',
  balance_due:               'payments.L35_amount_owed',
  balance_1c:                'income.L1c_balance',
  gross_receipts_balance:    'income.L1c_balance',
}

function fmt(n: unknown): string {
  if (typeof n !== 'number' || isNaN(n)) return '—'
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

function fmtDelta(n: number): string {
  if (n === 0) return '±$0'
  const abs = Math.abs(n).toLocaleString()
  return n > 0 ? `+$${abs}` : `-$${abs}`
}

/** Collect all numeric canonical key/value pairs from a return row. */
function collectValues(ret: TaxReturn | undefined): Record<string, number> {
  if (!ret) return {}
  const out: Record<string, number> = {}
  const fv = (ret.field_values || {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(fv)) {
    if (typeof v === 'number' && !isNaN(v)) out[k] = v
  }
  const c = (ret.computed_data?.computed || {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(c)) {
    if (typeof v !== 'number' || isNaN(v)) continue
    // Skip engine flat keys whose sectioned peer already carries the value —
    // tax.L31_total_tax, income.L1a_gross_receipts, etc. already landed in
    // `out` from field_values above.
    const sectioned = COMPUTED_TO_SECTIONED[k]
    if (sectioned && sectioned in out) continue
    // True engine-only metric (nol_*, special_deductions, total_credits) —
    // route into the 'engine' section rather than the catch-all 'other'.
    out[`engine.${k}`] = v
  }
  return out
}

/** Humanize a canonical key: "income.L1a_gross_receipts" → "L1a gross receipts". */
function humanize(key: string): string {
  const [, rest] = key.split('.', 2)
  if (!rest) return key
  return rest.replace(/_/g, ' ')
}

function sectionOf(key: string): string {
  const prefix = key.split('.', 2)[0]
  if (SECTION_ORDER.includes(prefix)) return prefix
  return 'other'
}

function sortKey(a: string, b: string): number {
  const sa = sectionOf(a), sb = sectionOf(b)
  const idxA = SECTION_ORDER.indexOf(sa), idxB = SECTION_ORDER.indexOf(sb)
  if (idxA !== idxB) return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
  return a.localeCompare(b)
}

export default function Compare() {
  const { entityId } = useParams<{ entityId: string }>()
  const [searchParams] = useSearchParams()
  const focusYearRaw = searchParams.get('year')
  const focusYear = focusYearRaw ? Number(focusYearRaw) : null
  const focusAmendmentId = searchParams.get('amendment_id')
  const nav = useNavigate()
  const { entity } = useEntity(entityId)
  const { data, loading, error } = useCompareReturns(entityId)

  // Build Filed vs Amended pairings per year.
  const filedVsAmended = useMemo(() => {
    if (!data) return []
    const byYear = new Map<number, { filed?: TaxReturn; amendment?: TaxReturn }>()
    for (const r of data.all_rows) {
      if (!byYear.has(r.tax_year)) byYear.set(r.tax_year, {})
      const slot = byYear.get(r.tax_year)!
      const ts = (row?: TaxReturn) => row?.computed_at || ''
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

  // Single-amendment focused view: ?amendment_id=<id> takes precedence over
  // ?year=. Resolve the amendment row, find its parent (supersedes_id → filed,
  // falling back to the year's latest filed_import), and render the line-by-
  // line diff for that specific amendment.
  if (focusAmendmentId) {
    const amendRow = data.all_rows.find(r => r.id === focusAmendmentId && r.source === 'amendment')
    let filedRow: TaxReturn | undefined
    if (amendRow?.supersedes_id) {
      filedRow = data.all_rows.find(r => r.id === amendRow.supersedes_id)
    }
    if (!filedRow && amendRow) {
      // Fallback: latest filed_import for same year
      filedRow = data.all_rows
        .filter(r => r.source === 'filed_import' && r.tax_year === amendRow.tax_year)
        .sort((a, b) => (b.computed_at || '').localeCompare(a.computed_at || ''))[0]
    }
    const canCompare = Boolean(amendRow && filedRow)
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => nav(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <GitBranch className="h-4 w-4 text-amber-400" />
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">
                {entity?.name || data.entity.name} — {amendRow?.tax_year ?? '?'} Amendment vs Filed
              </h1>
            </div>
            {amendRow && (
              <p className="text-sm text-muted-foreground">
                {amendRow.form_type} · amended {amendRow.id.slice(0, 8)}
                {amendRow.computed_at ? ` (${new Date(amendRow.computed_at).toLocaleDateString()})` : ''}
                {filedRow ? ` vs filed ${filedRow.id.slice(0, 8)}` : ' — no filed parent found'}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => nav(`/app/compare/${entityId}`)}
            className="gap-1"
            title="See all years side-by-side"
          >
            <BarChart3 className="h-4 w-4" />
            All years
          </Button>
        </div>

        {!canCompare ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {!amendRow && 'Amendment not found.'}
              {amendRow && !filedRow && `No filed parent found for amendment ${amendRow.id.slice(0, 8)}.`}
            </CardContent>
          </Card>
        ) : (
          <LineByLineMatrix
            filedId={filedRow!.id}
            amendId={amendRow!.id}
            year={amendRow!.tax_year}
          />
        )}
      </div>
    )
  }

  // Single-year focused view: when ?year=YYYY is set, show only that year's
  // filed-vs-amended line-by-line matrix. Everything else is noise here.
  if (focusYear !== null) {
    const focused = filedVsAmended.find(r => r.year === focusYear)
    const canCompare = Boolean(focused?.filedRow && focused?.amendRow)
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => nav(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <GitBranch className="h-4 w-4 text-amber-400" />
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">
                {entity?.name || data.entity.name} — {focusYear} Filed vs Amended
              </h1>
            </div>
            {focused?.filedRow && focused?.amendRow && (
              <p className="text-sm text-muted-foreground">
                {focused.filedRow.form_type} · filed {focused.filedRow.id.slice(0, 8)} vs amended {focused.amendRow.id.slice(0, 8)}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => nav(`/app/compare/${entityId}`)}
            className="gap-1"
            title="See all years side-by-side"
          >
            <BarChart3 className="h-4 w-4" />
            All years
          </Button>
        </div>

        {!canCompare ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {focused?.filedRow && !focused?.amendRow && 'No amendment exists for this year yet.'}
              {focused?.amendRow && !focused?.filedRow && 'No filed return on file for this year.'}
              {!focused && `No returns found for ${focusYear}.`}
            </CardContent>
          </Card>
        ) : (
          <LineByLineMatrix
            filedId={focused!.filedRow!.id}
            amendId={focused!.amendRow!.id}
            year={focusYear}
          />
        )}
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

// ─── Year row with expandable line-by-line matrix ───

interface YearRowData {
  year: number
  filed?: Record<string, number>
  amendment?: Record<string, number>
  filedRow?: TaxReturn
  amendRow?: TaxReturn
}

function YearRow({ row, autoExpand = false }: { row: YearRowData; autoExpand?: boolean }) {
  const canExpand = Boolean(row.filedRow && row.amendRow)
  const [expanded, setExpanded] = useState(autoExpand && canExpand)
  useEffect(() => {
    if (autoExpand && canExpand) setExpanded(true)
  }, [autoExpand, canExpand])

  const ftax = row.filed?.total_tax
  const atax = row.amendment?.total_tax
  const ftaxable = row.filed?.taxable_income
  const ataxable = row.amendment?.taxable_income
  const fref = row.filed?.overpayment ?? 0
  const aref = row.amendment?.overpayment ?? 0
  const dtax = (typeof ftax === 'number' && typeof atax === 'number') ? atax - ftax : null
  const dref = (row.filedRow && row.amendRow) ? aref - fref : null

  return (
    <Fragment>
      <TableRow
        className={canExpand ? 'cursor-pointer hover:bg-muted/30' : ''}
        onClick={() => canExpand && setExpanded(v => !v)}
      >
        <TableCell className="w-8">
          {canExpand && (
            <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
          )}
        </TableCell>
        <TableCell className="font-medium">
          {row.year}
          <div className="flex gap-1 mt-0.5">
            {row.filedRow  && <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20">F</Badge>}
            {row.amendRow && <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/20">A</Badge>}
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
      {expanded && canExpand && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={8} className="py-3">
            <LineByLineMatrix filedId={row.filedRow!.id} amendId={row.amendRow!.id} year={row.year} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}

function LineByLineMatrix({ filedId, amendId, year }: { filedId: string; amendId: string; year: number }) {
  const [filed, setFiled] = useState<TaxReturn | null>(null)
  const [amend, setAmend] = useState<TaxReturn | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showZeros, setShowZeros] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    Promise.all([
      api<{ return: TaxReturn }>(`/api/returns/${filedId}`),
      api<{ return: TaxReturn }>(`/api/returns/${amendId}`),
    ])
      .then(([f, a]) => {
        if (cancelled) return
        setFiled(f.return); setAmend(a.return)
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [filedId, amendId])

  const sections = useMemo(() => {
    if (!filed || !amend) return []
    const filedVals = collectValues(filed)
    const amendVals = collectValues(amend)
    const keys = new Set([...Object.keys(filedVals), ...Object.keys(amendVals)])
    const sorted = Array.from(keys).sort(sortKey)

    const bySection = new Map<string, Array<{ key: string; fv?: number; av?: number; delta: number }>>()
    for (const k of sorted) {
      const fv = filedVals[k]
      const av = amendVals[k]
      const fvN = typeof fv === 'number' ? fv : 0
      const avN = typeof av === 'number' ? av : 0
      const delta = avN - fvN
      // Skip if both sides are zero/undefined AND showZeros is off.
      if (!showZeros && fvN === 0 && avN === 0) continue
      const sect = sectionOf(k)
      if (!bySection.has(sect)) bySection.set(sect, [])
      bySection.get(sect)!.push({ key: k, fv, av, delta })
    }
    return Array.from(bySection.entries())
      .sort(([a], [b]) => {
        const ai = SECTION_ORDER.indexOf(a)
        const bi = SECTION_ORDER.indexOf(b)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
  }, [filed, amend, showZeros])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading {year} line-by-line…
      </div>
    )
  }

  if (error) {
    return <p className="text-xs text-red-400 text-center py-2">Error loading {year}: {error}</p>
  }

  const totalRowCount = sections.reduce((n, [, rows]) => n + rows.length, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          {totalRowCount} {totalRowCount === 1 ? 'line' : 'lines'} · {filed?.id.slice(0, 8)} (filed) vs {amend?.id.slice(0, 8)} (amended)
        </p>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showZeros}
            onChange={e => setShowZeros(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Show zero-valued lines
        </label>
      </div>
      <div className="border rounded-md overflow-hidden bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[42%]">Line</TableHead>
              <TableHead className="text-right">Filed</TableHead>
              <TableHead className="text-right">Amendment</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sections.map(([section, rows]) => (
              <Fragment key={section}>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={4} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {SECTION_LABELS[section] || section}
                  </TableCell>
                </TableRow>
                {rows.map(({ key, fv, av, delta }) => (
                  <TableRow key={key}>
                    <TableCell className="py-1">
                      <div className="text-sm">{humanize(key)}</div>
                      <code className="text-xs text-muted-foreground">{key}</code>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm py-1">{fmt(fv)}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-1">{fmt(av)}</TableCell>
                    <TableCell className="text-right font-mono text-sm py-1">
                      {delta === 0 ? <span className="text-muted-foreground">—</span> : (
                        <span className={delta < 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {fmtDelta(delta)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
            {totalRowCount === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4 italic">
                  No lines with non-zero values. Enable "Show zero-valued lines" to see the full canonical key set.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
