/**
 * Expanded per-year detail rows for the Returns tab — the canonical
 * metricsForForm ordering keeps Filed / Amendment / Proforma scannable.
 */
import { useState } from 'react'
import { Download, ListOrdered, Loader2, Sparkles, Trash2, RefreshCw, Scale, Pencil, FileCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmtMoney } from '@/lib/format'
import { SOURCE_LABEL, SOURCE_VARIANT } from '@/lib/labels'
import { metricsForForm } from '@taxengine/shared'
import type { TaxReturn } from '@taxengine/shared'
import type { GroupedYear } from './helpers'
import LineDetail from './LineDetail'
import AcceptedBadge from './AcceptedBadge'
import BooksAgreement from './BooksAgreement'
import { Link } from 'react-router-dom'

const fmt = (n: unknown) => fmtMoney(n, '—')

export default function YearDetail({
  entityId,
  group,
  onPdf,
  onDelete,
  onFillGaps,
  onRecompute,
  onCompareAmendment,
  onEditLines,
  onRecordFiled,
  downloading,
  gapFilling,
  recomputing,
  recordingFiled,
}: {
  entityId: string
  group: GroupedYear
  onPdf: (id: string) => void
  onDelete: (r: TaxReturn) => void
  onFillGaps: (id: string) => void
  onRecompute: (r: TaxReturn) => void
  onCompareAmendment: (r: TaxReturn) => void
  onEditLines: (r: TaxReturn) => void
  /** Upload the signed amended return: the amendment is then filed */
  onRecordFiled: (r: TaxReturn) => void
  downloading: string | null
  gapFilling: string | null
  recomputing: string | null
  recordingFiled: string | null
}) {
  const rows = [
    group.filed,
    ...group.amendments,
    group.proforma,
    ...group.extensions,
    ...group.others,
  ].filter((r): r is TaxReturn => !!r)

  // SOP-03: a filed return needs its own line-level view — before this, only
  // an amendment's "Compare vs filed" could show canonical lines at all.
  const [openLines, setOpenLines] = useState<Set<string>>(new Set())
  const toggleLines = (id: string) => setOpenLines(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

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

  const f = group.filing
  return (
    <div className="space-y-3">
      {f?.filed && (
        <div className="bg-background rounded-lg border px-3 py-2 text-xs space-y-1" data-testid="filing-status">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.filed_import}`}>Filed</Badge>
            <AcceptedBadge filing={f} />
            {f.filed.filename && <span className="text-muted-foreground">{f.filed.filename}</span>}
          </div>
          <p className="text-muted-foreground">IRS: {f.accepted_why}.</p>
          <Link className="text-primary hover:underline" to={`/app/compare/${entityId}?view=sources&year=${group.year}`}>
            Open {group.year}, every source side by side
          </Link>
        </div>
      )}
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
        // A filed amendment is a record of what was sent: its lines are locked.
        const amendFiled = r.source === 'amendment' && r.status === 'filed'
        const amendFiling = amendFiled ? group.filing?.amendments?.find(a => a.return_id === r.id) : undefined
        const canRecompute = (r.source === 'amendment' && !amendFiled) || r.source === 'proforma'
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
                {amendFiled && (
                  <Badge variant="outline" className={`text-xs ${SOURCE_VARIANT.filed_import}`}>Filed</Badge>
                )}
                {amendFiling && <AcceptedBadge filing={{ ...amendFiling, filed: true }} />}
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleLines(r.id)}
                  className="gap-1 text-xs h-7"
                  title="Show every IRS line recorded on this return"
                >
                  <ListOrdered className="h-3 w-3" />
                  {openLines.has(r.id) ? 'Hide lines' : 'View lines'}
                </Button>
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
                {r.source === 'amendment' && !amendFiled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRecordFiled(r)}
                    disabled={recordingFiled === r.id}
                    className="gap-1 text-xs h-7"
                    title="Upload the signed amended return you filed — the amendment is then recorded as filed and its lines lock"
                  >
                    {recordingFiled === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileCheck className="h-3 w-3" />}
                    Record as filed
                  </Button>
                )}
                {r.source === 'amendment' && !amendFiled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEditLines(r)}
                    className="gap-1 text-xs h-7"
                    title="Change the lines this amendment corrects"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit lines
                  </Button>
                )}
                {r.source === 'amendment' && (group.filed || group.filing?.filed) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCompareAmendment(r)}
                    className="gap-1 text-xs h-7"
                    title="This amendment beside the filed return and the books, line by line"
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
                      {/* Said "Stale shape — click Recompute (or Re-archive…)" on every
                          extension, which has no Recompute button and usually no
                          amounts at all (UI audit, 2026-10-22). */}
                      {r.source === 'extension'
                        ? 'No tax or payment amounts on this extension.'
                        : r.source === 'filed_import'
                          ? 'No line figures read from this filed return yet — Fill gaps reads them from the PDF.'
                          : 'No line figures on this return yet — Recompute fills them.'}
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
                {typeof gap.gaps_rejected === 'number' && gap.gaps_rejected > 0
                  ? ` · ${gap.gaps_rejected} rejected (not present in document)` : ''}
                {gap.model ? ` · ${gap.model}` : ''}
                {gap.error ? ` · error: ${gap.error}` : ''}
              </div>
            )}
            {r.source === 'amendment' && (
              <div className="mt-2 space-y-1 border-t pt-2">
                {(() => {
                  const base = (r.computed_data as { amendment_base?: { label?: string } } | undefined)?.amendment_base
                  return base?.label
                    ? <p className="text-xs text-muted-foreground">Started from {base.label}.</p>
                    : null
                })()}
                {amendFiled && (
                  <p className="text-xs text-muted-foreground" data-testid="amendment-filing">
                    Filed{amendFiling?.filed_at ? ` ${new Date(amendFiling.filed_at).toLocaleDateString()}` : ''}
                    {amendFiling?.copy?.filename ? ` — the copy on file is ${amendFiling.copy.filename} (Documents)` : ''}.
                    {amendFiling ? ` ${amendFiling.accepted ? 'Accepted' : 'Not accepted yet'}: ${amendFiling.accepted_why}.` : ''}
                    {' '}Its lines are locked; start a new amendment to change the return again.
                  </p>
                )}
                <BooksAgreement entityId={entityId} year={r.tax_year} returnId={r.id} />
              </div>
            )}
            {openLines.has(r.id) && <LineDetail ret={r} />}
          </div>
        )
      })}
    </div>
  )
}
