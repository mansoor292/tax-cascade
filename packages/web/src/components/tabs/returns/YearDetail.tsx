/**
 * Expanded per-year detail rows for the Returns tab — the canonical
 * metricsForForm ordering keeps Filed / Amendment / Proforma scannable.
 */
import { Download, Loader2, Sparkles, Trash2, RefreshCw, Scale } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmtMoney } from '@/lib/format'
import { SOURCE_LABEL, SOURCE_VARIANT } from '@/lib/labels'
import { metricsForForm } from '@taxengine/shared'
import type { TaxReturn } from '@taxengine/shared'
import type { GroupedYear } from './helpers'

const fmt = (n: unknown) => fmtMoney(n, '—')

export default function YearDetail({
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
        const gap = r.verification?.gemini_gap_fill
        const canRecompute = r.source === 'amendment' || r.source === 'proforma'
        const isCorp = r.form_type === '1120' || r.form_type === '1120S'
        const isStale = r.status === 'invalidated'
        return (
          <div key={r.id} className={`bg-background rounded-lg border px-3 py-2 ${isStale ? 'border-amber-500/40' : ''}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT[r.source!] || ''}`}>
                  {SOURCE_LABEL[r.source!] || r.source}
                </Badge>
                {isStale && (
                  <Badge
                    variant="outline"
                    className="text-xs bg-amber-500/15 text-amber-300 border-amber-500/40"
                    title={r.source === 'filed_import'
                      ? 'Pre-refactor data shape — re-archive the source PDF (Documents tab) to regenerate.'
                      : 'Pre-refactor data shape — click Recompute to regenerate.'}
                  >
                    Stale — regenerate
                  </Badge>
                )}
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
              {(() => {
                const fv = (r.field_values || {}) as Record<string, unknown>
                const metrics = metricsForForm(r.form_type)
                const allBlank = metrics.every(({ fv_key }) => {
                  const v = fv[fv_key]
                  return typeof v !== 'number' || isNaN(v)
                })
                if (allBlank) {
                  return (
                    <div className="col-span-full text-center text-muted-foreground py-1 italic">
                      Stale shape — click Recompute (or Re-archive on the source PDF) to regenerate.
                    </div>
                  )
                }
                return metrics.map(({ fv_key, label }) => {
                  const v = fv[fv_key]
                  const isNum = typeof v === 'number' && !isNaN(v)
                  return (
                    <div key={fv_key} className="flex flex-col">
                      <span className="text-muted-foreground">{label}</span>
                      <span className={`font-mono ${isNum ? '' : 'text-muted-foreground'}`}>
                        {isNum ? fmt(v as number) : '—'}
                      </span>
                    </div>
                  )
                })
              })()}
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
