/**
 * Pure helpers for the Group page — the map layout above all — so they are tested
 * without a browser.
 *
 * Three rows, because the relationships in a small group run in one
 * direction: the people (their 1040s) at the top, the businesses in the
 * middle, and names outside the account (a disregarded LLC, a counterparty
 * with no return here) at the bottom. Ownership runs downward from the top
 * row; intercompany dealings between two businesses arc under the middle row,
 * one arc per pair however many kinds of dealing it carries (services and a
 * running balance are one relationship to look at, not two lines).
 */
import type { EntityMap, LinkKind, MapLink } from '@/hooks/use-entity-map'
import { getFactDef } from '@taxengine/shared'
import { FORM_TYPE_LABEL, LINK_NATURE_LABEL } from '@/lib/labels'

export const GRAPH_WIDTH = 960
const BOX_H = 52
const ROW_GAP: Record<0 | 1 | 2, number> = { 0: 104, 1: 128, 2: 0 }

export interface GraphNode {
  key: string
  label: string
  sub: string
  row: 0 | 1 | 2
  x: number
  y: number
  w: number
  h: number
  entityId: string | null
}

export interface GraphEdge {
  key: string
  kind: LinkKind
  label: string
  path: string
  lx: number
  ly: number
}

const outsideKey = (name: string | null) => `outside:${(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`

/** "2025", "2022–2025" for a run of years, else a list. */
export function yearsText(years: number[]): string {
  const ys = [...new Set(years)].sort((a, b) => a - b)
  if (!ys.length) return ''
  if (ys.length === 1) return String(ys[0])
  const contiguous = ys.every((y, i) => i === 0 || y === ys[i - 1] + 1)
  return contiguous ? `${ys[0]}–${ys[ys.length - 1]}` : ys.join(', ')
}

/** A link's years: "2022 on", "2022–2024", "through 2024", "all years". */
export function spanText(from: number | null, to: number | null): string {
  if (from && to) return from === to ? String(from) : `${from}–${to}`
  if (from) return `${from} on`
  if (to) return `through ${to}`
  return 'all years'
}

/** Shorten to what fits a box, by an average character width. */
export function fit(text: string, width: number, charW = 7): string {
  const max = Math.max(4, Math.floor((width - 16) / charW))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function buildGraph(map: EntityMap, width = GRAPH_WIDTH): { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number } {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const people = map.entities.filter(e => e.form_type === '1040').sort(byName)
  const businesses = map.entities.filter(e => e.form_type !== '1040').sort(byName)
  const outside = new Map<string, string>()
  for (const l of map.links) if (!l.to_entity_id && l.to_name) outside.set(outsideKey(l.to_name), l.to_name)

  const rows: Array<{ row: 0 | 1 | 2; items: Array<{ key: string; label: string; sub: string; entityId: string | null }> }> = [
    { row: 0 as const, items: people.map(e => ({ key: e.id, label: e.name, sub: `${FORM_TYPE_LABEL[e.form_type] ?? e.form_type}${e.years.length ? ` · filed ${yearsText(e.years)}` : ''}`, entityId: e.id })) },
    { row: 1 as const, items: businesses.map(e => ({ key: e.id, label: e.name, sub: `${FORM_TYPE_LABEL[e.form_type] ?? e.form_type} · ${e.years.length ? `filed ${yearsText(e.years)}` : 'no filed returns here'}`, entityId: e.id })) },
    { row: 2 as const, items: [...outside.entries()].map(([key, name]) => ({ key, label: name, sub: 'outside this account', entityId: null })) },
  ].filter(r => r.items.length)

  const nodes: GraphNode[] = []
  let y = 24
  for (const r of rows) {
    const slot = width / r.items.length
    const w = Math.min(220, slot - 24)
    r.items.forEach((it, i) => nodes.push({ ...it, row: r.row, x: slot * i + (slot - w) / 2, y, w, h: BOX_H }))
    y += BOX_H + ROW_GAP[r.row]
  }
  const node = (k: string | null) => nodes.find(n => n.key === k)
  const midX = (n: GraphNode) => n.x + n.w / 2

  const edges: GraphEdge[] = []
  const straight = (key: string, kind: LinkKind, a: GraphNode, b: GraphNode, label: string, at = 0.5) => {
    const [x1, y1, x2, y2] = a.row < b.row ? [midX(a), a.y + a.h, midX(b), b.y] : [midX(a), a.y, midX(b), b.y + b.h]
    edges.push({ key, kind, label, path: `M ${x1} ${y1} L ${x2} ${y2}`, lx: x1 + (x2 - x1) * at, ly: y1 + (y2 - y1) * at })
  }
  const arc = (key: string, kind: LinkKind, a: GraphNode, b: GraphNode, label: string, below: boolean) => {
    const yy = below ? a.y + a.h : a.y
    const bend = below ? 70 : -70
    edges.push({ key, kind, label, path: `M ${midX(a)} ${yy} Q ${(midX(a) + midX(b)) / 2} ${yy + bend} ${midX(b)} ${yy}`, lx: (midX(a) + midX(b)) / 2, ly: yy + bend / 2 + (below ? 4 : -2) })
  }
  const target = (l: MapLink) => node(l.to_entity_id ?? outsideKey(l.to_name))

  for (const l of map.links.filter(x => x.kind === 'owns')) {
    const a = node(l.from_entity_id)
    const b = target(l)
    if (!a || !b) continue
    const who = l.subject ? `${l.subject.split(/\s+/)[0]} ` : ''
    const label = `${who}${l.pct !== null ? `${l.pct}%` : 'owns'}`
    if (a.row === b.row) arc(l.link_key, 'owns', a, b, label, false)
    else straight(l.link_key, 'owns', a, b, label, 0.62)
  }

  const pairs = new Map<string, { a: GraphNode; b: GraphNode; natures: string[]; keys: string[] }>()
  for (const l of map.links.filter(x => x.kind === 'intercompany')) {
    const a = node(l.from_entity_id)
    const b = target(l)
    if (!a || !b) continue
    const k = [a.key, b.key].sort().join('|')
    const p = pairs.get(k) ?? { a, b, natures: [], keys: [] }
    const n = LINK_NATURE_LABEL[l.nature ?? 'other'] ?? l.nature ?? 'other'
    if (!p.natures.includes(n)) p.natures.push(n)
    p.keys.push(l.link_key)
    pairs.set(k, p)
  }
  for (const p of pairs.values()) {
    const label = p.natures.join(' · ')
    if (p.a.row === p.b.row) arc(p.keys.join('+'), 'intercompany', p.a, p.b, label, true)
    else straight(p.keys.join('+'), 'intercompany', p.a, p.b, label)
  }

  for (const l of map.links.filter(x => x.kind === 'disregarded')) {
    const a = node(l.from_entity_id)
    const b = target(l)
    if (a && b) straight(l.link_key, 'disregarded', a, b, 'disregarded')
  }

  const last = nodes.length ? Math.max(...nodes.map(n => n.y + n.h)) : 0
  const arcsUnderLast = edges.some(e => e.kind === 'intercompany' && nodes.some(n => n.row === 1 && n.y + n.h === last))
  return { nodes, edges, width, height: last + (arcsUnderLast ? 64 : 24) }
}

/** Items grouped by entity, then by year (latest first), keeping their order. */
export function groupByEntityYear<T extends { entity?: string | null; entity_id: string; tax_year: number | null }>(items: T[]) {
  const out: Array<{ entity_id: string; entity: string; years: Array<{ year: number | null; items: T[] }> }> = []
  for (const it of items) {
    let g = out.find(x => x.entity_id === it.entity_id)
    if (!g) out.push(g = { entity_id: it.entity_id, entity: it.entity ?? '', years: [] })
    let y = g.years.find(x => x.year === it.tax_year)
    if (!y) g.years.push(y = { year: it.tax_year, items: [] })
    y.items.push(it)
  }
  for (const g of out) g.years.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  return out
}

/** The question the fact registry asks for a fact key, else the key. */
export function factQuestion(key: string): string {
  return getFactDef(key)?.question ?? key
}
