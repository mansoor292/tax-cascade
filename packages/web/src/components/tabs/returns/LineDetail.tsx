/**
 * Line-level view of ONE return — every populated canonical IRS line,
 * grouped by section. Built for SOP-03: "compare the filed return against
 * the PDF line by line" was impossible when the only line-level renderer
 * (LineByLineMatrix) required a filed+amendment pair; a lone filed return
 * had no detailed view at all.
 *
 * Values whose keys appear in verification.gemini_gap_fill.filled_keys are
 * badged "AI-assisted": they were placed by the gap-fill model (grounded
 * against the document's own numbers server-side), not parsed directly by
 * the mapper. Older rows predate filled_keys and show no badges.
 */
import { Fragment, useMemo, useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { fmtMoney } from '@/lib/format'
import { SECTION_ORDER, SECTION_LABELS } from '@taxengine/shared'
import type { TaxReturn } from '@taxengine/shared'
import { collectValues, humanize, sectionOf, sortKey } from '@/pages/compare/helpers'

const fmt = (n: unknown) => (typeof n === 'number' ? fmtMoney(n, '—') : '—')

export default function LineDetail({ ret }: { ret: TaxReturn }) {
  const [showZeros, setShowZeros] = useState(false)

  const aiKeys = useMemo(() => {
    const keys = (ret.verification as any)?.gemini_gap_fill?.filled_keys
    return new Set<string>(Array.isArray(keys) ? keys : [])
  }, [ret])

  const sections = useMemo(() => {
    const vals = collectValues(ret)
    const sorted = Object.keys(vals).sort(sortKey)
    const bySection = new Map<string, Array<{ key: string; v: number }>>()
    for (const k of sorted) {
      const v = vals[k]
      if (!showZeros && v === 0) continue
      const sect = sectionOf(k)
      if (!bySection.has(sect)) bySection.set(sect, [])
      bySection.get(sect)!.push({ key: k, v })
    }
    return Array.from(bySection.entries()).sort(([a], [b]) => {
      const ai = SECTION_ORDER.indexOf(a)
      const bi = SECTION_ORDER.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
  }, [ret, showZeros])

  const totalRowCount = sections.reduce((n, [, rows]) => n + rows.length, 0)

  return (
    <div className="mt-2 pt-2 border-t space-y-2" data-testid="line-detail">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          {totalRowCount} {totalRowCount === 1 ? 'line' : 'lines'} as recorded on this return
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
              <TableHead className="w-[70%]">Line</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sections.map(([section, rows]) => (
              <Fragment key={section}>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={2} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {SECTION_LABELS[section] || section}
                  </TableCell>
                </TableRow>
                {rows.map(({ key, v }) => (
                  <TableRow key={key}>
                    <TableCell className="py-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{humanize(key)}</span>
                        {aiKeys.has(key) && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0 bg-violet-500/10 text-violet-300 border-violet-500/30"
                            title="Placed by AI gap-fill (value verified present in the source document), not parsed directly by the extraction mapper."
                          >
                            AI-assisted
                          </Badge>
                        )}
                      </div>
                      <code className="text-xs text-muted-foreground">{key}</code>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm py-1">{fmt(v)}</TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
            {totalRowCount === 0 && (
              <TableRow>
                <TableCell colSpan={2} className="text-center text-xs text-muted-foreground py-4 italic">
                  No lines with non-zero values. Enable "Show zero-valued lines" to see the full set.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
