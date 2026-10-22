/**
 * One review item (a finding, gap or break) as a row that opens to its
 * detail. Every piece of text goes through maskTaxIdsInText: the review's
 * evidence quotes return headers, EINs included (lib/mask.ts).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { fmtDate, fmtMoney } from '@/lib/format'
import { SEVERITY_LABEL } from '@/lib/labels'
import { maskTaxIdsInText } from '@/lib/mask'
import type { Evidence, Severity } from '@/hooks/use-review'
import { factQuestion } from './graph'

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: 'bg-red-500/25 text-red-300 border-red-500/50',
  high: 'bg-red-500/15 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  low: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  info: 'bg-muted text-muted-foreground',
}

const STATUS_LABEL: Record<string, string> = { finding: 'Finding', gap: 'Needs an answer', error: 'Check failed' }

export interface RowItem {
  severity: Severity
  title: string
  detail?: string | null
  status?: string
  tie?: boolean
  version_set?: string
  entity_id?: string
  tax_year?: number | null
  dollar_effect?: number | null
  deadline?: string | null
  asks?: string[]
  evidence?: Evidence[] | null
}

export function ItemRow({ item, showYear = false, badge }: { item: RowItem; showYear?: boolean; badge?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const evidence = (item.evidence ?? []).filter(e => e && typeof e.where === 'string')
  return (
    <div className="border-b last:border-0" data-testid="review-item">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full text-left flex items-start gap-2 py-2.5 hover:bg-muted/30 rounded-sm px-1">
        <ChevronRight className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className={`${SEVERITY_STYLE[item.severity] ?? ''} text-xs`}>{SEVERITY_LABEL[item.severity] ?? item.severity}</Badge>
            {item.tie && <Badge variant="outline" className="text-xs border-fuchsia-500/40 text-fuchsia-300">Break</Badge>}
            {item.version_set && <Badge variant="outline" className="text-xs">{item.version_set}</Badge>}
            {item.status && item.status !== 'finding' && <Badge variant="outline" className="text-xs">{STATUS_LABEL[item.status] ?? item.status}</Badge>}
            {showYear && item.tax_year ? <span className="text-xs text-muted-foreground">{item.tax_year}</span> : null}
            {badge}
          </div>
          <div className="text-sm mt-1">{maskTaxIdsInText(item.title)}</div>
          {(typeof item.dollar_effect === 'number' && item.dollar_effect !== 0) || item.deadline ? (
            <div className="text-xs text-muted-foreground mt-0.5">
              {typeof item.dollar_effect === 'number' && item.dollar_effect !== 0 && <>Dollar effect {fmtMoney(Math.round(item.dollar_effect))}</>}
              {typeof item.dollar_effect === 'number' && item.dollar_effect !== 0 && item.deadline && ' · '}
              {item.deadline && <>Deadline {fmtDate(item.deadline)}</>}
            </div>
          ) : null}
        </div>
      </button>
      {open && (
        <div className="pl-7 pr-2 pb-3 space-y-2 text-sm">
          {item.detail && <p className="text-muted-foreground whitespace-pre-line">{maskTaxIdsInText(item.detail)}</p>}
          {!!item.asks?.length && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Questions it needs answered</div>
              <ul className="list-disc pl-5 space-y-0.5">{item.asks.map(a => <li key={a}>{factQuestion(a)}</li>)}</ul>
            </div>
          )}
          {!!evidence.length && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Evidence</div>
              <ul className="space-y-0.5 text-xs text-muted-foreground">{evidence.map((e, i) => <li key={i}>{maskTaxIdsInText(e.where)}</li>)}</ul>
            </div>
          )}
          {/* A break or open item was a dead end: it explained itself but
              led nowhere (UI audit, 2026-10-22). It now opens the year it is
              about, every source side by side, and the entity's returns. */}
          {item.entity_id && (
            <div className="flex gap-3 text-xs pt-1">
              {item.tax_year ? (
                <Link className="text-primary hover:underline" to={`/app/compare/${item.entity_id}?view=sources&year=${item.tax_year}`}>
                  Open {item.tax_year}, every source side by side
                </Link>
              ) : null}
              <Link className="text-primary hover:underline" to={`/app/entities/${item.entity_id}`}>Open the entity's returns</Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
