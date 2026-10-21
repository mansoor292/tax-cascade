/**
 * The golden schema (2026-10-20): every box keyed, the same key in every year
 * the box exists, transcript lines landing on those keys, and the golden view
 * built from them. Uses the committed IRS form data (data/line_dicts,
 * data/schema) — no taxpayer data.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import type { CatalogEntry, LineDict } from '../catalog/types.js'
import { buildFormSchema, normLabel, generatedKey, parseEngineKey } from './crosswalk.js'
import { SCHEMA_DIR, formSchema, keyFor, goldenKey, keyEntries, placeIn, revForYear } from './index.js'
import { auditTable, resolveBox, transcriptKey } from './transcript_map.js'
import { goldenRows, heldYear, keyLineRefs } from './golden.js'
import { validateFieldValues } from '../maps/canonical_schema.js'

const DICTS = join(SCHEMA_DIR, '..', 'line_dicts')
const dicts = (form: string): LineDict[] => readdirSync(DICTS).filter(f => f.startsWith(`${form}--`))
  .map(f => JSON.parse(gunzipSync(readFileSync(join(DICTS, f))).toString()) as LineDict)
const widgetAt = (form: string, rev: string, line: string, section = '', kind = 'text') =>
  dicts(form).find(d => d.rev === rev)!.widgets.filter(w => w.section === section && w.line === line && w.kind === kind)

describe('golden schema: one key per box, the same key every year', () => {
  it('normalises a description so a renumbered line reads alike', () => {
    expect(normLabel('Ordinary business income (loss). Subtract line 20 from line 6'))
      .toBe(normLabel('Ordinary business income (loss). Subtract line 21 from line 6'))
    expect(normLabel('Enter amount from line 27: a. Credited to 2026 estimated tax'))
      .toBe(normLabel('Enter amount from line 27: Credited to 2025 estimated tax'))
  })

  it('1120-S ordinary business income: line 21 in 2022, line 22 from 2023 — one key', () => {
    const [w22] = widgetAt('f1120s', '2022', '21')
    const [w25] = widgetAt('f1120s', '2025', '22')
    expect(keyFor('f1120s', '2022', w22.name)).toBe(keyFor('f1120s', '2025', w25.name))
    expect(keyFor('f1120s', '2022', w22.name)).toBe('tax.L22_ordinary_income')
  })

  it('1120-S 2022 "Other deductions" (line 19) is 2023+ line 20, not the new energy line 19', () => {
    const [w] = widgetAt('f1120s', '2022', '19')
    expect(keyFor('f1120s', '2022', w.name)).toBe('deductions.L20_other')
  })

  it('a 2025 1040 split line keeps its key (line 11 → 11a; 16 "Tax" → "Amount")', () => {
    const [agi24] = widgetAt('f1040', '2024', '11')
    const [agi25] = widgetAt('f1040', '2025', '11a')
    expect(keyFor('f1040', '2024', agi24.name)).toBe(keyFor('f1040', '2025', agi25.name))
    const tax24 = widgetAt('f1040', '2024', '16').sort((a, b) => a.rect[0] - b.rect[0]).pop()!
    const tax25 = widgetAt('f1040', '2025', '16').sort((a, b) => a.rect[0] - b.rect[0]).pop()!
    expect(keyFor('f1040', '2024', tax24.name)).toBe('tax.L16_income_tax')
    expect(keyFor('f1040', '2025', tax25.name)).toBe('tax.L16_income_tax')
  })

  it('every box of every revision has exactly one key, unique within its revision', () => {
    const index = JSON.parse(readFileSync(join(SCHEMA_DIR, 'index.json'), 'utf8'))
    for (const form of Object.keys(index.forms)) {
      const s = formSchema(form)!
      for (const d of dicts(form)) {
        const map = s.revisions[d.rev]
        // (a field listed twice under one name is one field)
        const fields = new Set(d.widgets.map(w => w.name)).size
        expect(Object.keys(map).length, `${form} ${d.rev}`).toBe(fields)
        expect(new Set(Object.values(map)).size, `${form} ${d.rev} keys unique`).toBe(fields)
      }
    }
  })

  it('the fill maps\' verified keys are kept, except where the IRS description contradicts them (recorded)', () => {
    const index = JSON.parse(readFileSync(join(SCHEMA_DIR, 'index.json'), 'utf8'))
    for (const form of ['f1040', 'f1120', 'f1120s']) {
      const conflicts = new Set<string>((index.forms[form].conflicts ?? []).map((c: { widget: string; rev: string }) => `${c.rev}|${c.widget}`))
      for (const d of dicts(form)) for (const w of d.widgets) {
        if (!w.canonical || conflicts.has(`${d.rev}|${w.name}`)) continue
        const k = keyFor(form, d.rev, w.name)!
        expect(k === w.canonical || goldenKey(form, w.canonical) === k, `${form} ${d.rev} ${w.name}`).toBe(true)
      }
    }
    // The two fill-map defects the crosswalk found on 2026-10-20 are fixed:
    // the 2022 1040 header was two boxes off (first name in the SSN box) and
    // the 2024 1120 title sat on the preparer's firm-address box. The only
    // conflict left is the 2025 1040 line 1h split, where the map is kept.
    const c = (form: string) => (index.forms[form].conflicts ?? []).filter((x: { kept?: string }) => x.kept !== 'map')
    expect(c('f1040')).toEqual([])
    expect(c('f1120')).toEqual([])
    const box = (form: string, rev: string, name: string) => keyFor(form, rev, dicts(form).find(d => d.rev === rev)!.widgets.find(w => w.name.endsWith(name))!.name)
    expect(box('f1040', '2022', '.f1_02[0]')).toBe('meta.first_name')
    expect(box('f1040', '2022', '.f1_04[0]')).toBe('meta.ssn')
    expect(box('f1120', '2024', '.f1_52[0]')).toBe('meta.title')
  })

  it('engine keys sit on the amount box of their line, never a check box', () => {
    const s = formSchema('f1040s2')!
    const k = s.byKey.get('sched2.L4_se_tax')!
    expect(k.kind).toBe('text')
    expect(parseEngineKey('schedD.L1a_proceeds_d')).toEqual({ prefix: 'schedD', token: 'L1a', col: 'd' })
  })

  it('a rebuilt form reproduces the committed schema (the artifact is current)', () => {
    const fresh = buildFormSchema('f1120ssk', dicts('f1120ssk'), [])
    expect(fresh.revisions).toEqual(formSchema('f1120ssk')!.revisions)
  })

  it('generated keys pass the field_values validator for their return type', () => {
    const bad = [['1120S', ['f1120s', 'f1120ssk', 'f1125a']], ['1040', ['f1040', 'f1040se', 'f8995a']], ['1120', ['f1120', 'f1120x', 'f4562']]]
      .flatMap(([ft, forms]) => (forms as string[]).flatMap(f => formSchema(f)!.keys.map(k => k.key)).filter(k => !validateFieldValues({ [k]: 1 }, ft as string).ok).map(k => `${ft} ${k}`))
    expect(bad).toEqual([])
    expect(generatedKey('f1120ssk', { section: 'Part III', line: '1', label: 'Ordinary business income (loss)', kind: 'text' })).toBe('f1120ssk.L1_ordinary_business_income_loss')
  })
})

describe('IRS return transcript lines → golden keys', () => {
  it('every curated line resolves to exactly one schema key', () => {
    for (const t of ['1120S', '1120', '1040']) {
      const bad = auditTable(t).filter(a => a.error)
      expect(bad, t).toEqual([])
    }
  })

  it('maps the IRS\'s wording onto the box, as filed and as recomputed', () => {
    expect(transcriptKey('1120S', 'Deductions', 'Ordinary Income/Loss')).toEqual({ form: 'f1120s', key: 'tax.L22_ordinary_income', variant: 'as_filed' })
    expect(transcriptKey('1120S', 'Deductions', 'Ordinary Income/Loss Per Computer')?.variant).toBe('irs_computed')
    expect(transcriptKey('1040', 'Refund or Amount Owed', 'Refund amount')?.sign).toBe(-1)
    expect(transcriptKey('1120S', 'Form 3800 General Business Credit', 'F7207 Registration Number')).toBeUndefined()
    const r = resolveBox('f1120s|Schedule L|24|d')
    expect('error' in r ? r.error : r.key).toBe(transcriptKey('1120S', 'Schedule L - Balance Sheets per Books', 'Retained Earnings End of Tax Year')?.key)
  })
})

describe('the golden view', () => {
  let n = 0
  const e = (p: Partial<CatalogEntry>): CatalogEntry => ({ id: `g${++n}`, form: 'f1120s', title: 'Form 1120-S', rev: '2024', instance: '', page: 1, section: '', line: '', label: '', desc: '', kind: 'amount', value: 0, raw: '', method: 'geometry', ...p })
  const K = (ref: string) => { const r = resolveBox(ref); if ('error' in r) throw new Error(r.error); return r.key }
  const tl = (section: string, line: string, value: number) => e({ form: 'irs_return_transcript', section, line, label: line, value })

  it('lines up filed, IRS and stored returns on one key, the IRS figure golden', () => {
    const rows = goldenRows({
      formType: '1120S', year: 2024,
      filed: { id: 'f', entries: [e({ line: '22', value: 162_007, canonical: K('f1120s||22|') }), e({ line: '7', value: 60_000, canonical: K('f1120s||7|') })] },
      transcript: { id: 't', entries: [tl('Deductions', 'Ordinary Income/Loss', 162_007), tl('Deductions', 'Ordinary Income/Loss Per Computer', 0), tl('Deductions', 'Compensation of Officers', 65_000)] },
      returns: [{ id: 'r1234567', label: 'amendment', field_values: { 'tax.L22_ordinary_income': 150_000 } }],
    })
    const obi = rows.find(r => r.key === 'tax.L22_ordinary_income')!
    expect(obi).toMatchObject({ status: 'agrees', golden: 162_007, golden_from: 'irs', headline: true })
    expect(obi.returns?.amendment.value).toBe(150_000)
    expect(obi.irs_computed).toBeUndefined() // the IRS's 0 is "not computed", not a recomputation
    expect(rows.find(r => r.key === K('f1120s||7|'))).toMatchObject({ status: 'differs', golden: 65_000 })
  })

  it('a refund the IRS prints as a credit compares as the positive amount on the form', () => {
    const rows = goldenRows({
      formType: '1040', year: 2023,
      filed: { id: 'f', entries: [e({ form: 'f1040', rev: '2023', line: '35a', value: 161_945, canonical: 'refund.L35a_refunded' })] },
      transcript: { id: 't', entries: [tl('Refund or Amount Owed', 'Refund amount', -161_945)] },
    })
    expect(rows.find(r => r.key === 'refund.L35a_refunded')?.status).toBe('agrees')
  })

  it('a transcript holding another year\'s return is named, and never golden', () => {
    const f = (y: number, v: [number, number, number, number]) => [
      e({ rev: String(y), line: '1a', value: v[0], canonical: K('f1120s||1a|') }), e({ rev: String(y), line: '6', value: v[1], canonical: K('f1120s||6|') }),
      e({ rev: String(y), line: '21', value: v[2], canonical: K('f1120s||21|') }), e({ rev: String(y), line: '22', value: v[3], canonical: K('f1120s||22|') }),
    ]
    const t = [tl('Income', 'Gross Receipts', 8_000_000), tl('Income', 'Total Income', 5_000_000), tl('Deductions', 'Total Deductions', 2_000_000), tl('Deductions', 'Ordinary Income/Loss', 3_000_000)]
    const byYear = new Map([[2023, f(2023, [8_000_000, 5_000_000, 2_000_000, 3_000_000])], [2024, f(2024, [2_100_000, 1_500_000, 1_400_000, 100_000])]])
    expect(heldYear('1120S', 2024, t, byYear)).toBe(2023)
    expect(heldYear('1120S', 2023, t, byYear)).toBeUndefined()
    const rows = goldenRows({ formType: '1120S', year: 2024, filed: { id: 'f', entries: byYear.get(2024)! }, transcript: { id: 't', entries: t, holdsYear: 2023 } })
    expect(rows.find(r => r.key === 'tax.L22_ordinary_income')).toMatchObject({ golden: 100_000, golden_from: 'filed', status: 'differs' })
  })

  it('prints the line and words of the form the year was filed on', () => {
    const agi = K('f1040||11a|') // the 2025 form's line 11a
    expect(placeIn('f1040', agi, '2023')).toMatchObject({ line: '11' })
    expect(placeIn('f1040', agi, '2025')).toMatchObject({ line: '11a' })
    expect(revForYear('f7203', 2023)).toBe('2022') // revised irregularly
    expect(revForYear('f1040', 2019)).toBe('2021') // older than any revision: the oldest
    const rows = goldenRows({
      formType: '1040', year: 2023,
      filed: { id: 'f', entries: [e({ form: 'f1040', rev: '2023', line: '11', value: 3_440_652, canonical: agi }), e({ form: 'f1040', rev: '2023', line: '26', value: 1_250_000, canonical: 'payments.L26_estimated' })] },
      // a row no filed box names takes the year's revision too
      documents: { label: 'docs', lines: [{ form: 'f1040', key: K('f1040||13a|'), value: 501_393, sources: [] }] },
    })
    expect(rows.find(r => r.key === agi)).toMatchObject({ line: '11', headline: true })
    expect(rows.find(r => r.key === 'payments.L26_estimated')?.label).toMatch(/^2023 estimated tax payments/)
    expect(rows.find(r => r.key === K('f1040||13a|'))?.line).toBe('13')
  })

  it('marks the key lines: the main form\'s numbered lines and the listed schedule lines', () => {
    const rows = goldenRows({
      formType: '1040', year: 2025,
      documents: { label: 'docs', lines: [
        { form: 'f1040', key: K('f1040||1a|'), value: 1, sources: [] },
        { form: 'f1040se', key: K('f1040se|Part II|32|'), value: 2, sources: [] },
        { form: 'f1040s1', key: K('f1040s1|Part I|1|'), value: 3, sources: [] },
      ] },
    })
    expect(rows.find(r => r.form === 'f1040')?.key_line).toBe(true)
    expect(rows.find(r => r.form === 'f1040se')?.key_line).toBe(true)
    expect(rows.find(r => r.form === 'f1040s1')?.key_line).toBeUndefined()
    // a schedule printed twice in the PDF: only the first copy is a key line
    const twice = goldenRows({ formType: '1040', year: 2023, filed: { id: 'f', entries: [
      e({ form: 'f1040se', rev: '2023', section: 'Part II', line: '32', value: 9, canonical: K('f1040se|Part II|32|') }),
      e({ form: 'f1040se', rev: '2023', section: 'Part II', line: '32', value: 9, canonical: K('f1040se|Part II|32|'), instance: '#2' }),
    ] } })
    expect(twice.map(r => [r.instance ?? '', !!r.key_line])).toEqual([['', true], ['#2', false]])
    for (const t of ['1120S', '1120', '1040']) for (const ref of keyLineRefs(t)) {
      const [form, section, line] = ref.split('|')
      expect(formSchema(form)?.keys.some(k => k.section === section && k.line === line && k.kind === 'text'), ref).toBe(true)
    }
  })

  it('stored catalogs get golden keys on read, overriding older keys', () => {
    const [w] = widgetAt('f1120s', '2022', '21')
    const [keyed] = keyEntries([e({ rev: '2022', line: '21', widget: w.name })])
    expect(keyed.canonical).toBe('tax.L22_ordinary_income')
  })
})

describe('the books and scenarios on the golden schema', () => {
  // flat P&L in the shape flattenReport produces
  const pnl = {
    'Income > Consulting': 1_000_000,
    'COGS > Subcontractors': 200_000,
    'Expenses > Salaries & Wages': 150_000,
    'Expenses > Rent': 24_000,
    'Expenses > Advertising': 60_000,
    'Expenses > Software': 6_000,
    'OtherIncome > Interest Earned': 1_200,
  }
  it('every classified account lands on its golden key, with the accounts behind it', async () => {
    const { buildCorporateInputsFromQbo } = await import('../maps/qbo_to_inputs.js')
    const { booksToGolden } = await import('./books.js')
    const packet = buildCorporateInputsFromQbo({ pnl, form_type: '1120S' })
    const v = booksToGolden('1120S', packet)
    const at = (ref: string) => { const k = resolveBox(ref); return 'error' in k ? undefined : v.lines.find(l => l.form === k.form && l.key === k.key) }
    expect(at('f1120s||1a|')?.value).toBe(1_000_000)
    expect(at('f1120s||1a|')?.accounts?.[0].account).toContain('Consulting')
    expect(at('f1120s||8|')?.value).toBe(150_000)
    expect(at('f1120s||20|')?.value).toBe(6_000) // no rule → other deductions, never dropped
    expect(at('f1120s|Schedule K|4|')?.value).toBe(1_200) // portfolio interest goes to Schedule K on an S corp
    expect(at('f1120s||21|')).toMatchObject({ value: 240_000, summed: true })
    expect(at('f1120s||22|')).toMatchObject({ value: 1_000_000 - 200_000 - 240_000, summed: true })
    expect(v.unplaced).toEqual([])
  })

  it('a 1120 places interest income on page 1 (line 5), not Schedule K', async () => {
    const { buildCorporateInputsFromQbo } = await import('../maps/qbo_to_inputs.js')
    const { booksToGolden } = await import('./books.js')
    const v = booksToGolden('1120', buildCorporateInputsFromQbo({ pnl, form_type: '1120' }))
    const k5 = resolveBox('f1120||5|')
    expect(v.lines.find(l => 'key' in k5 && l.key === k5.key)?.value).toBe(1_200)
    expect(v.unplaced).toEqual([])
  })

  it('every key the engine writes is a schema key or alias (scenarios and proformas never fall off the view)', async () => {
    const { getEngineToCanonicalMap, CANONICAL_ALIAS_1120, CANONICAL_ALIAS_1120S, CANONICAL_ALIAS_1040 } = await import('../maps/engine_to_pdf.js')
    const { calc1120, calc1120S, calc1040 } = await import('../engine/tax_engine.js')
    const { formOfKey } = await import('./golden.js')
    const inp = { tax_year: 2025, gross_receipts: 1_000_000, cost_of_goods_sold: 200_000, officer_compensation: 100_000, salaries_wages: 50_000, other_deductions: 20_000, wages: 100_000, filing_status: 'mfj' }
    for (const [ft, al, calc] of [['1120', CANONICAL_ALIAS_1120, calc1120], ['1120S', CANONICAL_ALIAS_1120S, calc1120S], ['1040', CANONICAL_ALIAS_1040, calc1040]] as const) {
      const keys = new Set([...Object.values(getEngineToCanonicalMap(ft)), ...Object.values(al), ...Object.keys((calc as (x: object) => { field_values?: object })(inp).field_values ?? {})])
      expect([...keys].filter(k => !formOfKey(ft, k)), ft).toEqual([])
    }
  })

  it('books and scenarios sit on the same row as the filed and IRS figures', () => {
    const K = (ref: string) => { const r = resolveBox(ref); if ('error' in r) throw new Error(r.error); return r.key }
    const rows = goldenRows({
      formType: '1120S', year: 2025,
      filed: { id: 'f', entries: [{ id: 'x', form: 'f1120s', title: '', rev: '2025', instance: '', page: 1, section: '', line: '22', label: '', desc: '', kind: 'amount', value: 500_000, raw: '', method: 'geometry', canonical: K('f1120s||22|') }] },
      books: { label: '2025 books', lines: [{ form: 'f1120s', key: K('f1120s||22|'), value: 560_000, summed: true }] },
      scenarios: [{ id: 's1234567', label: 'pay officer more', field_values: { 'tax.L22_ordinary_income': 440_000 } }],
    })
    const r = rows.find(x => x.key === 'tax.L22_ordinary_income')!
    expect(r.filed?.value).toBe(500_000)
    expect(r.books).toMatchObject({ value: 560_000, summed: true })
    expect(r.books_differs).toBe(true)
    expect(r.scenarios?.['pay officer more'].value).toBe(440_000)
  })
})

describe('field_values hold only golden keys', () => {
  it('a key resolves as a box, an alias, an old descriptive name or a documented non-box value — or is rejected', async () => {
    const { classifyKey, resolveKey, splitBySchema } = await import('./validate.js')
    expect(classifyKey('1120S', 'tax.L22_ordinary_income')).toBe('golden')
    expect(classifyKey('1120S', 'income.gross_receipts')).toBe('golden') // old descriptive import name
    expect(resolveKey('1120S', 'income.gross_receipts')?.key).toBe('income.L1a_gross_receipts')
    expect(resolveKey('1120', 'dep.L23_263a')?.key).toBe('dep.L23a_assets_shown_part_iii') // 2025 split line 23
    expect(resolveKey('1040', 'payments.w2_withholding')?.key).toBe('payments.L25a_w2')
    expect(resolveKey('1040', 'tax.L12_niit')).toEqual({ form: 'f1040s2', key: 'sched2.L12_niit' })
    expect(classifyKey('1120', 'nol.carryover_next_year')).toBe('derived')
    expect(classifyKey('1120', 'schedL.L11_depletable_boy_b')).toBe('rejected') // no such column on line 11a
    const { kept, rejected } = splitBySchema({ 'tax.L22_ordinary_income': 5, 'bogus.L1_thing': 7, 'nol.carryover_next_year': 3 }, '1120S')
    expect(kept).toEqual({ 'tax.L22_ordinary_income': 5, 'nol.carryover_next_year': 3 })
    expect(rejected).toEqual({ 'bogus.L1_thing': 7 })
    expect(splitBySchema({ 'anything.at_all': 1 }, '1065').rejected).toEqual({}) // no 1065 engine: left alone
    expect(validateFieldValues({ 'income.L99_no_such_line': 1 }, '1120S').errors).toEqual(['income.L99_no_such_line: not in the golden schema'])
  })

  it('the return header the persist path writes resolves for every return type', async () => {
    const { entityIdentityFields } = await import('../builders/entity_identity.js')
    const { classifyKey } = await import('./validate.js')
    const ent = { name: 'Example Co', ein: '00-0000000', address: '1 Main St', city: 'Town', state: 'FL', zip: '33000', first_name: 'Pat', last_name: 'Example', ssn: '000-00-0000' }
    for (const ft of ['1120', '1120S', '1040']) {
      const keys = Object.keys(entityIdentityFields(ent as never, ft, {}))
      expect(keys.filter(k => classifyKey(ft, k) === 'rejected'), ft).toEqual([])
    }
  })
})

describe('the source documents on the golden schema', () => {
  const doc = (doc_type: string, key_values: Record<string, string | number>) => ({ doc_type, meta: { key_values } })
  it('W-2s and 1099s land like for like on the 1040 (box 1 on line 1a, box 2 on 25a)', async () => {
    const { documentsToGolden } = await import('./documents.js')
    const v = documentsToGolden('1040', [doc('w2', { box_1: 120000, box_2: 9000 }), doc('1099_int', { box_1: 1500 }), doc('1099_div', { box_1a: 800, box_1b: 600 }), doc('1098', { box_1: 22000 })])
    const at = (ref: string) => { const k = resolveBox(ref); return 'error' in k ? undefined : v.lines.find(l => l.form === k.form && l.key === k.key) }
    expect(at('f1040||1a|')).toMatchObject({ value: 120000, sources: ['1 × W-2'] })
    expect(at('f1040||25a|')?.value).toBe(9000)
    expect(at('f1040||2b|')?.value).toBe(1500)
    expect(at('f1040||3b|')?.value).toBe(800)
    expect(at('f1040||3a|')?.value).toBe(600)
    expect(v.notes.join(' ')).toContain('NOT auto-placed') // the 1098 is a human call
    expect(v.unplaced).toEqual([])
  })

  it('a group S corporation\'s K-1 lands on the owner\'s 1040, box 16 code D on Form 7203', async () => {
    const { k1ToGolden } = await import('./documents.js')
    const e = (line: string, value: number | string, kind: CatalogEntry['kind'] = 'amount'): CatalogEntry => ({ id: `k${line}${value}`, form: 'f1120ssk', title: 'K-1', rev: '2025', instance: '', page: 1, section: 'Part III', line, label: '', desc: '', kind, value, raw: String(value), method: 'geometry' })
    const lines = k1ToGolden([e('1', 1_306_476), e('4', 32_943), e('5a', 511), e('7', 147), e('16', 'C', 'text'), e('16', 4_491), e('16', 'D', 'text'), e('16', 965_784)], 'Example S Corp')
    const at = (ref: string) => { const k = resolveBox(ref); return 'error' in k ? undefined : lines.find(l => l.form === k.form && l.key === k.key) }
    expect(at('f1040se|Part II|32|')).toMatchObject({ value: 1_306_476, sources: ['K-1 from Example S Corp, box 1'] })
    expect(at('f1040||2b|')?.value).toBe(32_943)
    expect(at('f1040sd|Part I|5|')?.value).toBe(147)
    expect(at('f7203|Part I|6|')?.value).toBe(965_784) // code D, not the code C amount
  })

  it('documents sit on the same row as the filed figure, flagged when they do not support it', () => {
    const rows = goldenRows({
      formType: '1040', year: 2025,
      filed: { id: 'f', entries: [{ id: 'x', form: 'f1040', title: '', rev: '2025', instance: '', page: 1, section: '', line: '1a', label: '', desc: '', kind: 'amount', value: 100_000, raw: '', method: 'geometry', canonical: 'income.L1a_w2_wages' }] },
      documents: { label: '2025 documents on file', lines: [{ form: 'f1040', key: 'income.L1a_w2_wages', value: 120_000, sources: ['1 × W-2'] }] },
    })
    const r = rows.find(x => x.key === 'income.L1a_w2_wages')!
    expect(r.documents).toMatchObject({ value: 120_000, sources: ['1 × W-2'] })
    expect(r.documents_differs).toBe(true)
  })
})
