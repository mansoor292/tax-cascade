/**
 * Fact registry invariants (@taxengine/shared facts.ts).
 *
 * The registry is the one standard every return of a type is held to, so a
 * malformed definition does not fail loudly — it silently drops a question
 * from every return at once. These tests are what stop that: every condition
 * points at a real fact that is asked on the same returns, every owner fact on
 * an S-corp or partnership that touches basis/NIIT/QBI is linked to its 1040
 * twin, and every catalog line names a form the fact can actually appear on.
 *
 * packages/shared has no test runner of its own; the suite lives here and
 * imports the package exactly as the API does.
 */
import { describe, it, expect } from 'vitest'
import {
  FACT_DEFS, FACT_DEF_BY_KEY, FACT_FORM_TYPES, FACT_SCOPES, FACT_TYPES, FACT_AREAS, EVIDENCE_KINDS,
  conditionFacts, evaluateRequired, factsFor, getFactDef, scopeHasSubject, scopeIsYearly,
  validateFactCoordinates, validateFactValue,
  type FactCondition, type FactDef, type FactFormType,
} from '@taxengine/shared'

const ISSUER_FORMS: FactFormType[] = ['1120S', '1065']
const COUNTERPART_AREAS = ['basis', 'niit', 'qbi']

/** Which return types each catalogued form slug can appear on. */
const FORM_OWNER: Record<string, FactFormType[]> = {
  f1120s: ['1120S'], f1120ssk: ['1120S'],
  f1120: ['1120'], f1120so: ['1120'],
  f1065: ['1065'], f1065sk1: ['1065'],
  f1125e: ['1120S', '1120'],
  f4562: ['1120S', '1120', '1040', '1065'],
  f1040: ['1040'], f1040s1: ['1040'], f1040sa: ['1040'], f1040sb: ['1040'], f1040sd: ['1040'],
  f1040se: ['1040'], f7203: ['1040'], f8960: ['1040'], f8995a: ['1040'], f8582: ['1040'],
}

const subset = (a: readonly string[], b: readonly string[]) => a.every(x => b.includes(x))
const overlaps = (a: readonly string[], b: readonly string[]) => a.some(x => b.includes(x))

function leaves(c: FactCondition): Array<{ fact: string; values: unknown[] }> {
  if ('all' in c) return c.all.flatMap(leaves)
  if ('any' in c) return c.any.flatMap(leaves)
  if ('equals' in c) return [{ fact: c.fact, values: [c.equals] }]
  if ('not_equals' in c) return [{ fact: c.fact, values: [c.not_equals] }]
  return [{ fact: c.fact, values: [...c.in] }]
}

describe('fact registry — shape', () => {
  it('has a substantial registry with unique, well-formed keys', () => {
    expect(FACT_DEFS.length).toBeGreaterThanOrEqual(80)
    expect(FACT_DEFS.length).toBeLessThanOrEqual(150)
    const keys = FACT_DEFS.map(d => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
    expect(Object.keys(FACT_DEF_BY_KEY)).toHaveLength(keys.length)
  })

  it('every def uses only the published vocabularies', () => {
    for (const d of FACT_DEFS) {
      expect(FACT_SCOPES, d.key).toContain(d.scope)
      expect(FACT_TYPES, d.key).toContain(d.type)
      expect(d.applies_to.length, d.key).toBeGreaterThan(0)
      expect(new Set(d.applies_to).size, d.key).toBe(d.applies_to.length)
      for (const f of d.applies_to) expect(FACT_FORM_TYPES, d.key).toContain(f)
      for (const a of d.affects) expect(FACT_AREAS, d.key).toContain(a)
      expect(d.evidence.length, d.key).toBeGreaterThan(0)
      for (const e of d.evidence) expect(EVIDENCE_KINDS, d.key).toContain(e)
    }
  })

  it('every def asks a real question and says why it matters', () => {
    for (const d of FACT_DEFS) {
      expect(d.question.trim().length, d.key).toBeGreaterThan(20)
      expect(d.question.trim(), d.key).toMatch(/[?.)]$/)
      expect(d.why.trim().length, d.key).toBeGreaterThan(30)
    }
  })

  it('every enum has distinct options; only enums have options', () => {
    for (const d of FACT_DEFS) {
      if (d.type === 'enum') {
        expect(d.options?.length, d.key).toBeGreaterThan(1)
        expect(new Set(d.options).size, d.key).toBe(d.options!.length)
      } else {
        expect(d.options, d.key).toBeUndefined()
      }
    }
  })

  it('every list has item_fields; only lists have them; item fields are well-formed', () => {
    for (const d of FACT_DEFS) {
      if (d.type !== 'list') {
        expect(d.item_fields, d.key).toBeUndefined()
        continue
      }
      const fields = d.item_fields || []
      expect(fields.length, d.key).toBeGreaterThan(0)
      expect(new Set(fields.map(f => f.key)).size, d.key).toBe(fields.length)
      expect(fields.some(f => !f.optional), `${d.key} needs at least one required column`).toBe(true)
      for (const f of fields) {
        expect(FACT_TYPES, `${d.key}.${f.key}`).toContain(f.type)
        expect(f.type, `${d.key}.${f.key}`).not.toBe('list')
        expect(f.label.length, `${d.key}.${f.key}`).toBeGreaterThan(0)
        if (f.type === 'enum') expect(f.options?.length, `${d.key}.${f.key}`).toBeGreaterThan(1)
        else expect(f.options, `${d.key}.${f.key}`).toBeUndefined()
      }
    }
  })

  it('year windows are well-formed', () => {
    for (const d of FACT_DEFS) {
      if (!d.years) continue
      if (d.years.from !== undefined && d.years.to !== undefined) {
        expect(d.years.from, d.key).toBeLessThanOrEqual(d.years.to)
      }
    }
  })

  it('is plain data — survives a JSON round trip unchanged (storable with a review run)', () => {
    expect(JSON.parse(JSON.stringify(FACT_DEFS))).toEqual(FACT_DEFS)
  })
})

describe('fact registry — conditions', () => {
  it('every required_when references an existing, non-list fact asked on the same returns', () => {
    for (const d of FACT_DEFS) {
      if (!d.required_when) continue
      for (const { fact, values } of leaves(d.required_when)) {
        const ref = getFactDef(fact)
        expect(ref, `${d.key} → ${fact}`).toBeDefined()
        expect(fact, d.key).not.toBe(d.key)
        expect(ref!.type, `${d.key} → ${fact} must not be a list`).not.toBe('list')
        // The gate must be asked everywhere the dependent is, or the dependent
        // is stuck "undetermined" on some returns forever.
        expect(subset(d.applies_to, ref!.applies_to), `${d.key} applies wider than its gate ${fact}`).toBe(true)
        for (const v of values) {
          expect(validateFactValue(ref!, v).ok, `${d.key}: ${JSON.stringify(v)} is not a valid ${fact}`).toBe(true)
        }
      }
    }
  })

  it('a condition can be resolved at the dependent fact\'s own coordinates', () => {
    for (const d of FACT_DEFS) {
      if (!d.required_when) continue
      for (const key of conditionFacts(d.required_when)) {
        const ref = getFactDef(key)!
        // An all-years fact cannot hinge on one year's answer…
        if (scopeIsYearly(ref.scope)) expect(scopeIsYearly(d.scope), `${d.key} → ${key}`).toBe(true)
        // …and a fact with no subject cannot hinge on a per-owner answer.
        if (scopeHasSubject(ref.scope)) {
          expect(scopeHasSubject(d.scope), `${d.key} → ${key}`).toBe(true)
          expect(d.subjects_from, `${d.key} → ${key}`).toEqual(ref.subjects_from)
        }
      }
    }
  })

  it('conditions have no cycles', () => {
    const deps = new Map(FACT_DEFS.map(d => [d.key, d.required_when ? conditionFacts(d.required_when) : []]))
    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (k: string): void => {
      if (done.has(k)) return
      expect(visiting.has(k), `cycle through ${k}`).toBe(false)
      visiting.add(k)
      for (const n of deps.get(k) || []) visit(n)
      visiting.delete(k)
      done.add(k)
    }
    for (const k of deps.keys()) visit(k)
  })
})

describe('fact registry — subjects and counterparts', () => {
  it('owner / relationship facts name their subjects from a list fact asked on the same returns', () => {
    for (const d of FACT_DEFS) {
      if (!scopeHasSubject(d.scope)) {
        expect(d.subjects_from, d.key).toBeUndefined()
        continue
      }
      expect(d.subjects_from, d.key).toBeDefined()
      const roster = getFactDef(d.subjects_from!.fact)
      expect(roster, d.key).toBeDefined()
      expect(roster!.type, d.key).toBe('list')
      expect(scopeHasSubject(roster!.scope), `${d.key}: roster must not itself be per-subject`).toBe(false)
      const field = roster!.item_fields!.find(f => f.key === d.subjects_from!.field)
      expect(field?.type, `${d.key}: ${d.subjects_from!.fact}.${d.subjects_from!.field}`).toBe('text')
      expect(field?.optional, d.key).toBeFalsy()
      expect(subset(d.applies_to, roster!.applies_to), `${d.key} applies wider than ${roster!.key}`).toBe(true)
    }
  })

  it('counterparts exist, are symmetric, span issuer ↔ 1040, and agree on shape', () => {
    for (const d of FACT_DEFS) {
      if (!d.counterpart) continue
      const other = getFactDef(d.counterpart)
      expect(other, `${d.key} → ${d.counterpart}`).toBeDefined()
      expect(other!.counterpart, `${d.counterpart} must point back at ${d.key}`).toBe(d.key)
      const [issuer, recipient] = overlaps(d.applies_to, ISSUER_FORMS) ? [d, other!] : [other!, d]
      expect(overlaps(issuer.applies_to, ISSUER_FORMS), `${issuer.key} must apply to 1120S or 1065`).toBe(true)
      expect([...recipient.applies_to], `${recipient.key} must be a 1040 fact`).toEqual(['1040'])
      // Both sides answer the same question, so they must be comparable.
      expect(other!.type, d.key).toBe(d.type)
      expect(other!.options, d.key).toEqual(d.options)
      expect(other!.item_fields, d.key).toEqual(d.item_fields)
    }
  })

  it('every issuer owner-fact touching basis / NIIT / QBI is linked to its 1040 counterpart', () => {
    const unlinked = FACT_DEFS.filter(d =>
      overlaps(d.applies_to, ISSUER_FORMS) &&
      (d.scope === 'owner' || d.scope === 'owner_year') &&
      overlaps(d.affects, COUNTERPART_AREAS) &&
      !d.counterpart).map(d => d.key)
    expect(unlinked).toEqual([])
  })

  it('every 1040 per-K-1 fact touching basis / NIIT / QBI is linked to its issuer counterpart', () => {
    const unlinked = FACT_DEFS.filter(d =>
      d.subjects_from?.fact === 'k1.received' &&
      overlaps(d.affects, COUNTERPART_AREAS) &&
      !d.counterpart).map(d => d.key)
    expect(unlinked).toEqual([])
  })

  it('links the pairs that have cost money when one side was missing', () => {
    const pairs: Array<[string, string]> = [
      ['owners.material_participation', 'k1.material_participation'],
      ['owners.participation_hours', 'k1.participation_hours'],
      ['entity.sstb_determination', 'k1.sstb'],
      ['owners.distributions', 'k1.distributions'],
      ['owners.direct_loan_balance_end', 'k1.direct_loan_balance_end'],
      ['owners.basis_at_inception', 'k1.basis_at_inception'],
      ['owners.suspended_losses_carried_in', 'k1.suspended_losses_carried_in'],
      ['owners.officer_compensation', 'k1.wages_from_issuer'],
    ]
    for (const [a, b] of pairs) {
      expect(getFactDef(a)?.counterpart, a).toBe(b)
      expect(getFactDef(b)?.counterpart, b).toBe(a)
    }
  })
})

describe('fact registry — catalog selectors', () => {
  it('every selector names a known form that the fact can appear on', () => {
    for (const d of FACT_DEFS) {
      for (const s of d.catalog || []) {
        const owners = FORM_OWNER[s.form]
        expect(owners, `${d.key}: unknown form slug ${s.form}`).toBeDefined()
        expect(overlaps(owners, d.applies_to), `${d.key}: ${s.form} is not on a ${d.applies_to.join('/')} return`).toBe(true)
        expect(s.line.length, d.key).toBeGreaterThan(0)
      }
    }
  })

  it('aggregates appear only on lists, and an equals line on a list says how to reduce it', () => {
    for (const d of FACT_DEFS) {
      for (const s of d.catalog || []) {
        if (d.type !== 'list') {
          expect(s.aggregate, `${d.key} ${s.form} ${s.line}`).toBeUndefined()
          continue
        }
        if (s.relation !== 'related') expect(s.aggregate, `${d.key} ${s.form} ${s.line}`).toBeDefined()
        if (s.aggregate?.op === 'sum') {
          const f = d.item_fields!.find(x => x.key === s.aggregate!.field)
          expect(f && ['money', 'number'].includes(f.type), `${d.key}: sum of ${s.aggregate.field}`).toBe(true)
        }
      }
    }
  })

  it('a fact marked derivable has a catalog line that answers it', () => {
    for (const d of FACT_DEFS) {
      if (!d.derive_from_catalog) continue
      expect((d.catalog || []).some(s => s.relation !== 'related'), d.key).toBe(true)
    }
  })

  it('anchors the lines the review depends on', () => {
    const has = (key: string, form: string, line: string, col?: string) =>
      (getFactDef(key)?.catalog || []).some(s => s.form === form && s.line === line && (col === undefined || s.col === col))
    expect(has('scorp.election_effective_date', 'f1120s', 'A')).toBe(true)
    expect(has('k1.material_participation', 'f1040se', '28', 'h')).toBe(true)
    expect(has('k1.material_participation', 'f1040se', '28', 'k')).toBe(true)
    expect(has('k1.material_participation', 'f8960', '4b')).toBe(true)
    expect(has('owners.direct_loan_balance_end', 'f1120ssk', 'I')).toBe(true)
    expect(has('loans.from_owners', 'f1120s', '19', 'd')).toBe(true)
    expect(has('loans.to_owners', 'f1120s', '7', 'd')).toBe(true)
    expect(has('info_returns.form_1099_required', 'f1120s', '14a')).toBe(true)
    expect(has('info_returns.form_1099_filed', 'f1120s', '14b')).toBe(true)
  })
})

describe('fact registry — coverage of what went wrong', () => {
  // Each of these surfaced late, one at a time, because nothing asked for it.
  // If a key here is renamed or dropped, the incident it covers is unguarded.
  const incidents: Array<[string, string, FactFormType]> = [
    ['first-year loss funded by a related company, not the shareholder', 'loans.from_related_entities', '1120S'],
    ['related-company loan shown as a shareholder loan', 'owners.direct_loan_balance_end', '1120S'],
    ['disregarded LLC issuing W-2s under its own EIN', 'entity.disregarded_entities', '1120S'],
    ['which EIN issued the W-2s', 'payroll.w2_issuer', '1120S'],
    ['material participation never recorded (NIIT paid)', 'k1.material_participation', '1040'],
    ['material participation, issuer side', 'owners.material_participation', '1120S'],
    ['S election effective date', 'scorp.election_effective_date', '1120S'],
    ['S election accepted years late (CP261)', 'scorp.election_acceptance_date', '1120S'],
    ['C-corp history / E&P', 'scorp.accumulated_ep_at_election', '1120S'],
    ['loan to shareholder on Schedule L needs documentation', 'loans.to_owners', '1120S'],
    ['business code vs SSTB', 'entity.naics_code', '1120S'],
    ['SSTB determination and its reasoning', 'entity.sstb_rationale', '1120S'],
    ['shareholder share counts', 'owners.shares_end', '1120S'],
    ['shares outstanding', 'corp.shares_outstanding_end', '1120S'],
    ['intercompany fee must match the counterpart, year by year', 'intercompany.fee_expense', '1120'],
    ['intercompany fee, revenue side', 'intercompany.fee_revenue', '1120S'],
    ['state tax deducted in the year paid', 'state.income_tax_payments', '1120'],
    ['misposted / duplicate returns (TC976)', 'irs.duplicate_or_misposted', '1120S'],
    ['IRS penalties', 'irs.penalties', '1120'],
    ['TC150 posting', 'irs.tc150_period', '1040'],
    ['distributions above basis never reported', 'k1.distributions', '1040'],
    ['suspended losses carried in', 'k1.suspended_losses_carried_in', '1040'],
    ['NY nonresident allocation', 'indiv.nonresident_state_income', '1040'],
    ['controlled group / Florida exemption', 'state.florida_exemption_share', '1120'],
  ]
  for (const [what, key, form] of incidents) {
    it(`asks every ${form} return: ${what}`, () => {
      expect(factsFor(form).map(d => d.key)).toContain(key)
    })
  }

  it('gives every return type its own non-trivial list', () => {
    for (const f of FACT_FORM_TYPES) expect(factsFor(f).length, f).toBeGreaterThan(30)
  })

  it('respects year windows — ERC exists only for 2020-2021', () => {
    expect(factsFor('1120S', 2021).map(d => d.key)).toContain('payroll.erc_claimed')
    expect(factsFor('1120S', 2023).map(d => d.key)).not.toContain('payroll.erc_claimed')
    expect(factsFor('1120S').map(d => d.key)).toContain('payroll.erc_claimed')
  })
})

describe('evaluateRequired', () => {
  const dependent = getFactDef('loans.from_related_entities') as FactDef
  const florida = getFactDef('state.florida_exemption_share') as FactDef

  it('a fact with no condition is always required', () => {
    expect(evaluateRequired(getFactDef('scorp.election_effective_date')!, {})).toEqual({ state: 'required', waiting_on: [] })
  })

  it('an unanswered gate leaves it undetermined, naming the gate', () => {
    expect(evaluateRequired(dependent, {})).toEqual({ state: 'undetermined', waiting_on: ['loans.from_related_entities_exist'] })
    expect(evaluateRequired(dependent, { 'loans.from_related_entities_exist': { status: 'unknown' } }).state).toBe('undetermined')
  })

  it('a gate answered yes requires it; no or not-applicable does not', () => {
    expect(evaluateRequired(dependent, { 'loans.from_related_entities_exist': { status: 'answered', value: true } }).state).toBe('required')
    expect(evaluateRequired(dependent, { 'loans.from_related_entities_exist': { status: 'answered', value: false } }).state).toBe('not_required')
    expect(evaluateRequired(dependent, { 'loans.from_related_entities_exist': { status: 'not_applicable' } }).state).toBe('not_required')
  })

  it('all: one "no" settles it; otherwise any unknown keeps it open', () => {
    const yes = { status: 'answered' as const, value: true }
    const no = { status: 'answered' as const, value: false }
    expect(evaluateRequired(florida, { 'state.florida_corporate_filer': no }).state).toBe('not_required')
    expect(evaluateRequired(florida, { 'state.florida_corporate_filer': yes })).toEqual({
      state: 'undetermined', waiting_on: ['corp.controlled_group_member'],
    })
    expect(evaluateRequired(florida, {
      'state.florida_corporate_filer': yes, 'corp.controlled_group_member': yes,
    }).state).toBe('required')
  })

  it('accepts a resolver function as well as a map', () => {
    const r = evaluateRequired(dependent, k => (k === 'loans.from_related_entities_exist' ? { status: 'answered', value: true } : undefined))
    expect(r.state).toBe('required')
  })
})

describe('validateFactValue', () => {
  const def = (k: string) => getFactDef(k)!

  it('dates must be real calendar dates', () => {
    expect(validateFactValue(def('scorp.election_effective_date'), '2021-10-25').ok).toBe(true)
    expect(validateFactValue(def('scorp.election_effective_date'), '2026-02-30').ok).toBe(false)
    expect(validateFactValue(def('scorp.election_effective_date'), '10/25/2021').ok).toBe(false)
  })

  it('bools, enums, percents and money are strictly typed', () => {
    expect(validateFactValue(def('scorp.prior_c_corp_history'), true).ok).toBe(true)
    expect(validateFactValue(def('scorp.prior_c_corp_history'), 'yes').ok).toBe(false)
    expect(validateFactValue(def('entity.accounting_method'), 'cash').ok).toBe(true)
    expect(validateFactValue(def('entity.accounting_method'), 'Cash').ok).toBe(false)
    expect(validateFactValue(def('owners.distributions'), 12500).ok).toBe(true)
    expect(validateFactValue(def('owners.distributions'), '$12,500').ok).toBe(false)
    expect(validateFactValue(def('owners.distributions'), Number.NaN).ok).toBe(false)
  })

  it('text is trimmed and must be non-empty', () => {
    expect(validateFactValue(def('entity.naics_code'), '  541213 ')).toEqual({ ok: true, value: '541213' })
    expect(validateFactValue(def('entity.naics_code'), '   ').ok).toBe(false)
  })

  it('list rows are checked column by column', () => {
    const loans = def('loans.from_owners')
    const row = {
      lender: 'Owner A', direct_from_owner: true, balance_begin: 0, advances: 50000,
      repayments: 0, balance_end: 50000, written_note: false,
    }
    const ok = validateFactValue(loans, [row])
    expect(ok.ok).toBe(true)
    // Optional columns come back as explicit nulls so every row has every key.
    if (ok.ok) expect((ok.value as any)[0]).toMatchObject({ interest_rate: null, note_date: null })
    expect(validateFactValue(loans, []).ok).toBe(true)
    expect(validateFactValue(loans, [{ ...row, direct_from_owner: undefined }]).ok).toBe(false)
    expect(validateFactValue(loans, [{ ...row, colour: 'red' }]).ok).toBe(false)
    expect(validateFactValue(loans, [{ ...row, interest_rate: 140 }]).ok).toBe(false)
    expect(validateFactValue(loans, row).ok).toBe(false)
  })
})

describe('validateFactCoordinates', () => {
  it('per-year facts need a year; all-years facts refuse one', () => {
    expect(validateFactCoordinates(getFactDef('entity.accounting_method')!, {})).toMatch(/tax_year is required/)
    expect(validateFactCoordinates(getFactDef('entity.accounting_method')!, { tax_year: 2024 })).toBeNull()
    expect(validateFactCoordinates(getFactDef('scorp.election_effective_date')!, { tax_year: 2024 })).toMatch(/omit tax_year/)
  })

  it('owner and relationship facts need a subject; others refuse one (except amended returns)', () => {
    expect(validateFactCoordinates(getFactDef('owners.material_participation')!, { tax_year: 2024 })).toMatch(/subject is required/)
    expect(validateFactCoordinates(getFactDef('owners.material_participation')!, { tax_year: 2024, subject: 'Owner A' })).toBeNull()
    expect(validateFactCoordinates(getFactDef('owners.basis_at_inception')!, { subject: 'Owner A' })).toBeNull()
    expect(validateFactCoordinates(getFactDef('entity.accounting_method')!, { tax_year: 2024, subject: 'x' })).toMatch(/does not take a subject/)
    expect(validateFactCoordinates(getFactDef('irs.filing_date')!, { tax_year: 2024, subject: 'amended:1' })).toBeNull()
  })
})
