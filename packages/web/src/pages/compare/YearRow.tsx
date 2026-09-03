import { Fragment, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { TableCell, TableRow } from '@/components/ui/table'
import { fmtMoney, fmtDelta as fmtDeltaBase } from '@/lib/format'
import type { TaxReturn } from '@taxengine/shared'
import LineByLineMatrix from './LineByLineMatrix'

const fmt = (n: unknown) => (typeof n === 'number' ? fmtMoney(n, '—') : '—')
const fmtDelta = (n: number) => fmtDeltaBase(n, '±$0')

// ─── Year row with expandable line-by-line matrix ───

export interface YearRowData {
  year: number
  filed?: Record<string, number>
  amendment?: Record<string, number>
  filedRow?: TaxReturn
  amendRow?: TaxReturn
}

export default function YearRow({ row, autoExpand = false }: { row: YearRowData; autoExpand?: boolean }) {
  const canExpand = Boolean(row.filedRow && row.amendRow)
  const [expanded, setExpanded] = useState(autoExpand && canExpand)
  useEffect(() => {
    if (autoExpand && canExpand) setExpanded(true)
  }, [autoExpand, canExpand])

  const ftax = row.filed?.total_tax
  const atax = row.amendment?.total_tax
  const ftaxable = row.filed?.taxable_income
  const ataxable = row.amendment?.taxable_income
  // Δ refund must follow the same both-sides-present rule as Δ tax. A 1040-X
  // restates the lines it changes — it does NOT restate the original refund,
  // so an imported amendment usually has no overpayment key at all. The old
  // `?? 0` here read that absence as "refund became $0" and a tester saw
  // Δ refund = −$15,202 on a year whose Δ tax was ±$0. Absent means "not
  // restated" and renders as —, never as a delta against zero.
  const fref = row.filed?.overpayment
  const aref = row.amendment?.overpayment
  const dtax = (typeof ftax === 'number' && typeof atax === 'number') ? atax - ftax : null
  const dref = (typeof fref === 'number' && typeof aref === 'number') ? aref - fref : null

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
