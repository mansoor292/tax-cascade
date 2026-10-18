/**
 * Version sets as views of the returns, on a synthetic group shaped like the
 * Edgewater 2023 fee gap: the S corporation deducted 1,550,000, the C
 * corporation reported 1,600,000. The filed set breaks; a v1 package that
 * amends only the C corporation's receipts line breaks its arithmetic until
 * the totals are amended too; the complete package ties. Names and numbers
 * are invented.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo, EntityLink } from './types.js'
import { buildContext } from './context.js'
import { runFramework, tieCheckIds } from './framework.js'
import { applyChanges, matchEntry, versionsForView, viewBundles, viewFacts, type VersionRow } from './versions.js'
import { checkChanges, checkSetFields } from '../services/versions.js'
import type { FactLike } from './map.js'

let n = 0
function e(form: string, p: Partial<CatalogEntry>): CatalogEntry {
  return { id: `v${++n}`, form, title: form, rev: '2023', instance: '', page: 1, section: '', line: '', label: '', desc: '', kind: 'amount', value: 0, raw: '', method: 'geometry', ...p }
}
const amt = (form: string, line: string, value: number, extra: Partial<CatalogEntry> = {}) => e(form, { line, value, raw: value.toLocaleString('en-US'), ...extra })
const cat = (id: string, year: number, entries: CatalogEntry[]): CatalogView => ({ id, kind: 'filed_return', tax_year: year, status: 'complete', entries })

const indiv: EntityInfo = { id: 'ind', name: 'Patrick Example', form_type: '1040', entity_type: 'individual', meta: { first_name: 'Patrick', last_name: 'Example' } }
const scorp: EntityInfo = { id: 'sc', name: 'Example Holdings Inc', form_type: '1120S', entity_type: 's_corp' }
const ccorp: EntityInfo = { id: 'cc', name: 'Example Ventures Inc', form_type: '1120', entity_type: 'c_corp' }

const ccFiled = cat('c2023', 2023, [
  amt('f1120', '1a', 2_382_710), amt('f1120', '1c', 2_382_710), amt('f1120', '3', 2_382_710), amt('f1120', '11', 2_382_710), amt('f1120', '28', 2_382_710), amt('f1120', '30', 2_382_710),
])
/** The same return with a second printed copy of its first page. */
const withCopy = cat('c2023', 2023, [...ccFiled.entries, amt('f1120', '1a', 2_382_710, { instance: 'copy2' })])
const bundles = () => [
  { entity: indiv, catalogs: [] as CatalogView[] },
  { entity: scorp, catalogs: [cat('s2023', 2023, [])] },
  { entity: ccorp, catalogs: [ccFiled] },
]
const fact = (fact_key: string, subject: string, value: number): FactLike & { subject: string; status: 'answered' } => ({ fact_key, tax_year: 2023, subject, value, status: 'answered', superseded_by: null })
const facts = () => new Map<string, FactLike[]>([
  ['sc', [fact('intercompany.fee_expense', 'Example Ventures Inc', 1_550_000)]],
  ['cc', [fact('intercompany.fee_revenue', 'Example Holdings Inc', 1_600_000)]],
])
const LINKS: EntityLink[] = [
  { link_key: 'svc', kind: 'intercompany', from_entity_id: 'sc', to_entity_id: 'cc', to_name: null, subject: null, pct: null, nature: 'services', from_year: 2022, to_year: null, source: 'owner', evidence: null, detail: null, removed: false },
]

const receipts = (to: number) => ({ form: 'f1120', line: '1a', to, from: 2_382_710, reason: 'Remove September 2023 fee never deducted by the payer', fact_key: 'intercompany.fee_revenue' as const, subject: 'Example Holdings Inc' })
const totals = (to: number) => ['1c', '3', '11', '28', '30'].map(line => ({ form: 'f1120', line, to, from: 2_382_710, reason: 'Follows line 1a' }))
const row = (label: string, status: VersionRow['set_status'], changes: VersionRow['changes'], filed_on: string | null = null): VersionRow =>
  ({ set_label: label, set_status: status, filed_on, set_created_at: '2026-10-18T00:00:00Z', entity_id: 'cc', tax_year: 2023, form: '1120-X', changes, updated_at: '2026-10-18T00:00:00Z' })

async function breaksIn(view: string, versions: VersionRow[]) {
  const chosen = versionsForView(versions, view)
  const all = viewBundles(bundles(), chosen)
  const out: string[] = []
  for (const id of ['sc', 'cc']) {
    const self = all.find(b => b.entity.id === id)!
    const vf = viewFacts(facts(), chosen)
    const ctx = buildContext({ self, others: all.filter(b => b !== self), year: 2023, facts: (vf.get(id) ?? []) as any, links: LINKS, factsByEntity: vf })
    const { findings } = await runFramework(ctx, { ai: false, only: tieCheckIds() })
    out.push(...findings.filter(f => f.tie && f.status === 'finding').map(f => `${id}:${f.check}:${f.key ?? ''}`))
  }
  return out
}

describe('a version is the filed return with its changes applied', () => {
  it('changes the line and every printed copy of it, marks the title, and adds only lines it says it adds', () => {
    const v = applyChanges(withCopy, [receipts(2_332_710), { form: 'f1120', section: 'Schedule K', line: '28', to: true, reason: 'Member of a controlled group', add: true }], 'v1')
    expect(v.entries.filter(x => x.line === '1a').map(x => x.value)).toEqual([2_332_710, 2_332_710])
    expect(matchEntry(v, { form: 'f1120', line: '1a', reason: '' })?.title).toBe('f1120 (v1)')
    expect(v.entries.find(x => x.line === '28' && x.section === 'Schedule K')).toMatchObject({ value: true, kind: 'check', method: 'amendment', rev: '2023' })
    expect(applyChanges(ccFiled, [{ form: 'f1120', line: '99', to: 1, reason: 'typo' }], 'v1').entries).toHaveLength(ccFiled.entries.length)
    expect(ccFiled.entries[0].value).toBe(2_382_710)
  })

  it('the filed view is the filed sets in filing order; a draft set is only in its own view; abandoned is in none', () => {
    const rows = [row('v2', 'filed', [], '2026-12-01'), row('v1', 'filed', [], '2026-11-01'), row('v3', 'draft', []), row('v4', 'abandoned', [])]
    expect(versionsForView(rows, 'filed').map(r => r.set_label)).toEqual(['v1', 'v2'])
    expect(versionsForView(rows, 'v3').map(r => r.set_label)).toEqual(['v1', 'v2', 'v3'])
    expect(versionsForView(rows, 'v4').map(r => r.set_label)).toEqual(['v1', 'v2'])
  })
})

describe('every set must tie', () => {
  it('filed: the fee break', async () => {
    expect(await breaksIn('filed', [])).toEqual(['sc:intercompany.fees_match:fees:svc'])
  })
  it('v1 with only the receipts line: the fee ties, but the return no longer adds up', async () => {
    const b = await breaksIn('v1', [row('v1', 'draft', [receipts(2_332_710)])])
    expect(b).not.toContain('sc:intercompany.fees_match:fees:svc')
    expect(b).toContain('cc:catalog.arithmetic:f1120::1c = 1a - 1b')
  })
  it('v1 with the totals amended too: no breaks', async () => {
    expect(await breaksIn('v1', [row('v1', 'draft', [receipts(2_332_710), ...totals(2_332_710)])])).toEqual([])
  })
  it('once v1 is filed, the filed view ties', async () => {
    expect(await breaksIn('filed', [row('v1', 'filed', [receipts(2_332_710), ...totals(2_332_710)], '2026-11-01')])).toEqual([])
  })
  it('the tie checks are the ones a set is held to', () => {
    expect(tieCheckIds()).toEqual(expect.arrayContaining([
      'catalog.arithmetic', 'balance_sheet.opening_equals_prior_close', 'carryovers.nol_chain', 'basis.form7203_matches_k1',
      'loans.k1_item_i_matches_schedule_l', 'intercompany.fees_match', 'intercompany.balances_match', 'corporate.controlled_group_consistent',
    ]))
    expect(tieCheckIds()).not.toContain('statute.windows')
    expect(tieCheckIds()).not.toContain('ai.framework_scan')
  })
})

describe('saving a version', () => {
  it('records what each line replaces and refuses a line the return does not have', () => {
    const ok = checkChanges([{ form: 'f1120', line: '1a', to: 2_332_710, reason: 'r', fact_key: 'intercompany.fee_revenue', subject: 'Example Holdings Inc' }], ccFiled, 2023)
    expect(ok).toMatchObject({ ok: true, changes: [{ from: 2_382_710, to: 2_332_710 }] })
    expect(checkChanges([{ form: 'f1120', line: '1A', section: 'Schedule K', to: 1, reason: 'r' }], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes[0].line' })
    expect(checkChanges([{ form: 'f1120', line: '29', to: 1, reason: 'NOL', add: true }], ccFiled, 2023)).toMatchObject({ ok: true, changes: [{ from: null, add: true }] })
  })
  it('every change says why; slugs, facts and deltas are checked', () => {
    expect(checkChanges([], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes' })
    expect(checkChanges([{ form: 'f1120', line: '1a', to: 1 }], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes[0].reason' })
    expect(checkChanges([{ form: '1120', line: '1a', to: 1, reason: 'r' }], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes[0].form' })
    expect(checkChanges([{ fact_key: 'intercompany.balance_end', subject: 'Example Holdings Inc', reason: 'r' }], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes[0].delta' })
    expect(checkChanges([{ fact_key: 'intercompany.balance_end', delta: 20_000, reason: 'r' }], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes[0].subject' })
    expect(checkChanges([{ fact_key: 'intercompany.balance_end', subject: 'Example Holdings Inc', delta: 20_000, reason: 'unrecorded payment' }], ccFiled, 2023).ok).toBe(true)
    expect(checkChanges([{ form: 'f1120', line: '1a', to: 1, reason: 'r', colour: 'x' }], ccFiled, 2023)).toMatchObject({ ok: false, field: 'changes[0].colour' })
  })
  it('a set label is short and lowercase, and "filed" is reserved; a set is only ever filed or abandoned', () => {
    expect(checkSetFields({ label: 'filed' }, true)).toMatchObject({ ok: false, field: 'label' })
    expect(checkSetFields({ label: 'V1' }, true)).toMatchObject({ ok: false, field: 'label' })
    expect(checkSetFields({ label: 'v1', title: 'Fee true-up' }, true)).toMatchObject({ ok: true })
    expect(checkSetFields({ status: 'draft' }, false)).toMatchObject({ ok: false, field: 'status' })
    expect(checkSetFields({ label: 'v2' }, false)).toMatchObject({ ok: false, field: 'label' })
  })
})
