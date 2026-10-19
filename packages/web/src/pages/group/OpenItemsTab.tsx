/**
 * Everything to act on, across every entity and year: the review's open
 * findings and gaps (breaks among them), the return notes no check can see,
 * and the questions waiting on the owner — the same closed list Claude reads
 * through review_summary, so the page and the conversation never disagree.
 */
import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmtDate } from '@/lib/format'
import { maskTaxIdsInText } from '@/lib/mask'
import type { ReturnNote, ReviewSummary } from '@/hooks/use-review'
import { factQuestion, groupByEntityYear } from './graph'
import { ItemRow } from './ItemRow'

type Kind = 'all' | 'breaks' | 'findings' | 'gaps'
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'breaks', label: 'Breaks' },
  { value: 'findings', label: 'Findings' },
  { value: 'gaps', label: 'Needs an answer' },
]

function NoteRow({ n }: { n: ReturnNote }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b last:border-0" data-testid="open-note">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full text-left flex items-start gap-2 py-2.5 px-1 rounded-sm hover:bg-muted/30">
        <ChevronRight className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {n.waiting_on && <Badge variant="outline" className="text-xs">Waiting on {n.waiting_on}</Badge>}
            {n.due_date && <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/30">Due {fmtDate(n.due_date)}</Badge>}
            <span className="text-xs text-muted-foreground">{n.entity}{n.tax_year ? ` · ${n.tax_year}` : ''}</span>
          </div>
          <div className="text-sm mt-1">{maskTaxIdsInText(n.title)}</div>
        </div>
      </button>
      {open && n.body && <p className="pl-7 pr-2 pb-3 text-sm text-muted-foreground whitespace-pre-line">{maskTaxIdsInText(n.body)}</p>}
    </div>
  )
}

export default function OpenItemsTab({ summary }: { summary: ReviewSummary }) {
  const [entity, setEntity] = useState<string>('all')
  const [kind, setKind] = useState<Kind>('all')

  const entities = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>()
    for (const i of summary.items) {
      const e = m.get(i.entity_id) ?? { id: i.entity_id, name: i.entity, count: 0 }
      e.count++
      m.set(i.entity_id, e)
    }
    for (const n of summary.open_notes) if (!m.has(n.entity_id)) m.set(n.entity_id, { id: n.entity_id, name: n.entity ?? '', count: 0 })
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [summary])

  const items = summary.items.filter(i =>
    (entity === 'all' || i.entity_id === entity) &&
    (kind === 'all' || (kind === 'breaks' && i.tie && i.status === 'finding') || (kind === 'findings' && i.status === 'finding') || (kind === 'gaps' && i.status === 'gap')))
  const notes = summary.open_notes.filter(n => entity === 'all' || n.entity_id === entity)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Entity">
        <Button size="sm" variant={entity === 'all' ? 'default' : 'outline'} onClick={() => setEntity('all')}>All entities ({summary.items.length})</Button>
        {entities.map(e => (
          <Button key={e.id} size="sm" variant={entity === e.id ? 'default' : 'outline'} onClick={() => setEntity(e.id)}>{e.name} ({e.count})</Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Kind">
        {KINDS.map(k => (
          <Button key={k.value} size="sm" variant={kind === k.value ? 'secondary' : 'ghost'} onClick={() => setKind(k.value)}>{k.label}</Button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{items.length} open {items.length === 1 ? 'item' : 'items'}</CardTitle>
          <p className="text-sm text-muted-foreground">From each return's latest review, most severe first. Open one for the detail, the evidence and what it needs answered.</p>
        </CardHeader>
        <CardContent>
          {!items.length ? (
            <p className="text-sm text-muted-foreground" data-testid="no-open-items">
              {summary.items.length ? 'Nothing open matches this filter.' : 'Nothing open. Either every reviewed return passed, or no return has been reviewed yet.'}
            </p>
          ) : (
            <div className="space-y-4">
              {groupByEntityYear(items).map(g => (
                <div key={g.entity_id}>
                  <div className="text-sm font-semibold mb-1">{g.entity}</div>
                  {g.years.map(y => (
                    <div key={y.year ?? 'none'} className="pl-2">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground mt-2">{y.year ?? 'Every year'}</div>
                      {y.items.map(i => <ItemRow key={`${i.version_set ?? ''}${i.fingerprint}`} item={i} />)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Open notes ({notes.length})</CardTitle>
          <p className="text-sm text-muted-foreground">Threads no check can see: decisions waiting on someone, letters to send, things to confirm.</p>
        </CardHeader>
        <CardContent>
          {notes.length ? notes.map(n => <NoteRow key={n.note_key} n={n} />) : <p className="text-sm text-muted-foreground">No open notes.</p>}
        </CardContent>
      </Card>

      {entity === 'all' && summary.facts_to_ask.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Questions for the owner ({summary.facts_to_ask.length})</CardTitle>
            <p className="text-sm text-muted-foreground">Answers the review needs before it can finish some checks.</p>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 space-y-1 text-sm">{summary.facts_to_ask.map(k => <li key={k}>{factQuestion(k)}</li>)}</ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
