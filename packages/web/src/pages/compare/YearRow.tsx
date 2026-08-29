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
