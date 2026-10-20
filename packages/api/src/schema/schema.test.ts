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
import { SCHEMA_DIR, formSchema, keyFor, goldenKey, keyEntries } from './index.js'
import { auditTable, resolveBox, transcriptKey } from './transcript_map.js'
import { goldenRows, heldYear } from './golden.js'
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
    // the two fill-map defects found 2026-10-20 are on record
    const c = (form: string) => (index.forms[form].conflicts ?? []).map((x: { rev: string; map_says: string }) => `${x.rev} ${x.map_says}`)
    expect(c('f1040')).toContain('2022 meta.first_name')
    expect(c('f1120')).toContain('2024 meta.title')
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

  it('generated keys pass the field_values validator', () => {
    const keys = ['f1120s', 'f1040se', 'f1120ssk', 'f1125a'].flatMap(f => formSchema(f)!.keys.map(k => k.key))
    const bad = keys.filter(k => !validateFieldValues({ [k]: 1 }, '1120S').ok)
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

  it('stored catalogs get golden keys on read, overriding older keys', () => {
    const [w] = widgetAt('f1120s', '2022', '21')
    const [keyed] = keyEntries([e({ rev: '2022', line: '21', widget: w.name })])
    expect(keyed.canonical).toBe('tax.L22_ordinary_income')
  })
})
