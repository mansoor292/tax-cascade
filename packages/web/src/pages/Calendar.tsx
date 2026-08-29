import { useState } from 'react'
import { AlertTriangle, CalendarClock, Check, CircleSlash, Loader2, RotateCcw } from 'lucide-react'
import { useCalendar, type Obligation, type Urgency } from '@/hooks/use-calendar'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'

const URGENCY_STYLE: Record<Urgency, { label: string; className: string }> = {
  overdue:   { label: 'Overdue',   className: 'bg-red-500/15 text-red-400 border-red-500/30' },
  // The deadline passed before this entity existed here, so whether it was met
  // is not something we know. Saying "overdue" would be asserting it was not.
  unverified: { label: 'Needs confirming', className: 'bg-sky-500/15 text-sky-400 border-sky-500/30' },
  due_soon:  { label: 'Due soon',  className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  upcoming:  { label: 'Upcoming',  className: 'bg-muted text-muted-foreground' },
  done:      { label: 'Done',      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  dismissed: { label: 'N/A',       className: 'bg-muted text-muted-foreground' },
}

const KIND_LABEL: Record<string, string> = {
  return: 'Return',
  extension: 'Extension',
  estimated_payment: 'Estimated',
  annual_report: 'Annual report',
  state_return: 'State return',
  other: 'Other',
}

function whenText(o: Obligation): string {
  const d = o.days_until
  if (o.status === 'done') return 'Filed'
  if (d === 0) return 'Due today'
  if (d < 0) return `${Math.abs(d)} ${Math.abs(d) === 1 ? 'day' : 'days'} overdue`
  return `in ${d} ${d === 1 ? 'day' : 'days'}`
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

function ObligationRow({ o, onUpdate }: { o: Obligation; onUpdate: (id: string, patch: any) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const style = URGENCY_STYLE[o.urgency]
  const muted = o.status !== 'pending'

  const act = async (status: 'done' | 'dismissed' | 'pending') => {
    setBusy(true)
    try {
      await onUpdate(o.id, { status })
      toast.success(status === 'pending' ? 'Reopened' : status === 'done' ? 'Marked filed' : 'Marked not applicable')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    }
    setBusy(false)
  }

  return (
    <div className={`flex items-start gap-3 py-3 border-b last:border-0 ${muted ? 'opacity-50' : ''}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{o.title}</span>
          <Badge variant="outline" className="text-xs">{KIND_LABEL[o.kind] || o.kind}</Badge>
          {o.jurisdiction === 'FL' && <Badge variant="outline" className="text-xs">Florida</Badge>}
          {o.extended && <Badge variant="outline" className="text-xs">Extended</Badge>}
        </div>
        <div className="text-sm text-muted-foreground mt-0.5">
          {o.tax_entity?.name}
          {' · '}{fmtDate(o.due_date)}
          {' · '}<span className={o.urgency === 'overdue' ? 'text-red-400' : ''}>{whenText(o)}</span>
        </div>
        {o.meta?.note && (
          <p className="text-xs text-amber-400/80 mt-1 flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            {o.meta.note}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Badge variant="outline" className={`${style.className} text-xs`}>{style.label}</Badge>
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin mx-2" />
        ) : o.status === 'pending' ? (
          <>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Mark filed" onClick={() => act('done')}>
              <Check className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Not applicable" onClick={() => act('dismissed')}>
              <CircleSlash className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Reopen" onClick={() => act('pending')}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

const Section = ({ title, items, onUpdate }: {
  title: string
  items: Obligation[]
  onUpdate: (id: string, patch: any) => Promise<void>
}) =>
  items.length === 0 ? null : (
    <Card>
      <CardContent className="p-4">
        <h3 className="text-sm uppercase tracking-wide text-muted-foreground mb-2">
          {title} <span className="ml-1 font-mono">{items.length}</span>
        </h3>
        <div>{items.map(o => <ObligationRow key={o.id} o={o} onUpdate={onUpdate} />)}</div>
      </CardContent>
    </Card>
  )

export default function Calendar() {
  const { data, loading, reload, update } = useCalendar()
  const [showCompleted, setShowCompleted] = useState(false)

  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
  }

  const all = data?.obligations || []
  const pending = all.filter(o => o.status === 'pending')
  const completed = all.filter(o => o.status !== 'pending')

  const overdue = pending.filter(o => o.urgency === 'overdue')
  const unverified = pending.filter(o => o.urgency === 'unverified')
  const dueSoon = pending.filter(o => o.urgency === 'due_soon')
  const upcoming = pending.filter(o => o.urgency === 'upcoming')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <CalendarClock className="h-6 w-6" />
            Calendar
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Filing and payment deadlines across every entity. Generated from the entity's
            form type, state and filed extensions — no data entry.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}>Refresh</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardContent className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Overdue</div>
          <div className={`text-2xl font-semibold ${overdue.length ? 'text-red-400' : ''}`}>{overdue.length}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Needs confirming</div>
          <div className={`text-2xl font-semibold ${unverified.length ? 'text-sky-400' : ''}`}>{unverified.length}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Next 30 days</div>
          <div className={`text-2xl font-semibold ${dueSoon.length ? 'text-amber-400' : ''}`}>{dueSoon.length}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Next up</div>
          <div className="text-2xl font-semibold">
            {pending.length ? whenText(pending[0]) : '—'}
          </div>
        </CardContent></Card>
      </div>

      {pending.length === 0 && (
        <Card className="border-dashed"><CardContent className="py-12 text-center text-sm text-muted-foreground">
          Nothing outstanding. Add an entity to generate its calendar.
        </CardContent></Card>
      )}

      <Section title="Overdue" items={overdue} onUpdate={update} />
      {unverified.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm uppercase tracking-wide text-muted-foreground mb-1">
              Needs confirming <span className="ml-1 font-mono">{unverified.length}</span>
            </h3>
            <p className="text-xs text-muted-foreground mb-2">
              These fell due before this entity was added, so we don't know whether they
              were handled. Mark each one done or not applicable and it will stop asking.
            </p>
            <div>{unverified.map(o => <ObligationRow key={o.id} o={o} onUpdate={update} />)}</div>
          </CardContent>
        </Card>
      )}
      <Section title="Due soon" items={dueSoon} onUpdate={update} />
      <Section title="Upcoming" items={upcoming} onUpdate={update} />

      {completed.length > 0 && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowCompleted(!showCompleted)}>
            {showCompleted ? 'Hide' : 'Show'} filed and not-applicable ({completed.length})
          </Button>
          {showCompleted && <div className="mt-2"><Section title="Closed" items={completed} onUpdate={update} /></div>}
        </div>
      )}
    </div>
  )
}
