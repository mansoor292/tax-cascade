/**
 * The entity map on a synthetic account shaped like the Edgewater group: an
 * owner's joint 1040, an S corporation whose K-1 misspells the owner's first
 * name, a C corporation whose Form 1125-E gives the owner's stock percentage,
 * a due-to / due-from balance printed on both sides, and a disregarded
 * payroll LLC recorded as a fact. All names and numbers are invented.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo, EntityLink } from './types.js'
import { buildContext, linkEntities } from './context.js'
import { coveringLink, namesEntity, samePerson, suggestLinks, touches, unrecorded } from './map.js'
import { entityMapChecks } from './checks/entity_map.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return { id: `m${++n}`, form, title: form, rev: '2025', instance: '', page: 1, section: '', line: '', label: '', desc: '', kind: 'text', value: null, raw: '', method: 'geometry', ...p }
}
function cat(id: string, year: number, entries: CatalogEntry[]): CatalogView {
  return { id, kind: 'filed_return', tax_year: year, status: 'complete', entries }
}

const EIN_S = '000000001'
const indiv: EntityInfo = { id: 'ind', name: 'Patrick Example & Lee Example', form_type: '1040', entity_type: 'individual', meta: { first_name: 'Patrick', last_name: 'Example', spouse_first: 'Lee', spouse_last: 'Example' } }
const scorp: EntityInfo = { id: 'sc', name: 'Example Holdings Inc', form_type: '1120S', entity_type: 's_corp' }
const ccorp: EntityInfo = { id: 'cc', name: 'Example Ventures Inc', form_type: '1120', entity_type: 'c_corp', meta: { owners: [{ name: 'PATRICK EXAMPLE', pct: '85%' }] } }

const schE = (year: number) => cat(`i${year}`, year, [
  e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'a', raw: 'EXAMPLE HOLDINGS INC', value: 'EXAMPLE HOLDINGS INC' }),
  e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'b', raw: 'S', value: 'S' }),
  e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'd', raw: '00-0000001', value: '00-0000001' }),
  e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'k', kind: 'amount', raw: '500,000', value: 500_000 }),
])
const sCat = (year: number, pct = '100.00000') => cat(`s${year}`, year, [
  e('f1120s', { line: 'D', raw: '00-0000001', value: '00-0000001' }),
  e('f1120ssk', { section: 'Part II', line: 'F', raw: 'PATRIK EXAMPLE 1 Main St Anytown FL 00000', value: 'PATRIK EXAMPLE 1 Main St Anytown FL 00000' }),
  e('f1120ssk', { section: 'Part II', line: 'G', raw: pct, value: pct }),
  e('statement', { kind: 'row', line: '3', label: 'EXAMPLE HOLDINGS INC 00-0000001 Statement - Schedule L' }),
  e('statement', { kind: 'row', line: '7', label: 'Due to Example Venture', value: 3000, raw: '3,000' }),
])
const cCat = (year: number) => cat(`c${year}`, year, [
  e('f1120', { line: 'B', raw: '00-0000002', value: '00-0000002' }),
  e('f1125e', { line: '1', row: '1', col: 'a', raw: 'PATRICK EXAMPLE', value: 'PATRICK EXAMPLE' }),
  e('f1125e', { line: '1', row: '1', col: 'd', kind: 'amount', raw: '85.00%', value: 85 }),
  e('statement', { kind: 'row', line: '46', label: 'Due from Example Holdings Inc (related co.)', value: 3000, raw: '3,000' }),
])

const bundles = () => [
  { entity: indiv, catalogs: [schE(2025)] },
  { entity: scorp, catalogs: [sCat(2025)] },
  { entity: ccorp, catalogs: [cCat(2025)] },
]
const facts = new Map([['sc', [{ fact_key: 'entity.disregarded_entities', tax_year: 2025, value: [{ name: 'Example Payroll LLC' }], superseded_by: null }]]])

function link(p: Partial<EntityLink>): EntityLink {
  return { link_key: `k${++n}`, kind: 'owns', from_entity_id: 'ind', to_entity_id: 'sc', to_name: null, subject: 'Patrick Example', pct: 100, nature: null, from_year: null, to_year: null, source: 'filed_return', evidence: 'x', detail: null, removed: false, ...p }
}

describe('names', () => {
  it('a one-letter typo in a first name is the same person; a different surname is not', () => {
    expect(samePerson('MANZOOR EXAMPLE', 'Mansoor Example')).toBe(true)
    expect(samePerson('Lee Example-Doe', 'Patrick Example')).toBe(false)
    expect(samePerson('Jo Example', 'Joe Example')).toBe(false)
  })
  it('a statement names an entity by its distinctive words, even cut short', () => {
    expect(namesEntity('Due to Example Venture', 'Example Ventures Inc')).toBe(true)
    expect(namesEntity('Due to Example Venture', 'Example Holdings Inc')).toBe(false)
    expect(namesEntity('Mail a check to the Department', 'Example AI, Inc')).toBe(false)
  })
})

describe('suggestions from the evidence on file', () => {
  const s = suggestLinks(bundles(), facts)
  it('ownership of the S corporation: Schedule E prints its EIN, the K-1 names the owner (misspelled) at 100%', () => {
    const o = s.find(x => x.kind === 'owns' && x.to_entity_id === 'sc')!
    expect(o).toMatchObject({ from_entity_id: 'ind', subject: 'Patrick Example', pct: 100, years: [2025], source: 'filed_return' })
    expect(o.evidence.some(v => v.includes('Schedule E Part II row A'))).toBe(true)
    expect(o.evidence.some(v => v.includes('K-1 items F/G'))).toBe(true)
  })
  it('ownership of the C corporation from Form 1125-E, merged with the entity record', () => {
    const o = s.find(x => x.kind === 'owns' && x.to_entity_id === 'cc')!
    expect(o).toMatchObject({ from_entity_id: 'ind', subject: 'Patrick Example', pct: 85, source: 'filed_return', years: [2025] })
    expect(o.evidence).toHaveLength(2)
  })
  it('the balance printed on both sides is one intercompany link, debtor first; the S corporation\'s own header is ignored', () => {
    const ic = s.filter(x => x.kind === 'intercompany')
    expect(ic).toHaveLength(1)
    expect(ic[0]).toMatchObject({ from_entity_id: 'sc', to_entity_id: 'cc', nature: 'loan' })
    expect(ic[0].evidence).toHaveLength(2)
  })
  it('the disregarded LLC from the fact, named because it has no return here', () => {
    expect(s.find(x => x.kind === 'disregarded')).toMatchObject({ from_entity_id: 'sc', to_entity_id: null, to_name: 'Example Payroll LLC', source: 'fact' })
  })
  it('a recorded link answers its evidence — the other direction for intercompany, and a removed link too', () => {
    const links = [link({}), link({ kind: 'intercompany', from_entity_id: 'cc', to_entity_id: 'sc', subject: null, pct: null, nature: 'settlement' }), link({ to_entity_id: 'cc', pct: 85, removed: true })]
    const left = unrecorded(links, s)
    expect(left.map(x => x.kind)).toEqual(['disregarded'])
    expect(coveringLink([link({ from_year: 2026 })], s.find(x => x.to_entity_id === 'sc')!, 2025)).toBeUndefined()
  })
})

describe('the review reads the map', () => {
  it('links a K-1 issuer from the map even when Schedule E lacks the row, and merges evidence when both agree', () => {
    const [i, sc, cc] = bundles()
    const no2024 = { ...i, catalogs: [cat('i2024', 2024, [])] }
    const viaMap = linkEntities(no2024, [sc, cc], 2024, [link({})])
    expect(viaMap).toHaveLength(1)
    expect(viaMap[0]).toMatchObject({ relation: 'k1_issuer', entity: { id: 'sc', meta: { ein_digits: EIN_S } } })
    expect(viaMap[0].evidence).toMatch(/^entity map: Patrick Example owns 100%/)
    const both = linkEntities(i, [sc, cc], 2025, [link({})])
    expect(both).toHaveLength(1)
    expect(both[0].evidence).toMatch(/entity map.*; 2025 Form 1040 Schedule E/)
    expect(linkEntities(sc, [i, cc], 2025, [link({})])[0]).toMatchObject({ relation: 'k1_recipient', entity: { id: 'ind' } })
  })

  const ctxFor = (selfId: string, year: number, links: EntityLink[], over?: ReturnType<typeof bundles>) => {
    const all = over ?? bundles()
    const self = all.find(b => b.entity.id === selfId)!
    return buildContext({ self, others: all.filter(b => b !== self), year, facts: [], links, factsByEntity: facts })
  }
  const run = async (selfId: string, year: number, links: EntityLink[], over?: ReturnType<typeof bundles>) => {
    const ctx = ctxFor(selfId, year, links, over)
    return (await Promise.all(entityMapChecks.map(c => c.run(ctx)))).flat()
  }

  it('evidence with no link is a gap, raised once: ownership on the owned entity, the rest where the link starts', async () => {
    const onS = await run('sc', 2025, [])
    expect(onS.filter(r => r.status === 'gap').map(r => r.title)).toEqual([
      '2025: Patrick Example owns 100% of Example Holdings Inc — not in the entity map',
      '2025: Example Holdings Inc and Example Ventures Inc deal with each other (loan) — not in the entity map',
      '2025: Example Payroll LLC is a disregarded entity of Example Holdings Inc — not in the entity map',
    ])
    const onI = await run('ind', 2025, [])
    expect(onI.filter(r => r.status === 'gap')).toHaveLength(0)
    const onC = await run('cc', 2025, [])
    expect(onC.filter(r => r.status === 'gap').map(r => r.severity)).toEqual(['medium'])
  })

  it('recorded links clear the gaps; a percentage the K-1 contradicts is a finding', async () => {
    const links = [
      link({ pct: 50 }),
      link({ kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', subject: null, pct: null, nature: 'loan' }),
      link({ kind: 'disregarded', from_entity_id: 'sc', to_entity_id: null, to_name: 'Example Payroll LLC', subject: null, pct: null }),
    ]
    const r = await run('sc', 2025, links)
    expect(r.filter(x => x.status === 'gap')).toHaveLength(0)
    expect(r.find(x => x.status === 'finding')?.title).toBe('2025: K-1 item G shows 100% for PATRIK EXAMPLE; the entity map says 50%')
    expect((await run('sc', 2025, [{ ...links[0], pct: 100 }, ...links.slice(1)])).filter(x => x.status === 'finding')).toHaveLength(0)
  })

  it('a pass-through the owner holds that never reaches the 1040 is a high finding', async () => {
    const [i, sc, cc] = bundles()
    const missing = [{ ...i, catalogs: [cat('i2025', 2025, [])] }, sc, cc]
    const r = await run('ind', 2025, [link({})], missing)
    const f = r.find(x => x.status === 'finding')!
    expect(f).toMatchObject({ severity: 'high', check: 'entity_map.ownership_matches_returns' })
    expect(f.title).toMatch(/Example Holdings Inc's K-1 is not on this 1040/)
    expect((await run('ind', 2025, [link({ to_year: 2024 })], missing)).some(x => x.status === 'finding')).toBe(false)
  })

  it('what a change to the S corporation touches: the owner\'s 1040, the intercompany side, the disregarded LLC', () => {
    const ents = bundles().map(b => ({ id: b.entity.id, name: b.entity.name, form_type: b.entity.form_type, years: [2025] }))
    const t = touches('sc', [
      link({}),
      link({ kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', subject: null, pct: null, nature: 'loan' }),
      link({ kind: 'disregarded', from_entity_id: 'sc', to_entity_id: null, to_name: 'Example Payroll LLC', subject: null, pct: null }),
    ], ents)
    expect(t.map(x => [x.name, x.via])).toEqual([
      ['Patrick Example & Lee Example', 'owner (Patrick Example, 100%)'],
      ['Example Ventures Inc', 'intercompany (loan)'],
      ['Example Payroll LLC', 'disregarded entity'],
    ])
    expect(t[0].effect).toMatch(/K-1 income/)
  })
})
