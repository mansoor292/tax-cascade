/**
 * The Group page: the account seen whole.
 *
 * Why (2026-10-19): the entity map, the review's open items and the version
 * sets' breaks were built API- and MCP-first (docs/RETURN_CATALOG_AND_
 * REVIEW.md §5–8) and reachable only through Claude; the owner asked whether
 * any of it was in the UI, and none was. This page shows all three from the
 * stored results. It never starts a review: recording links, running reviews
 * and building amendment packages stay with Claude, which holds the
 * reasoning for them. The one write here is confirming a relationship the
 * returns already show.
 */
import { useSearchParams } from 'react-router-dom'
import { Network } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import LoadError from '@/components/LoadError'
import { useEntityMap } from '@/hooks/use-entity-map'
import { useReviewSummary, useVersionSets } from '@/hooks/use-review'
import MapTab from './group/MapTab'
import BreaksTab from './group/BreaksTab'
import OpenItemsTab from './group/OpenItemsTab'

const TABS = ['map', 'breaks', 'open'] as const
type Tab = typeof TABS[number]

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <Card><CardContent className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
    </CardContent></Card>
  )
}

export default function Group() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? params.get('tab') as Tab : 'map'
  const map = useEntityMap()
  const summary = useReviewSummary()
  const versions = useVersionSets()

  const reloadAll = () => { map.reload(); summary.reload(); versions.reload() }
  const dash = <Skeleton className="h-7 w-10" />
  const filedBreaks = summary.data?.breaks.filed ?? 0

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Network className="h-6 w-6" />
            Group
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            How your entities connect, where the returns don't tie, and everything still open — from the latest review.
            Claude records links, runs reviews and builds amendment packages.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reloadAll}>Refresh</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Links recorded" value={map.data ? map.data.links.length : map.error ? '—' : dash} />
        <Tile label="Breaks in filed" value={summary.data ? filedBreaks : summary.error ? '—' : dash} tone={filedBreaks ? 'text-fuchsia-300' : ''} />
        <Tile label="Open items" value={summary.data ? summary.data.count : summary.error ? '—' : dash} />
        <Tile label="Open notes" value={summary.data ? summary.data.open_notes_count : summary.error ? '—' : dash} />
      </div>

      <Tabs value={tab} onValueChange={v => setParams({ tab: String(v) }, { replace: true })} className="space-y-4">
        <TabsList>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="breaks">Breaks</TabsTrigger>
          <TabsTrigger value="open">Open items</TabsTrigger>
        </TabsList>

        <TabsContent value="map">
          {map.loading ? <Skeleton className="h-72" />
            : map.error ? <LoadError message={`Couldn't load the entity map: ${map.error}`} onRetry={map.reload} />
            : map.data ? <MapTab map={map.data} onRecord={map.record} /> : null}
        </TabsContent>

        <TabsContent value="breaks">
          {versions.loading ? <Skeleton className="h-40" />
            : versions.error ? <LoadError message={`Couldn't load the amendment packages: ${versions.error}`} onRetry={versions.reload} />
            : <BreaksTab sets={versions.sets} />}
        </TabsContent>

        <TabsContent value="open">
          {summary.loading ? <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
            : summary.error ? <LoadError message={`Couldn't load the open items: ${summary.error}`} onRetry={summary.reload} />
            : summary.data ? <OpenItemsTab summary={summary.data} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}
