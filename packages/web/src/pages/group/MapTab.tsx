/**
 * The entity map as a picture and as the lists behind it: who owns what,
 * how the businesses deal with each other, and what a change to each return
 * reaches. Read-only except for one act: recording a relationship the
 * returns already show but nobody has confirmed (an "unrecorded" suggestion).
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronRight, Loader2, Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { FORM_TYPE_LABEL, LINK_NATURE_LABEL, LINK_SOURCE_LABEL } from '@/lib/labels'
import { maskTaxIdsInText } from '@/lib/mask'
import type { EntityMap, LinkSuggestion, MapLink } from '@/hooks/use-entity-map'
import { buildGraph, fit, spanText, yearsText } from './graph'

const EDGE_STYLE = {
  owns: { className: 'stroke-sky-400/70', dash: undefined },
  intercompany: { className: 'stroke-amber-400/80', dash: '6 4' },
  disregarded: { className: 'stroke-muted-foreground', dash: '2 4' },
} as const

const KIND_LABEL: Record<string, string> = { owns: 'Ownership', intercompany: 'Intercompany', disregarded: 'Disregarded' }

function MapGraph({ map }: { map: EntityMap }) {
  const g = useMemo(() => buildGraph(map), [map])
  const navigate = useNavigate()
  if (!g.nodes.length) return <p className="text-sm text-muted-foreground py-6 text-center">No entities in this account yet.</p>
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${g.width} ${g.height}`} className="w-full min-w-[640px] h-auto" role="img" aria-label="Entity map">
        {g.edges.map(e => (
          <g key={e.key} data-kind={e.kind}>
            <path d={e.path} fill="none" strokeWidth={1.75} strokeDasharray={EDGE_STYLE[e.kind].dash} className={EDGE_STYLE[e.kind].className} />
            <text x={e.lx} y={e.ly} textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-[11px]"
              stroke="var(--card)" strokeWidth={5} paintOrder="stroke">{e.label}</text>
          </g>
        ))}
        {g.nodes.map(n => (
          <g key={n.key} onClick={n.entityId ? () => navigate(`/app/entities/${n.entityId}`) : undefined}
            className={n.entityId ? 'cursor-pointer' : ''} data-node={n.label}>
            <title>{n.label}</title>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={8} strokeWidth={1}
              strokeDasharray={n.row === 2 ? '4 3' : undefined}
              className={n.row === 0 ? 'fill-sky-500/10 stroke-sky-500/40' : 'fill-card stroke-border'} />
            <text x={n.x + n.w / 2} y={n.y + 21} textAnchor="middle" className="fill-foreground text-[13px] font-medium">{fit(n.label, n.w)}</text>
            <text x={n.x + n.w / 2} y={n.y + 39} textAnchor="middle" className="fill-muted-foreground text-[11px]">{fit(n.sub, n.w, 6)}</text>
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground mt-2">
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-sky-400/70" /> owns</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-dashed border-amber-400/80" /> deals with</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-dotted border-muted-foreground" /> disregarded into</span>
        <span>Click an entity to open it.</span>
        <span className="sm:hidden">Scroll sideways to see the whole map.</span>
      </div>
    </div>
  )
}

function linkWhat(l: MapLink): string {
  if (l.kind === 'owns') return `${l.subject ? `${l.subject} · ` : ''}${l.pct !== null ? `${l.pct}%` : 'share not recorded'}`
  if (l.kind === 'intercompany') return LINK_NATURE_LABEL[l.nature ?? 'other'] ?? l.nature ?? ''
  return 'reported on the owner\'s return'
}

function LinkRow({ l }: { l: MapLink }) {
  const [open, setOpen] = useState(false)
  const more = !!(l.evidence || l.detail)
  return (
    <div className="border-b last:border-0" data-testid="map-link">
      <button type="button" disabled={!more} onClick={() => setOpen(o => !o)} className="w-full text-left flex items-start gap-2 py-2.5 px-1 rounded-sm hover:bg-muted/30 disabled:hover:bg-transparent">
        <ChevronRight className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''} ${more ? '' : 'opacity-0'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">{KIND_LABEL[l.kind]}</Badge>
            <span className="text-sm font-medium">{l.from_entity_name}</span>
            <span className="text-muted-foreground">→</span>
            <span className="text-sm font-medium">{l.to_entity_name}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {linkWhat(l)} · {spanText(l.from_year, l.to_year)} · {LINK_SOURCE_LABEL[l.source] ?? l.source}
          </div>
        </div>
      </button>
      {open && (
        <div className="pl-7 pr-2 pb-3 space-y-2 text-sm">
          {l.detail && <p className="text-muted-foreground whitespace-pre-line">{maskTaxIdsInText(l.detail)}</p>}
          {l.evidence && <p className="text-xs text-muted-foreground"><span className="uppercase tracking-wide">Evidence: </span>{maskTaxIdsInText(l.evidence)}</p>}
        </div>
      )}
    </div>
  )
}

function suggestionText(s: LinkSuggestion): string {
  const to = s.to_entity_name ?? s.to_name ?? ''
  if (s.kind === 'owns') return `${s.subject ?? s.from_entity_name} owns ${s.pct !== null ? `${s.pct}% of ` : ''}${to}`
  if (s.kind === 'disregarded') return `${to} is disregarded into ${s.from_entity_name}`
  return `${s.from_entity_name} and ${to}: ${LINK_NATURE_LABEL[s.nature ?? 'other'] ?? s.nature}`
}

function Unrecorded({ items, onRecord }: { items: LinkSuggestion[]; onRecord: (s: LinkSuggestion) => Promise<void> }) {
  const [busy, setBusy] = useState<number | null>(null)
  if (!items.length) {
    return (
      <p className="text-sm text-muted-foreground flex items-center gap-1.5" data-testid="all-recorded">
        <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Every relationship the returns show is recorded.
      </p>
    )
  }
  const record = async (s: LinkSuggestion, i: number) => {
    setBusy(i)
    try {
      await onRecord(s)
      toast.success('Recorded')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record it')
    }
    setBusy(null)
  }
  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">The returns show {items.length} {items.length === 1 ? 'relationship' : 'relationships'} nobody has recorded</CardTitle>
        <p className="text-sm text-muted-foreground">Until one is recorded, the review can't check it. Record it as it stands, or ask Claude to record it with the right details.</p>
      </CardHeader>
      <CardContent>
        {items.map((s, i) => (
          <div key={i} className="flex items-start gap-3 py-2 border-b last:border-0" data-testid="unrecorded-link">
            <div className="flex-1 min-w-0">
              <div className="text-sm">{suggestionText(s)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {s.years.length ? `${yearsText(s.years)} · ` : ''}{LINK_SOURCE_LABEL[s.source] ?? s.source}
                {s.evidence.length ? ` · ${maskTaxIdsInText(s.evidence.join('; '))}` : ''}
              </div>
            </div>
            <Button size="sm" variant="outline" className="gap-1 shrink-0" disabled={busy !== null} onClick={() => record(s, i)}>
              {busy === i ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Record
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export default function MapTab({ map, onRecord }: { map: EntityMap; onRecord: (s: LinkSuggestion) => Promise<void> }) {
  const order = (f: string) => (f === '1040' ? 0 : 1)
  const entities = [...map.entities].sort((a, b) => order(a.form_type) - order(b.form_type) || a.name.localeCompare(b.name))
  const kindOrder = { owns: 0, disregarded: 1, intercompany: 2 } as const
  const links = [...map.links].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.from_entity_name ?? '').localeCompare(b.from_entity_name ?? ''))
  return (
    <div className="space-y-4">
      <Unrecorded items={map.unrecorded} onRecord={onRecord} />

      <Card>
        <CardContent className="pt-4">
          <MapGraph map={map} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recorded links</CardTitle>
          <p className="text-sm text-muted-foreground">Each with the years it covers and where it came from. Open one for the evidence.</p>
        </CardHeader>
        <CardContent>
          {links.length ? links.map(l => <LinkRow key={l.link_key} l={l} />) : <p className="text-sm text-muted-foreground">No links recorded yet. Claude records them as it reads the returns (record_link).</p>}
          {map.removed_links.length > 0 && <p className="text-xs text-muted-foreground mt-2">{map.removed_links.length} retired {map.removed_links.length === 1 ? 'link' : 'links'} kept in the history.</p>}
        </CardContent>
      </Card>

      <div>
        <h3 className="text-base font-semibold mb-1">What a change to each return reaches</h3>
        <p className="text-sm text-muted-foreground mb-3">Amend one of these and the returns listed under it have to be looked at too.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {entities.map(e => (
            <Card key={e.id} data-testid="touches">
              <CardContent className="pt-4 space-y-2">
                <div>
                  <div className="font-medium">{e.name}</div>
                  <div className="text-xs text-muted-foreground">{FORM_TYPE_LABEL[e.form_type] ?? e.form_type}{e.years.length ? ` · filed ${yearsText(e.years)}` : ' · no filed returns here'}</div>
                </div>
                {e.touches.length ? (
                  <ul className="space-y-1.5">
                    {e.touches.map(t => (
                      <li key={`${t.link_key}-${t.via}`} className="text-sm">
                        <span className="font-medium">{t.name ?? 'Unknown'}</span>
                        <span className="text-muted-foreground"> · {t.via}</span>
                        <div className="text-xs text-muted-foreground">{t.effect}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing recorded links this return to another.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
