/**
 * Fact gaps, catalog comparison, write validation and the supersede-never-
 * overwrite write path (services/facts.ts).
 *
 * The rule under test is the owner's: every return of a type is held to the
 * same list. So the central assertions are about the LIST — that it has the
 * same shape whatever has been answered, that nothing drops out silently
 * (undetermined facts stay listed, not-applicable ones stay listed), and that
 * a filed return line disagreeing with an answer is surfaced, not smoothed.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { factsFor, getFactDef, type CatalogSelector, type FactValue } from '@taxengine/shared'
import {
  checkFactInput, compareWithCatalog, computeFactGaps, currentFactIndex, recordFact, summarizeGaps,
  type StoredFact,
} from './facts.js'

let seq = 0
function fact(fact_key: string, value: FactValue | null, opts: Partial<StoredFact> = {}): StoredFact {
  seq++
  return {
    id: `f${String(seq).padStart(4, '0')}`,
    entity_id: 'e1',
    tax_year: null,
    subject: null,
    fact_key,
    value,
    status: 'answered',
    source: 'owner',
    source_note: null,
    evidence_document_id: null,
    recorded_by: null,
    recorded_at: `2026-10-17T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    superseded_by: null,
    ...opts,
  }
}

const Y = 2024
const roster = (names: string[]) => fact('owners.roster', names.map(name => ({
  name, kind: 'individual', pct_end: 100 / names.length, us_person: true, officer: true, partner_type: null,
})), { tax_year: Y })

describe('computeFactGaps — the list itself', () => {
  it('with nothing answered, lists every 1120-S fact and answers none', () => {
    const gaps = computeFactGaps({ formType: '1120S', taxYear: Y, facts: [] })
    const listed = new Set(gaps.map(g => g.key))
    for (const d of factsFor('1120S')) expect(listed.has(d.key), d.key).toBe(true)
    expect(gaps.every(g => g.status === 'missing' || g.status === 'not_applicable')).toBe(true)
    // Owner facts cannot be asked per owner until the owners are known.
    const mp = gaps.find(g => g.key === 'owners.material_participation')!
    expect(mp.needs_subjects_from).toBe('owners.roster')
    // A gated fact is still asked — flagged as conditional, not dropped.
    const loans = gaps.find(g => g.key === 'loans.from_related_entities')!
    expect(loans.status).toBe('missing')
    expect(loans.conditional_on).toEqual(['loans.from_related_entities_exist'])
  })

  it('lists the same facts for every year of the same return type', () => {
    const keys = (y: number) => [...new Set(computeFactGaps({ formType: '1120S', taxYear: y, facts: [] }).map(g => g.key))].sort()
    expect(keys(2021)).toEqual(keys(2024))
    // …even where a fact did not exist in law: it is shown as not applicable.
    const erc = computeFactGaps({ formType: '1120S', taxYear: 2024, facts: [] }).find(g => g.key === 'payroll.erc_claimed')!
    expect(erc).toMatchObject({ status: 'not_applicable', not_applicable_reason: 'not_in_law_this_year' })
  })

  it('never lists a fact for the wrong return type', () => {
    const keys = computeFactGaps({ formType: '1040', taxYear: Y, facts: [] }).map(g => g.key)
    expect(keys).toContain('k1.material_participation')
    expect(keys).not.toContain('scorp.election_effective_date')
    expect(keys).not.toContain('owners.material_participation')
  })

  it('a gate answered "no" turns its dependents into not_applicable; "yes" makes them plainly missing', () => {
    const no = computeFactGaps({ formType: '1120S', taxYear: Y, facts: [fact('loans.from_related_entities_exist', false, { tax_year: Y })] })
    expect(no.find(g => g.key === 'loans.from_related_entities')).toMatchObject({ status: 'not_applicable', not_applicable_reason: 'condition' })
    const yes = computeFactGaps({ formType: '1120S', taxYear: Y, facts: [fact('loans.from_related_entities_exist', true, { tax_year: Y })] })
    const g = yes.find(x => x.key === 'loans.from_related_entities')!
    expect(g.status).toBe('missing')
    expect(g.conditional_on).toBeUndefined()
  })

  it('a gate answered "unknown" keeps its dependents asked, conditionally', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [fact('loans.from_owners_exist', null, { tax_year: Y, status: 'unknown' })],
    })
    expect(gaps.find(g => g.key === 'loans.from_owners_exist')!.status).toBe('unknown')
    expect(gaps.find(g => g.key === 'loans.from_owners')).toMatchObject({ status: 'missing', conditional_on: ['loans.from_owners_exist'] })
  })

  it('asks owner facts once per owner on the roster, matching names loosely', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [
        roster(['Owner A', 'Owner B']),
        fact('owners.material_participation', 'test_1_over_500_hours', { tax_year: Y, subject: 'owner  a' }),
      ],
    })
    const mp = gaps.filter(g => g.key === 'owners.material_participation')
    expect(mp.map(g => [g.subject, g.status])).toEqual([['Owner A', 'answered'], ['Owner B', 'missing']])
    // All-years owner facts read the same roster.
    expect(gaps.filter(g => g.key === 'owners.basis_at_inception').map(g => g.subject)).toEqual(['Owner A', 'Owner B'])
  })

  it('keeps answers for someone no longer on the roster visible', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [roster(['Owner A']), fact('owners.distributions', 5000, { tax_year: Y, subject: 'Former Owner' })],
    })
    expect(gaps.filter(g => g.key === 'owners.distributions').map(g => g.subject)).toEqual(['Owner A', 'Former Owner'])
  })

  it('an empty roster means nobody to ask about, not a missing answer', () => {
    const gaps = computeFactGaps({ formType: '1040', taxYear: Y, facts: [fact('k1.received', [], { tax_year: Y })] })
    expect(gaps.find(g => g.key === 'k1.material_participation')).toMatchObject({ status: 'not_applicable', not_applicable_reason: 'no_subjects' })
  })

  it('reads all-years answers and this year\'s answers from the right coordinates', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [
        fact('scorp.election_effective_date', '2021-10-25'),
        fact('entity.accounting_method', 'accrual', { tax_year: 2023 }), // another year: not this return's answer
      ],
    })
    expect(gaps.find(g => g.key === 'scorp.election_effective_date')!.status).toBe('answered')
    expect(gaps.find(g => g.key === 'entity.accounting_method')!.status).toBe('missing')
  })

  it('summarises by status', () => {
    const gaps = computeFactGaps({ formType: '1065', taxYear: Y, facts: [fact('partnership.section_754_election', false)] })
    const s = summarizeGaps(gaps)
    expect(s.total).toBe(gaps.length)
    expect(s.answered).toBe(1)
    expect(s.answered + s.missing + s.not_applicable + s.unknown + s.contradicted).toBe(s.total)
  })
})

describe('computeFactGaps — against the filed return', () => {
  const lines = (map: Record<string, unknown>) =>
    (sel: CatalogSelector) => map[`${sel.form}:${sel.section ?? ''}:${sel.line}:${sel.col ?? ''}`]

  it('marks an answer the return contradicts, with the line and its value', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [fact('scorp.election_effective_date', '2021-10-25')],
      catalogLookup: lines({ 'f1120s::A:': '10/26/2021' }),
    })
    expect(gaps.find(g => g.key === 'scorp.election_effective_date')).toMatchObject({
      status: 'contradicted', catalog_value: '10/26/2021', catalog_line: { form: 'f1120s', line: 'A' },
    })
  })

  it('keeps an answer the return agrees with, citing the line', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [fact('scorp.election_effective_date', '2021-10-25')],
      catalogLookup: lines({ 'f1120s::A:': '10/25/2021' }),
    })
    expect(gaps.find(g => g.key === 'scorp.election_effective_date')).toMatchObject({ status: 'answered', catalog_value: '10/25/2021' })
  })

  it('sums list rows before comparing — a related-company loan on line 19 shows up', () => {
    const loans = [{
      lender: 'Owner A', direct_from_owner: true, balance_begin: 0, advances: 40000, repayments: 0,
      balance_end: 40000, written_note: true, interest_rate: null, note_date: null,
    }]
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [fact('loans.from_owners_exist', true, { tax_year: Y }), fact('loans.from_owners', loans, { tax_year: Y })],
      // Schedule L line 19 also carries a related company's 150,000.
      catalogLookup: lines({ 'f1120s:Schedule L:19:d': 190000 }),
    })
    expect(gaps.find(g => g.key === 'loans.from_owners')).toMatchObject({ status: 'contradicted', catalog_value: 190000 })
  })

  it('never raises a contradiction from a line marked related', () => {
    const gaps = computeFactGaps({
      formType: '1040', taxYear: Y,
      facts: [
        fact('k1.received', [{ issuer: 'S Co', issuer_form: '1120S', pct_end: 100, date_received: null }], { tax_year: Y }),
        fact('k1.material_participation', 'test_1_over_500_hours', { tax_year: Y, subject: 'S Co' }),
      ],
      catalogLookup: () => 99999,
    })
    expect(gaps.find(g => g.key === 'k1.material_participation')!.status).toBe('answered')
  })

  it('offers what the return shows for a missing derivable fact, without answering it', () => {
    const gaps = computeFactGaps({
      formType: '1120S', taxYear: Y, facts: [],
      catalogLookup: lines({ 'f1120s::B:': '541213' }),
    })
    expect(gaps.find(g => g.key === 'entity.naics_code')).toMatchObject({ status: 'missing', catalog_value: '541213' })
  })

  it('passes the subject and year to the lookup so it can pick the right K-1', () => {
    const seen: string[] = []
    computeFactGaps({
      formType: '1120S', taxYear: Y,
      facts: [roster(['Owner A']), fact('owners.distributions', 1000, { tax_year: Y, subject: 'Owner A' })],
      catalogLookup: (sel, ctx) => { if (ctx.key === 'owners.distributions') seen.push(`${sel.form}/${ctx.subject}/${ctx.tax_year}`); return undefined },
    })
    expect(seen).toContain('f1120ssk/Owner A/2024')
  })
})

describe('currentFactIndex', () => {
  it('ignores superseded rows and keeps the later of two current rows', () => {
    const old = fact('entity.naics_code', '541211', { tax_year: Y, recorded_at: '2026-01-01T00:00:00Z', superseded_by: 'x' })
    const a = fact('entity.naics_code', '541213', { tax_year: Y, recorded_at: '2026-02-01T00:00:00Z' })
    const b = fact('entity.naics_code', '541214', { tax_year: Y, recorded_at: '2026-03-01T00:00:00Z' })
    const idx = currentFactIndex([b, old, a])
    expect([...idx.values()].map(r => r.value)).toEqual(['541214'])
  })
})

describe('compareWithCatalog', () => {
  const d = (k: string) => getFactDef(k)!
  const sel = (o: Partial<CatalogSelector> = {}): CatalogSelector => ({ form: 'f1120s', line: '1', ...o })

  it('dates: reads the IRS MM/DD/YYYY format', () => {
    expect(compareWithCatalog(d('entity.formation_date'), '2021-03-05', '03/05/2021', sel())).toBe('agree')
    expect(compareWithCatalog(d('entity.formation_date'), '2021-03-05', '3/6/2021', sel())).toBe('disagree')
    expect(compareWithCatalog(d('entity.formation_date'), '2021-03-05', 'sometime in 2021', sel())).toBe('not_comparable')
  })

  it('bools: a ticked box reads as true', () => {
    expect(compareWithCatalog(d('entity.final_or_dissolved'), true, true, sel())).toBe('agree')
    expect(compareWithCatalog(d('entity.final_or_dissolved'), false, 'X', sel())).toBe('disagree')
  })

  it('amounts: whole-dollar rounding is not a disagreement; parentheses compare by magnitude', () => {
    expect(compareWithCatalog(d('owners.distributions'), 1234.4, 1234, sel())).toBe('agree')
    expect(compareWithCatalog(d('owners.distributions'), 1234, 1236, sel())).toBe('disagree')
    expect(compareWithCatalog(d('carryover.capital_loss_short_term_in'), 3000, -3000, sel({ shown_negative: true }))).toBe('agree')
    // The catalog normalises amounts to numbers; a string is not something to parse here.
    expect(compareWithCatalog(d('owners.distributions'), 1234, '1,234', sel())).toBe('not_comparable')
  })

  it('enums: compares the printed option, and an unreadable one is not a contradiction', () => {
    expect(compareWithCatalog(d('entity.accounting_method'), 'accrual', 'Accrual', sel())).toBe('agree')
    expect(compareWithCatalog(d('entity.accounting_method'), 'cash', 'Accrual', sel())).toBe('disagree')
    expect(compareWithCatalog(d('entity.accounting_method'), 'cash', 'Hybrid (see stmt)', sel())).toBe('not_comparable')
  })

  it('lists compare only through an aggregate', () => {
    const rows = [{ name: 'A' }, { name: 'B' }] as any
    expect(compareWithCatalog(d('owners.roster'), rows, 2, sel({ aggregate: { op: 'count' } }))).toBe('agree')
    expect(compareWithCatalog(d('owners.roster'), rows, 3, sel({ aggregate: { op: 'count' } }))).toBe('disagree')
    expect(compareWithCatalog(d('owners.roster'), rows, 2, sel())).toBe('not_comparable')
  })

  it('related lines never compare', () => {
    expect(compareWithCatalog(d('owners.distributions'), 1, 999, sel({ relation: 'related' }))).toBe('not_comparable')
  })
})

describe('checkFactInput', () => {
  const base = { entity_id: 'e1', source: 'owner' }

  it('refuses keys the registry does not define, suggesting neighbours', () => {
    const r = checkFactInput({ ...base, fact_key: 'scorp.election_date', value: '2021-10-25' }, '1120S')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.field).toBe('fact_key')
      expect(r.similar).toContain('scorp.election_effective_date')
    }
  })

  it('refuses a fact for another return type', () => {
    const r = checkFactInput({ ...base, fact_key: 'scorp.election_effective_date', value: '2021-10-25' }, '1040')
    expect(r).toMatchObject({ ok: false, field: 'fact_key' })
  })

  it('checks coordinates against the fact\'s scope', () => {
    expect(checkFactInput({ ...base, fact_key: 'entity.accounting_method', value: 'cash' }, '1120S'))
      .toMatchObject({ ok: false, field: 'tax_year' })
    expect(checkFactInput({ ...base, fact_key: 'scorp.election_effective_date', value: '2021-10-25', tax_year: 2024 }, '1120S'))
      .toMatchObject({ ok: false, field: 'tax_year' })
    expect(checkFactInput({ ...base, fact_key: 'owners.material_participation', value: 'test_1_over_500_hours', tax_year: 2024 }, '1120S'))
      .toMatchObject({ ok: false, field: 'subject' })
  })

  it('an answer needs a value; unknown and not-applicable carry none', () => {
    expect(checkFactInput({ ...base, fact_key: 'scorp.prior_c_corp_history', status: 'answered' }, '1120S'))
      .toMatchObject({ ok: false, field: 'value' })
    expect(checkFactInput({ ...base, fact_key: 'scorp.prior_c_corp_history', status: 'unknown', value: true }, '1120S'))
      .toMatchObject({ ok: false, field: 'value' })
    expect(checkFactInput({ ...base, fact_key: 'scorp.prior_c_corp_history', status: 'unknown' }, '1120S').ok).toBe(true)
  })

  it('refuses a bad status, source or value type', () => {
    expect(checkFactInput({ ...base, fact_key: 'scorp.prior_c_corp_history', status: 'maybe', value: true }, '1120S'))
      .toMatchObject({ ok: false, field: 'status' })
    expect(checkFactInput({ entity_id: 'e1', source: 'gut_feeling', fact_key: 'scorp.prior_c_corp_history', value: true }, '1120S'))
      .toMatchObject({ ok: false, field: 'source' })
    expect(checkFactInput({ ...base, fact_key: 'owners.distributions', tax_year: 2024, subject: 'A', value: '$5,000' }, '1120S'))
      .toMatchObject({ ok: false, field: 'value' })
  })

  it('normalises a good write', () => {
    const r = checkFactInput({
      ...base, fact_key: 'owners.material_participation', tax_year: '2024', subject: '  Owner   A ',
      value: 'test_1_over_500_hours', source_note: '  owner, call 2026-10-17 ', recorded_by: 'mcp',
    }, '1120S')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fact.row).toMatchObject({
        tax_year: 2024, subject: 'Owner A', status: 'answered',
        value: 'test_1_over_500_hours', source_note: 'owner, call 2026-10-17', recorded_by: 'mcp',
      })
    }
  })
})

describe('recordFact — supersede, never overwrite', () => {
  beforeAll(() => {
    // Plaintext path: encryptedFields/hydrate are no-ops without a KMS key, so
    // the call sequence below is exactly the database traffic.
    delete process.env.TAX_API_KMS_KEY
  })

  /** Minimal stand-in for the supabase-js builder: records every call, answers from fixtures. */
  function fakeSupabase(currentRows: Array<{ id: string; subject: string | null }>) {
    const log: Array<{ op: string; filters: any[][]; payload?: any }> = []
    const client = {
      from(_table: string) {
        const state: { op: string; filters: any[][]; payload?: any } = { op: 'select', filters: [] }
        const b: any = {}
        for (const m of ['select', 'eq', 'is', 'in', 'order', 'or', 'single']) {
          b[m] = (...args: any[]) => {
            if (m === 'select' && state.op !== 'select') return b
            state.filters.push([m, ...args])
            return b
          }
        }
        b.insert = (row: any) => { state.op = 'insert'; state.payload = row; return b }
        b.update = (patch: any) => { state.op = 'update'; state.payload = patch; return b }
        b.then = (resolve: any, reject: any) => {
          log.push(state)
          let data: any
          if (state.op === 'insert') data = { id: 'new', recorded_at: '2026-10-17T12:00:00Z', superseded_by: null, ...state.payload }
          else if (state.op === 'update') data = (state.filters.find(f => f[0] === 'in')?.[2] || []).map((id: string) => ({ id }))
          else data = currentRows
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        }
        return b
      },
    }
    return { client: client as any, log }
  }

  it('reads the current answer first, inserts the new one, then points the old one at it', async () => {
    const { client, log } = fakeSupabase([
      { id: 'old-a', subject: 'Owner A' },
      { id: 'other', subject: 'Owner B' },
    ])
    const checked = checkFactInput({
      entity_id: 'e1', fact_key: 'owners.material_participation', tax_year: 2024, subject: 'owner  a',
      value: 'test_1_over_500_hours', source: 'owner',
    }, '1120S')
    if (!checked.ok) throw new Error(checked.error)

    const out = await recordFact(client, 'u1', checked.fact)

    expect(log.map(l => l.op)).toEqual(['select', 'insert', 'update'])
    // Only the same coordinate (subject matched loosely) is superseded — not Owner B.
    expect(log[2].payload).toEqual({ superseded_by: 'new' })
    expect(log[2].filters).toContainEqual(['in', 'id', ['old-a']])
    expect(log[2].filters).toContainEqual(['is', 'superseded_by', null])
    // Every query is fenced to the caller.
    for (const l of [log[0], log[2]]) expect(l.filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect(log[1].payload).toMatchObject({ user_id: 'u1', fact_key: 'owners.material_participation', subject: 'owner a', tax_year: 2024 })
    expect(out.superseded).toEqual(['old-a'])
    expect(out.fact).not.toHaveProperty('user_id')
  })

  it('a first answer supersedes nothing and issues no update', async () => {
    const { client, log } = fakeSupabase([])
    const checked = checkFactInput({ entity_id: 'e1', fact_key: 'scorp.election_effective_date', value: '2021-10-25', source: 'document' }, '1120S')
    if (!checked.ok) throw new Error(checked.error)
    const out = await recordFact(client, 'u1', checked.fact)
    expect(log.map(l => l.op)).toEqual(['select', 'insert'])
    expect(log[0].filters).toContainEqual(['is', 'tax_year', null])
    expect(out.superseded).toEqual([])
  })
})
