/**
 * The Group page's map layout, on an invented group shaped like a real one:
 * one household owning an S corporation and a C corporation, the two
 * corporations dealing with each other two ways, and an LLC disregarded into
 * the S corporation.
 */
import { describe, it, expect } from 'vitest'
import type { EntityMap, MapLink } from '@/hooks/use-entity-map'
import { buildGraph, fit, groupByEntityYear, spanText, yearsText } from './graph'

const link = (p: Partial<MapLink>): MapLink => ({
  link_key: Math.random().toString(36).slice(2), kind: 'owns', from_entity_id: 'hh', to_entity_id: null, to_name: null, subject: null, pct: null,
  nature: null, from_year: null, to_year: null, source: 'filed_return', evidence: null, detail: null, recorded_at: '2026-10-18T00:00:00Z',
  from_entity_name: null, to_entity_name: null, ...p,
})

const MAP: EntityMap = {
  entities: [
    { id: 'sc', name: 'Example Holdings Inc', form_type: '1120S', years: [2022, 2023, 2024, 2025], touches: [] },
    { id: 'hh', name: 'Pat & Sam Example', form_type: '1040', years: [2023, 2025], touches: [] },
    { id: 'cc', name: 'Example Ventures Inc', form_type: '1120', years: [], touches: [] },
  ],
  links: [
    link({ kind: 'owns', from_entity_id: 'hh', to_entity_id: 'sc', subject: 'Pat Example', pct: 100 }),
    link({ kind: 'owns', from_entity_id: 'hh', to_entity_id: 'cc', subject: 'Pat Example', pct: 85 }),
    link({ kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', nature: 'services', from_year: 2022 }),
    link({ kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', nature: 'settlement', from_year: 2023 }),
    link({ kind: 'disregarded', from_entity_id: 'sc', to_name: 'Example Advisors LLC' }),
  ],
  removed_links: [],
  owners: [],
  unrecorded: [],
}

describe('buildGraph', () => {
  it('puts the household on top, the businesses in the middle and outside names at the bottom', () => {
    const g = buildGraph(MAP)
    const row = (k: string) => g.nodes.find(n => n.key === k)?.row
    expect([row('hh'), row('sc'), row('cc')]).toEqual([0, 1, 1])
    const llc = g.nodes.find(n => n.label === 'Example Advisors LLC')
    expect(llc).toMatchObject({ row: 2, entityId: null, sub: 'outside this account' })
    expect(g.nodes.find(n => n.key === 'sc')?.sub).toBe('S-Corp · filed 2022–2025')
    expect(g.nodes.find(n => n.key === 'cc')?.sub).toBe('C-Corp · no filed returns here')
    expect(g.nodes.find(n => n.key === 'hh')?.sub).toBe('Individual · filed 2023, 2025')
  })

  it('labels ownership with the owner and percentage, and draws two dealings between one pair as one arc', () => {
    const g = buildGraph(MAP)
    expect(g.edges.filter(e => e.kind === 'owns').map(e => e.label).sort()).toEqual(['Pat 100%', 'Pat 85%'])
    const ic = g.edges.filter(e => e.kind === 'intercompany')
    expect(ic).toHaveLength(1)
    expect(ic[0].label).toBe('Services / fees · Due to / due from')
    expect(ic[0].path).toMatch(/ Q /)
    expect(g.edges.filter(e => e.kind === 'disregarded').map(e => e.label)).toEqual(['disregarded'])
  })

  it('keeps every box inside the picture', () => {
    const g = buildGraph(MAP)
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x + n.w).toBeLessThanOrEqual(g.width)
      expect(n.y + n.h).toBeLessThanOrEqual(g.height)
    }
  })

  it('an empty account is an empty picture, not a crash', () => {
    expect(buildGraph({ entities: [], links: [], removed_links: [], owners: [], unrecorded: [] })).toMatchObject({ nodes: [], edges: [] })
  })
})

describe('text helpers', () => {
  it('years and spans', () => {
    expect(yearsText([])).toBe('')
    expect(yearsText([2024, 2022, 2023])).toBe('2022–2024')
    expect(spanText(2022, null)).toBe('2022 on')
    expect(spanText(2022, 2024)).toBe('2022–2024')
    expect(spanText(null, null)).toBe('all years')
  })
  it('fit shortens to the box', () => {
    expect(fit('Ingrid Example-Longname & Partner Example', 160)).toMatch(/…$/)
    expect(fit('Short Inc', 160)).toBe('Short Inc')
  })
})

describe('groupByEntityYear', () => {
  it('groups by entity in first-seen order, latest year first, keeping item order', () => {
    const items = [
      { entity: 'B', entity_id: 'b', tax_year: 2023, t: 1 },
      { entity: 'A', entity_id: 'a', tax_year: 2024, t: 2 },
      { entity: 'B', entity_id: 'b', tax_year: 2025, t: 3 },
      { entity: 'B', entity_id: 'b', tax_year: 2023, t: 4 },
    ]
    const g = groupByEntityYear(items)
    expect(g.map(x => x.entity)).toEqual(['B', 'A'])
    expect(g[0].years.map(y => [y.year, y.items.map(i => i.t)])).toEqual([[2025, [3]], [2023, [1, 4]]])
  })
})
