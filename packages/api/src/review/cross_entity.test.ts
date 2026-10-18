/**
 * Cross-entity checks on a synthetic group shaped like the Edgewater one: an
 * S corporation paying a C corporation a monthly fee, a balance the two
 * balance sheets disagree on, and a second C corporation formed in December
 * whose arrival makes the group a controlled group that year. All names and
 * numbers are invented.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo, EntityLink } from './types.js'
import { buildContext } from './context.js'
import { crossEntityChecks } from './checks/cross_entity.js'
import { mapFactAnswers, withMapAnswers, type FactLike } from './map.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return { id: `x${++n}`, form, title: form, rev: '2025', instance: '', page: 1, section: '', line: '', label: '', desc: '', kind: 'text', value: null, raw: '', method: 'geometry', ...p }
}
const cat = (id: string, year: number, entries: CatalogEntry[]): CatalogView => ({ id, kind: 'filed_return', tax_year: year, status: 'complete', entries })

const indiv: EntityInfo = { id: 'ind', name: 'Patrick Example', form_type: '1040', entity_type: 'individual', meta: { first_name: 'Patrick', last_name: 'Example' } }
const scorp: EntityInfo = { id: 'sc', name: 'Example Holdings Inc', form_type: '1120S', entity_type: 's_corp' }
const ccorp: EntityInfo = { id: 'cc', name: 'Example Ventures Inc', form_type: '1120', entity_type: 'c_corp' }
const ai: EntityInfo = { id: 'ai', name: 'Example AI, Inc', form_type: '1120', entity_type: 'c_corp', date_incorporated: '2024-12-01' }

const k = (line: string, label: string) => e('f1120', { section: 'Schedule K', line, kind: 'check', value: true, label })
const Q28 = 'Is the corporation a member of a controlled group? If "Yes," attach Schedule O (Form 1120). See instructions'
const Q3 = 'Is the corporation a subsidiary in an affiliated group or a parent–subsidiary controlled group?'

function link(p: Partial<EntityLink>): EntityLink {
  return { link_key: `l${++n}`, kind: 'owns', from_entity_id: 'ind', to_entity_id: 'sc', to_name: null, subject: 'Patrick Example', pct: 100, nature: null, from_year: null, to_year: null, source: 'owner', evidence: null, detail: null, removed: false, ...p }
}
const LINKS = [
  link({}), link({ to_entity_id: 'cc' }), link({ to_entity_id: 'ai', pct: 85 }),
  link({ kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', subject: null, pct: null, nature: 'services', from_year: 2022 }),
  link({ kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', subject: null, pct: null, nature: 'settlement', from_year: 2023 }),
]
const fact = (fact_key: string, tax_year: number | null, subject: string | null, value: unknown): FactLike & { subject: string | null; status: 'answered' } =>
  ({ fact_key, tax_year, subject, value, status: 'answered', superseded_by: null })

function run(selfId: string, year: number, opts: { catalogs?: Record<string, CatalogView[]>; facts?: Record<string, FactLike[]>; links?: EntityLink[] } = {}) {
  const bundles = [indiv, scorp, ccorp, ai].map(ent => ({ entity: ent, catalogs: opts.catalogs?.[ent.id] ?? [] }))
  const self = bundles.find(b => b.entity.id === selfId)!
  const facts = new Map(Object.entries(opts.facts ?? {}))
  const ctx = buildContext({ self, others: bundles.filter(b => b !== self), year, facts: (facts.get(selfId) ?? []) as any, links: opts.links ?? LINKS, factsByEntity: facts })
  return Promise.all(crossEntityChecks.map(c => c.run(ctx))).then(r => r.flat())
}

describe('intercompany fees', () => {
  const facts = {
    sc: [fact('intercompany.fee_expense', 2023, 'Example Ventures Inc', 1_550_000), fact('intercompany.fee_expense', 2024, 'Example Ventures Inc', 1_250_000)],
    cc: [fact('intercompany.fee_revenue', 2023, 'Example Holdings Inc', 1_600_000), fact('intercompany.fee_revenue', 2024, 'Example Holdings Inc', 1_250_000)],
  }
  it('a month booked on one side only is a finding on the payer, with the payee\'s 21% effect', async () => {
    const f = (await run('sc', 2023, { facts })).find(r => r.check === 'intercompany.fees_match')!
    expect(f).toMatchObject({ status: 'finding', severity: 'high', dollar_effect: -10_500 })
    expect(f.title).toBe('2023: Example Holdings Inc deducted 1,550,000 for Example Ventures Inc\'s fees; Example Ventures Inc reported 1,600,000 — 50,000 apart')
  })
  it('equal sides pass; a missing side is a gap that asks for it; the payee is never raised', async () => {
    expect((await run('sc', 2024, { facts })).find(r => r.check === 'intercompany.fees_match')?.status).toBe('pass')
    const gap = (await run('sc', 2025, { facts })).find(r => r.check === 'intercompany.fees_match')!
    expect(gap).toMatchObject({ status: 'gap', asks: ['intercompany.fee_expense', 'intercompany.fee_revenue'] })
    expect((await run('cc', 2023, { facts })).find(r => r.check === 'intercompany.fees_match')?.status).toBe('n/a')
    expect((await run('sc', 2021, { facts })).find(r => r.check === 'intercompany.fees_match')?.status).toBe('n/a')
  })
})

describe('intercompany balances', () => {
  const catalogs = {
    sc: [cat('s2025', 2025, [e('statement', { kind: 'row', line: '23', label: 'Due to Example Ventures Inc (related company)', amounts: [1_175_000, 1_175_000], value: 1_175_000 })])],
    cc: [cat('c2025', 2025, [e('statement', { kind: 'row', line: '46', label: 'Due from Example Holdings Inc (related co.)', amounts: [1_245_000, 1_245_000], value: 1_245_000 })])],
  }
  it('the two balance sheets read from statement rows naming each other', async () => {
    const f = (await run('sc', 2025, { catalogs })).find(r => r.check === 'intercompany.balances_match')!
    expect(f.status).toBe('finding')
    expect(f.title).toBe('2025: Example Holdings Inc shows 1,175,000 due to Example Ventures Inc; Example Ventures Inc shows 1,245,000 due from it — 70,000 apart')
  })
  it('a recorded balance on one side and nothing on the other is a gap', async () => {
    const r = (await run('sc', 2024, { catalogs, facts: { sc: [fact('intercompany.balance_end', 2024, 'Example Ventures Inc', -1_175_000)] } })).find(x => x.check === 'intercompany.balances_match')!
    expect(r).toMatchObject({ status: 'gap', asks: ['intercompany.balance_end'] })
    expect(r.title).toMatch(/Example Ventures Inc not identifiable/)
  })
  it('signed facts on both sides that agree pass', async () => {
    const facts = { sc: [fact('intercompany.balance_end', 2024, 'Example Ventures Inc', -1_175_000)], cc: [fact('intercompany.balance_end', 2024, 'Example Holdings Inc', 1_175_000)] }
    expect((await run('sc', 2024, { facts })).find(x => x.check === 'intercompany.balances_match')?.status).toBe('pass')
  })
})

describe('controlled group', () => {
  const cc = (year: number, entries: CatalogEntry[]) => ({ cc: [cat(`c${year}`, year, entries)] })
  const cg = async (year: number, entries: CatalogEntry[], links = LINKS) => (await run('cc', year, { catalogs: cc(year, entries), links })).filter(r => r.check === 'corporate.controlled_group_consistent')

  it('a corporation formed on 12/1 makes the group that year: answering No is a finding', async () => {
    const r = await cg(2024, [k('28', `${Q28} — No`), k('3', `${Q3} — No`)])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ status: 'finding', key: 'k28' })
    expect(r[0].title).toBe('2024: Schedule K answers "No" to controlled-group membership, but Example Ventures Inc and Example AI, Inc were under common control on 2024-12-31')
    expect(r[0].detail).toMatch(/Example Holdings Inc is also under common control but, as S corporations, excluded members/)
  })
  it('before the second corporation existed, No is right', async () => {
    expect((await cg(2023, [k('28', `${Q28} — No`)]))[0].status).toBe('pass')
  })
  it('Yes with Schedule O listing the member passes; a Schedule O that leaves it out does not', async () => {
    const schO = (name: string) => e('f1120so', { section: 'Part I', line: '10', kind: 'text', raw: name, value: name })
    expect((await cg(2025, [k('28', `${Q28}. Yes`), schO('EXAMPLE AI, INC')]))[0].status).toBe('pass')
    expect((await cg(2025, [k('28', `${Q28}. Yes`), schO('SOMEONE ELSE INC')]))[0]).toMatchObject({ status: 'finding', key: 'schedule_o_members' })
    expect((await cg(2025, [k('28', `${Q28}. Yes`)]))[0]).toMatchObject({ status: 'finding', key: 'schedule_o' })
  })
  it('"subsidiary in a parent–subsidiary group" is impossible when an individual owns all of it', async () => {
    const r = await cg(2022, [k('3', `${Q3} Yes`)])
    expect(r.find(x => x.key === 'k3')?.title).toBe('2022: Schedule K says this is a subsidiary in an affiliated or parent–subsidiary group, but individuals own 100% of it')
  })
  it('an unknown formation date is asked for, not guessed', async () => {
    const noDate = { ...ai, date_incorporated: null }
    const bundles = [indiv, scorp, ccorp, noDate].map(ent => ({ entity: ent, catalogs: ent.id === 'cc' ? cc(2024, [k('28', `${Q28} — No`)]).cc : [] }))
    const self = bundles.find(b => b.entity.id === 'cc')!
    const ctx = buildContext({ self, others: bundles.filter(b => b !== self), year: 2024, facts: [], links: LINKS, factsByEntity: new Map() })
    const out = await crossEntityChecks[2].run(ctx)
    expect(out[0]).toMatchObject({ status: 'gap', key: 'formation', asks: ['entity.formation_date'] })
  })
})

describe('the map answers the registry\'s related-company questions', () => {
  const ents = [indiv, scorp, ccorp, ai].map(x => ({ id: x.id, name: x.name, form_type: x.form_type }))
  it('derives has_related_entities and the counterparty list, with the common owner', () => {
    const a = mapFactAnswers('sc', LINKS, ents)
    expect(a.map(x => x.fact_key)).toEqual(['intercompany.has_related_entities', 'intercompany.counterparties'])
    expect(a[1].value).toEqual([{ name: 'Example Ventures Inc', relationship: 'services, settlement (common owner: Patrick Example)', return_form: '1120', in_this_account: true }])
    expect(mapFactAnswers('ai', LINKS, ents)).toEqual([])
  })
  it('a stored answer wins over the derived one', () => {
    const stored = [{ fact_key: 'intercompany.has_related_entities', tax_year: null, superseded_by: null, value: true }]
    const out = withMapAnswers(stored, 'sc', LINKS, ents)
    expect(out.filter(f => f.fact_key === 'intercompany.has_related_entities')).toHaveLength(1)
    expect(out.map(f => f.fact_key)).toContain('intercompany.counterparties')
  })
})
