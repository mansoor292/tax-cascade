/**
 * The review framework on synthetic catalogs shaped like the Edgewater facts:
 * an S corporation whose 1040 reported its income as passive, whose
 * distributions exceeded basis, and a loss year funded by a related company.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo } from './types.js'
import { buildContext } from './context.js'
import { runFramework, diffRuns, type Finding } from './framework.js'
import { basisRollforward } from './checks/passthrough.js'
import { grounded, aiChecks } from './ai.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: `e${++n}`, form, title: form, rev: '2023', instance: '', page: 1, section: '', line: '', label: '', desc: '',
    kind: 'amount', value: 0, raw: '', method: 'geometry', ...p,
  }
}
const amt = (form: string, line: string, value: number, extra: Partial<CatalogEntry> = {}) => e(form, { line, value, raw: value.toLocaleString('en-US'), ...extra })
function cat(id: string, year: number, entries: CatalogEntry[], kind: CatalogView['kind'] = 'filed_return'): CatalogView {
  return { id, kind, tax_year: year, status: 'complete', coverage: { pages: 1, form_pages: 1, statement_pages: 0, duplicate_pages: 0, transcript_pages: 0, blank_pages: 0, entries: entries.length, residue_tokens: 0, copy_conflicts: 0, complete: true, problems: [], warnings: [] }, entries }
}

const EIN = '000000001'
const scorp: EntityInfo = { id: 's', name: 'Example S Corp', form_type: '1120S', entity_type: 's_corp', date_incorporated: '2021-10-25' }
const indiv: EntityInfo = { id: 'i', name: 'Example Taxpayer', form_type: '1040', entity_type: 'individual' }

function k1(year: number, box1: number, dist: number, extra: CatalogEntry[] = []): CatalogEntry[] {
  return [
    e('f1120s', { line: 'D', kind: 'text', value: EIN, raw: '00-0000001' }),
    e('f1120s', { line: 'B', kind: 'text', value: '541213', raw: '541213' }),
    e('f1120ssk', { section: 'Part III', line: '1', value: box1, raw: String(box1) }),
    e('f1120ssk', { section: 'Part III', line: '16', kind: 'text', value: 'D', raw: 'D', label: 'Line 1 of 5. Code' }),
    e('f1120ssk', { section: 'Part III', line: '16', value: dist, raw: String(dist), label: 'Line 1 of 5. Amount' }),
    ...extra,
  ].map(x => ({ ...x, rev: String(year) }))
}

const SCORP_CATS = [
  cat('t2021', 2021, [e('irs_transcript', { section: 'Return information', line: 'Taxable Income', value: -41424, raw: 'Taxable Income -$41,424.00' })], 'irs_transcript'),
  cat('s2022', 2022, k1(2022, 1_061_424, 1_048_000)),
  cat('s2023', 2023, k1(2023, 3_044_422, 3_108_149, [amt('f1120ssk', '4', 26_008, { section: 'Part III' }), amt('f1120ssk', '5a', 516, { section: 'Part III' })])),
]

const INDIV_CATS = [
  cat('i2023', 2023, [
    e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'a', kind: 'text', value: 'EXAMPLE S CORP', raw: 'EXAMPLE S CORP' }),
    e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'b', kind: 'text', value: 'S', raw: 'S' }),
    e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'd', kind: 'text', value: EIN, raw: '00-0000001' }),
    e('f1040se', { section: 'Part II', line: '28', row: 'A', col: 'h', value: 3_044_422, raw: '3,044,422' }),
    amt('f8960', '4a', 3_044_422),
    amt('f7203', '6', 3_108_149, { section: 'Part I' }),
  ]),
]

describe('review framework', () => {
  it('rolls basis forward in the §1367 order, using the transcript for a year with no return', () => {
    const roll = basisRollforward(SCORP_CATS, 2023, 0, 2021, () => 0)
    expect(roll.map(r => r.year)).toEqual([2021, 2022, 2023])
    expect(roll[0]).toMatchObject({ allowedLoss: 0, suspendedOut: 41424, eoy: 0 })
    // 2022: 1,061,424 − 1,048,000 = 13,424 of room → 13,424 of the 41,424 allowed.
    expect(roll[1]).toMatchObject({ excess: 0, allowedLoss: 13424, suspendedOut: 28000, eoy: 0 })
    // 2023: income 3,070,946 against 3,108,149 of distributions → 37,203 over basis.
    expect(roll[2].excess).toBe(37203)
  })

  it('links the 1040 to the S corporation only through the EIN both returns print', () => {
    const ctx = buildContext({ self: { entity: indiv, catalogs: INDIV_CATS }, others: [{ entity: scorp, catalogs: SCORP_CATS }], year: 2023, facts: [] })
    expect(ctx.linked.map(l => [l.relation, l.entity.name])).toEqual([['k1_issuer', 'Example S Corp']])
    const unrelated = buildContext({ self: { entity: indiv, catalogs: INDIV_CATS }, others: [{ entity: { ...scorp, id: 'x' }, catalogs: [cat('x', 2023, [e('f1120s', { line: 'D', kind: 'text', value: '000000002', raw: '00-0000002' })])] }], year: 2023, facts: [] })
    expect(unrelated.linked).toEqual([])
  })

  it('NIIT: passive treatment is a gap until material participation is recorded, then a finding with the tax', async () => {
    const others = [{ entity: scorp, catalogs: SCORP_CATS }]
    const before = await runFramework(buildContext({ self: { entity: indiv, catalogs: INDIV_CATS }, others, year: 2023, facts: [] }), { ai: false, only: ['niit.nonpassive_income_taxed'] })
    expect(before.findings[0]).toMatchObject({ status: 'gap', severity: 'high' })
    expect(before.findings[0].asks).toContain('k1.material_participation')
    const facts = [{ fact_key: 'k1.material_participation', tax_year: 2023, subject: 'Example S Corp', value: 'more_than_500_hours', status: 'answered' as const }]
    const after = await runFramework(buildContext({ self: { entity: indiv, catalogs: INDIV_CATS }, others, year: 2023, facts }), { ai: false, only: ['niit.nonpassive_income_taxed'] })
    expect(after.findings[0]).toMatchObject({ status: 'finding', dollar_effect: -115688 })
  })

  it('flags distributions above basis and a Form 7203 missing the ordinary income', async () => {
    const ctx = buildContext({ self: { entity: indiv, catalogs: INDIV_CATS }, others: [{ entity: scorp, catalogs: SCORP_CATS }], year: 2023, facts: [] })
    const { findings } = await runFramework(ctx, { ai: false, only: ['basis.distributions_within_basis', 'basis.form7203_matches_k1', 'qbi.sstb_position_consistent'] })
    expect(findings.find(f => f.key?.endsWith(':excess'))?.title).toMatch(/37,203/)
    expect(findings.find(f => f.key?.endsWith(':3a'))?.title).toMatch(/line 3a shows 0/)
  })

  it('every check that throws is reported, never swallowed', async () => {
    const ctx = buildContext({ self: { entity: indiv, catalogs: INDIV_CATS }, others: [], year: 2023, facts: [] })
    ;(ctx as any).catalogs = null
    const { findings } = await runFramework(ctx, { ai: false, only: ['catalog.return_present'] })
    expect(findings[0].status).toBe('error')
  })

  it('a new finding says why it is new', () => {
    const f = (fp: string, status: Finding['status'] = 'finding'): Finding => ({ check: fp.split('|')[0], status, severity: 'high', title: fp, detail: '', evidence: [], fingerprint: fp, check_version: 1, area: 'basis', kind: 'rule', tax_year: 2023 })
    const prev = { findings: [f('a|2023|'), f('b|2023|')], catalog_ids: ['c1'], facts_at: '2026-10-01', version: 'v1' }
    const byDoc = diffRuns({ previous: prev, current: { findings: [f('a|2023|'), f('c|2023|')], catalog_ids: ['c1', 'c2'], facts_at: '2026-10-01', version: 'v1' } })
    expect(byDoc.find(x => x.fingerprint === 'c|2023|')).toMatchObject({ change: 'new', cause: 'new_document' })
    expect(byDoc.find(x => x.fingerprint === 'b|2023|')).toMatchObject({ change: 'resolved' })
    const byFact = diffRuns({ previous: prev, current: { findings: [f('c|2023|')], catalog_ids: ['c1'], facts_at: '2026-10-10', version: 'v1' } })
    expect(byFact.find(x => x.fingerprint === 'c|2023|')?.cause).toBe('new_fact')
    const miss = diffRuns({ previous: prev, current: { findings: [f('c|2023|')], catalog_ids: ['c1'], facts_at: '2026-10-01', version: 'v1' } })
    expect(miss.find(x => x.fingerprint === 'c|2023|')?.cause).toBe('miss')
    // A resolved item is not carried into the next run again.
    const next = diffRuns({ previous: { ...prev, findings: byDoc }, current: { findings: [f('a|2023|'), f('c|2023|')], catalog_ids: ['c1', 'c2'], facts_at: '2026-10-01', version: 'v1' } })
    expect(next.filter(x => x.fingerprint === 'b|2023|')).toEqual([])
  })

  it('a run without the AI checks carries the AI findings, never resolves them', () => {
    const f = (fp: string, kind: Finding['kind']): Finding => ({ check: fp.split('|')[0], status: 'finding', severity: 'high', title: fp, detail: '', evidence: [], fingerprint: fp, check_version: 1, area: 'x', kind, tax_year: 2023 })
    const prev = { findings: [f('rule|2023|', 'rule'), f('ai.framework_scan|2023|x', 'ai')], catalog_ids: ['c1'], facts_at: null, version: 'v1' }
    const rulesOnly = diffRuns({ previous: prev, current: { findings: [f('rule|2023|', 'rule')], catalog_ids: ['c1', 'c2'], facts_at: null, version: 'v1', ai: false } })
    expect(rulesOnly.find(x => x.kind === 'ai')).toMatchObject({ change: 'unchanged', status: 'finding' })
    // With the AI checks run, an AI finding that is gone is resolved.
    const withAi = diffRuns({ previous: prev, current: { findings: [f('rule|2023|', 'rule')], catalog_ids: ['c1'], facts_at: null, version: 'v1', ai: true } })
    expect(withAi.find(x => x.kind === 'ai')).toMatchObject({ change: 'resolved' })
  })

  it('AI conclusions that cite nothing on the return are dropped', () => {
    const ids = new Set(['e1', 'e2'])
    expect(grounded([{ cited: ['e1', 'zz'] }, { cited: ['nope'] }, { cited: undefined }], ids)).toEqual([{ cited: ['e1'] }])
  })

  it('the AI scan keeps only claims a second pass confirms against the cited lines', async () => {
    const scan = aiChecks(async (prompt: string) => {
      if (prompt.includes("checking another reviewer")) return { verdicts: [{ index: 0, supported: true }, { index: 1, supported: false, reason: 'refund box, not a credit' }] }
      const ids = [...prompt.matchAll(/"id":"(e\d+)"/g)].map(m => m[1])
      return { issues: [
        { title: 'Real problem', detail: 'd', area: 'x', severity: 'high', amount_involved: 1800000, tax_effect: 600000, cited: [ids[0]] },
        { title: 'Misread credit', detail: 'd', area: 'x', severity: 'high', amount_involved: 147713, tax_effect: -147713, cited: [ids[1]] },
        { title: 'Cites nothing real', detail: 'd', area: 'x', severity: 'high', cited: ['nope'] },
      ] }
    }).find(c => c.id === 'ai.framework_scan')!
    const ctx = buildContext({ self: { entity: scorp, catalogs: SCORP_CATS }, others: [], year: 2023, facts: [] })
    const out = await scan.run(ctx)
    expect(out.map(o => o.title)).toEqual(['2023: Real problem (AI)'])
    expect(out[0].dollar_effect).toBe(600000)
    expect(out[0].detail).toMatch(/Amount involved: 1,800,000/)
  })
})
