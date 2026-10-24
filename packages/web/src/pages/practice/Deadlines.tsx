/**
 * Practice → Deadlines: what is due across every client, soonest first — the
 * preparer's other starting page (docs/USER_PERSONAS.md P2 J1). Read from the
 * calendar engine's obligations for the practice's entities.
 */
import { Link, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { CalendarResponse } from '@/hooks/use-calendar'
import { usePracticeClients } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { PageHeader, Pill } from '@/components/ds'
import { usePracticeCtx } from './PracticeLayout'

export default function Deadlines() {
  const { practice } = usePracticeCtx()
  const { clients } = usePracticeClients()
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nav = useNavigate()
  const load = useCallback(async () => {
    setError(null)
    try { setData(await api<CalendarResponse>('/api/calendar?workspace=practice&within_days=120')) } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load deadlines') }
  }, [])
  useEffect(() => { load() }, [load])
  const clientOf = new Map(clients.map(c => [c.entity_id, c.id]))
  // Before a client was added the calendar cannot know what was filed; show
  // what is still ahead and anything overdue within the last quarter.
  const rows = (data?.obligations ?? []).filter(o => o.days_until >= -90 && o.urgency !== 'unverified')

  return (
    <>
      <PageHeader crumb={practice.name} title="Deadlines" />
      {error ? <LoadError message={error} onRetry={load} /> : (
        <div className="ds-card overflow-hidden">
          <div className="flex flex-wrap gap-2 px-3 py-2 border-b">
            <Pill tone="bad">Overdue {rows.filter(r => r.urgency === 'overdue').length}</Pill>
            <Pill tone="warn">Next 14 days {rows.filter(r => r.days_until >= 0 && r.days_until <= 14).length}</Pill>
            <Pill tone="mute">Next 120 days {rows.filter(r => r.days_until >= 0).length}</Pill>
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead><tr><th>Due</th><th>Client</th><th>Return or payment</th><th>Where it stands</th></tr></thead>
              <tbody>
                {!data ? <tr><td colSpan={4} className="text-muted-foreground">Loading…</td></tr> : !rows.length ? <tr><td colSpan={4} className="text-muted-foreground">Nothing due in the next 120 days.</td></tr> : rows.map(o => {
                  const cid = clientOf.get(o.entity_id)
                  const to = cid ? `/app/practice/clients/${cid}` : `/app/entities/${o.entity_id}`
                  return (
                    <tr key={o.id} className="clickable" onClick={() => nav(to)}>
                      <td className={`num ${o.urgency === 'overdue' ? 'text-bad font-semibold' : ''}`}>{new Date(o.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</td>
                      <td><Link className="ds-rowlink" onClick={e => e.stopPropagation()} to={to}>{o.tax_entity?.name}</Link></td>
                      <td>{o.title}</td>
                      <td>{o.urgency === 'overdue' ? <Pill tone="bad">Overdue</Pill> : o.urgency === 'due_soon' ? <Pill tone="warn">Due soon</Pill> : o.status === 'done' ? <Pill tone="good">Done</Pill> : <Pill tone="mute">Upcoming</Pill>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
