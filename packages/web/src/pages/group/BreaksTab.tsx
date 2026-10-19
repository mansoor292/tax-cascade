/**
 * Breaks: the places a set of returns does not tie (docs/RETURN_CATALOG_AND_
 * REVIEW.md §8). "Filed" is every return as filed with the IRS; each draft
 * package (v1, v2 …) is the filed returns with its amendments applied, and
 * shows what it breaks, what it carries over unchanged, and what it fixes.
 * This reads the last review of each view; running one is Claude's job
 * (review_version_set), because a run of the filed view takes minutes.
 */
import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import LoadError from '@/components/LoadError'
import { fmtDate } from '@/lib/format'
import { useBreaks, type BreakItem, type VersionSet } from '@/hooks/use-review'
import { groupByEntityYear } from './graph'
import { ItemRow } from './ItemRow'

function Grouped({ items, empty }: { items: BreakItem[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="space-y-4">
      {groupByEntityYear(items).map(g => (
        <div key={g.entity_id}>
          <div className="text-sm font-semibold mb-1">{g.entity}</div>
          {g.years.map(y => (
            <div key={y.year ?? 'none'} className="pl-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mt-2">{y.year}</div>
              {y.items.map(b => <ItemRow key={b.fingerprint} item={{ ...b, tie: true }} />)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Section({ title, hint, tone, children }: { title: string; hint: string; tone?: string; children: React.ReactNode }) {
  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export default function BreaksTab({ sets }: { sets: VersionSet[] }) {
  const drafts = sets.filter(s => s.status === 'draft')
  const filedSets = sets.filter(s => s.status === 'filed')
  const [view, setView] = useState('filed')
  const { data, loading, error, reload } = useBreaks(view)
  const current = drafts.find(s => s.label === view)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which set of returns">
        <Button size="sm" variant={view === 'filed' ? 'default' : 'outline'} onClick={() => setView('filed')}>Filed</Button>
        {drafts.map(s => (
          <Button key={s.label} size="sm" variant={view === s.label ? 'default' : 'outline'} onClick={() => setView(s.label)}>
            {s.label}{s.title ? ` · ${s.title}` : ''}
          </Button>
        ))}
        {!drafts.length && <span className="text-xs text-muted-foreground">No amendment packages in progress.</span>}
      </div>
      {filedSets.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Filed packages, now part of “Filed”: {filedSets.map(s => `${s.label}${s.filed_on ? ` (${fmtDate(s.filed_on)})` : ''}`).join(', ')}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : error ? (
        <LoadError message={`Couldn't load the breaks: ${error}`} onRetry={reload} />
      ) : !data ? null : data.reviewed_returns === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="breaks-not-reviewed">
          {view === 'filed'
            ? 'No return has been reviewed yet, so nothing has been checked for breaks.'
            : `Package ${view} hasn't been reviewed yet. Ask Claude to review it (review_version_set ${view}).`}
        </CardContent></Card>
      ) : view === 'filed' ? (
        <Section
          title={data.ties ? 'Every filed return ties' : `${data.breaks_count} ${data.breaks_count === 1 ? 'break' : 'breaks'} in the returns as filed`}
          hint={`From the last review of ${data.reviewed_returns} filed ${data.reviewed_returns === 1 ? 'return' : 'returns'}: figures that must agree within a return, year to year, or between the returns of related entities.`}
          tone={data.ties ? 'border-emerald-500/30' : 'border-fuchsia-500/30'}>
          {data.ties
            ? <p className="text-sm flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> Nothing to fix.</p>
            : <Grouped items={data.breaks ?? []} empty="" />}
        </Section>
      ) : (
        <div className="space-y-4">
          {current?.description && <p className="text-sm text-muted-foreground">{current.description}</p>}
          <Section title={`New breaks (${data.new_breaks?.length ?? 0})`} tone={data.new_breaks?.length ? 'border-red-500/30' : 'border-emerald-500/30'}
            hint="Breaks this package causes or exposes. It isn't ready to file while any are left.">
            <Grouped items={data.new_breaks ?? []} empty="None — the package adds no breaks." />
          </Section>
          <Section title={`Fixes (${data.fixes?.length ?? 0})`} hint="Breaks in the filed returns this package clears.">
            <Grouped items={data.fixes ?? []} empty="It fixes none of the filed breaks." />
          </Section>
          <Section title={`Carried over from filed (${data.inherited_breaks?.length ?? 0})`} hint="Breaks already in the filed returns that this package leaves as they are.">
            <Grouped items={data.inherited_breaks ?? []} empty="None." />
          </Section>
        </div>
      )}
    </div>
  )
}
