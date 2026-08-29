/**
 * Full canonical-key filed-vs-amended diff for one year. Fetches both rows
 * on demand (GET /api/returns/:id) and groups every populated IRS line by
 * canonical section.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fmtMoney, fmtDelta as fmtDeltaBase } from '@/lib/format'
import { SECTION_ORDER, SECTION_LABELS } from '@taxengine/shared'
import type { TaxReturn } from '@taxengine/shared'
import { collectValues, humanize, sectionOf, sortKey } from './helpers'

const fmt = (n: unknown) => (typeof n === 'number' ? fmtMoney(n, '—') : '—')
const fmtDelta = (n: number) => fmtDeltaBase(n, '±$0')

export default function LineByLineMatrix({ filedId, amendId, year }: { filedId: string; amendId: string; year: number }) {
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
