/**
 * The base an amendment starts from: the best record of the return as filed.
 *
 * Owner's rule (2026-10-22): "they should find the best source as base for
 * the amendment, which is typically the filed return. Books can agree or
 * disagree with them but that's separate." Before this an amendment started
 * blank — it seeded from the filed row's engine inputs, and a filed import
 * has none — so every computed line read $0 against the filed return and the
 * year row said "Amended" at once (UI audit #22).
 *
 * The base, in order:
 *   1. the filed return in the catalog — its golden values (every box of the
 *      filed PDF; the catalog is the record of the return as filed);
 *   2. the filed return imported here (a filed_import row, the older OCR
 *      import) — its field_values, when no complete catalog exists.
 * Its values are mapped back to the engine's inputs through the engine's own
 * output map, so the amendment recomputes to the filed figures before any
 * line is changed; where it does not, the engine computes that line
 * differently, and the caller is told which lines. Every other filed line —
 * the ones the engine does not compute (Schedule L, Schedule K items, the
 * M-1 facts, Forms 1125-A and 1125-E) — is carried into the amendment as
 * filed (amend_carry, carryFiledLines), and the form's own totals are
 * re-derived from them.
 *
 * 2026-10-24: the import came first, and an amendment of the demo's filed
 * 2022 1120-S differed from the filed return on about 30 lines while the
 * caller was told 5: the import held Schedule L one line off, and a
 * recompute kept only what the engine computes — cost of goods sold detail,
 * the charitable contribution, the M-1/M-2 lines and Form 1125-E were gone.
 * A dropped line is now a difference too.
 *
 * Books and documents are NOT merged into an amendment built from a base
 * (compute's merge_sources: false). Whether they agree is shown beside it,
 * never mixed into it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hydrate, hydrateAll, ENCRYPTED_RETURN_FIELDS, RETURN_ENC_COLS } from '../lib/row_crypto.js'
import { getEngineToCanonicalMap } from '../maps/engine_to_pdf.js'
import { INPUT_SCHEMAS } from '../routes/schema.js'
import { resolveKey } from '../schema/validate.js'
import { goldenKey, keyEntries } from '../schema/index.js'
import type { CatalogEntry } from '../catalog/types.js'

/** Engine inputs the engine's output map does not cover (it maps page-1
 *  lines only), read from the filed return's Schedule K. */
const EXTRA_INPUTS: Record<string, Record<string, string>> = {
  '1120S': {
    schedule_k_interest: 'schedK.L4_interest',
    schedule_k_dividends_ordinary: 'schedK.L5a_dividends',
    schedule_k_dividends_qualified: 'schedK.L5b_qual_div',
    schedule_k_royalties: 'schedK.L6_royalties',
    schedule_k_st_cap_gain: 'schedK.L7_st_gain',
    schedule_k_lt_cap_gain: 'schedK.L8a_lt_gain',
    schedule_k_tax_exempt_interest: 'schedK.L16a_tax_exempt_int',
    schedule_k_nondeductible_expenses: 'schedK.L16c_nondeductible',
    schedule_k_distributions: 'schedK.L16d_distributions',
    schedule_k_other_portfolio_income: 'schedK.L10_other_amount',
    section_179: 'schedK.L11_179',
    charitable_contrib: 'schedK.L12a_cash_charity',
  },
}

/** Lines the form's arithmetic fills only when blank, from lines an
 *  amendment may change: carried as filed, they would stay at the filed
 *  figure. On the 1120-S, M-2 lines 3, 5 and 7 follow Schedule K; on the
 *  1120, M-2 line 2 is M-1 line 1. */
const REDERIVED: Record<string, RegExp> = { '1120S': /^schedM2\.L(3|5|7)_/, '1120': /^schedM2\.L2_/ }

/** The filed lines an amendment carries as filed (see the header). */
export function carriedLines(formType: string, values: Record<string, number>): Record<string, number> {
  if (formType !== '1120S' && formType !== '1120') return {}
  const skip = REDERIVED[formType]
  return Object.fromEntries(Object.entries(values).filter(([k]) => !skip.test(k)))
}

/** Lines the engine fills with a stand-in because it cannot know them: the
 *  1120-S M-1 facts (net income per books, and the items on one side only)
 *  are ordinary income and zeros. The filed figure replaces the stand-in. */
const STAND_INS: Record<string, RegExp> = { '1120S': /^schedM1\.L(1|2|3|5|6)_/ }

/** Fill the amendment with its carried filed lines wherever the engine left a
 *  line alone (by golden key, so an alias the engine wrote counts), and over
 *  the engine's stand-ins. Runs before the schedules' arithmetic, which
 *  re-derives the totals. */
export function carryFiledLines(fv: Record<string, unknown>, carry: unknown, formType: string): void {
  if (!carry || typeof carry !== 'object') return
  const golden = (k: string) => resolveKey(formType, k)?.key ?? k
  const at = new Map(Object.keys(fv).map(k => [golden(k), k]))
  const standIn = STAND_INS[formType]
  for (const [k, v] of Object.entries(carry as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const engineKey = at.get(golden(k))
    if (engineKey !== undefined) {
      if (!standIn?.test(golden(k))) continue
      delete fv[engineKey]
    }
    fv[k] = v
  }
}

export interface AmendmentBase {
  source: 'filed_import' | 'filed_catalog'
  label: string
  return_id?: string
  catalog_id?: string
  /** The base's figures, by golden key */
  values: Record<string, number>
  /** The engine inputs that reproduce them */
  inputs: Record<string, unknown>
}

/** Golden key → value, resolving every alias a stored key may carry. */
export function goldenValues(formType: string, fv: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(fv)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const at = resolveKey(formType, k)
    const key = at?.key ?? k
    if (!(key in out)) out[key] = v
  }
  return out
}

/** The engine inputs that reproduce a set of filed figures. */
export function baseInputs(formType: string, values: Record<string, number>): Record<string, number> {
  const toCanon = { ...getEngineToCanonicalMap(formType), ...(EXTRA_INPUTS[formType] ?? {}) }
  const fields = new Set([
    ...(INPUT_SCHEMAS[formType]?.fields ?? []).filter((f: any) => f.type === 'number').map((f: any) => f.name as string),
    ...Object.keys(EXTRA_INPUTS[formType] ?? {}),
  ])
  fields.delete('tax_year')
  const out: Record<string, number> = {}
  for (const f of fields) {
    const canon = toCanon[f]
    if (!canon) continue
    const key = resolveKey(formType, canon)?.key ?? canon
    const v = values[key]
    if (typeof v === 'number') out[f] = v
  }
  return out
}

/** Golden values of a catalogued filed return: each box of the return and
 *  its schedules, once (no second printed copies, no K-1s — those are the
 *  shareholders' documents, not lines of this return). */
export function catalogValues(entries: CatalogEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of keyEntries(entries)) {
    if (!e.canonical || e.instance || /k1|sk$/.test(e.form)) continue
    const v = typeof e.value === 'number' ? e.value : undefined
    if (v === undefined || !Number.isFinite(v)) continue
    const key = goldenKey(e.form, e.canonical)
    if (!(key in out)) out[key] = v
  }
  return out
}

/** Who the return allocates to: the shareholders the entity's own returns
 *  list (the same year first, else the latest), so an S-corp amendment can
 *  issue its K-1s. A filed import does not carry them as inputs. */
async function shareholdersOf(supabase: SupabaseClient, userId: string, entityId: string, taxYear: number): Promise<unknown[] | undefined> {
  const { data } = await supabase.from('tax_return')
    .select(`tax_year, computed_at, input_data, ${RETURN_ENC_COLS}`)
    .eq('entity_id', entityId).neq('source', 'filed_import')
    .order('computed_at', { ascending: false }).limit(20)
  const rows = data ?? []
  for (const r of rows) await hydrate(supabase, r, { ...ENCRYPTED_RETURN_FIELDS, userId })
  const has = (r: any) => Array.isArray(r?.input_data?.shareholders) && r.input_data.shareholders.length
  const pick = rows.find(r => r.tax_year === taxYear && has(r)) ?? rows.find(has)
  return pick ? (pick as any).input_data.shareholders : undefined
}

/** One catalogued filed return of the caller's, by id: its label and golden
 *  values. A scenario names its base this way when the filed return is held
 *  only in the catalog (no imported row to point base_return_id at). */
export async function filedCatalogBase(
  supabase: SupabaseClient, userId: string, catalogId: string, entityId?: string,
): Promise<{ catalog_id: string; tax_year: number | null; label: string; values: Record<string, number> } | null> {
  let q = supabase.from('return_catalog')
    .select('id, user_id, entity_id, tax_year, source_filename, entries, entries_enc')
    .eq('id', catalogId).eq('user_id', userId).eq('kind', 'filed_return')
  if (entityId) q = q.eq('entity_id', entityId)
  const { data } = await q.maybeSingle()
  if (!data) return null
  const [cat] = await hydrateAll(supabase, [data], { json: ['entries'] })
  return {
    catalog_id: cat.id, tax_year: cat.tax_year ?? null,
    label: `the filed${cat.tax_year ? ` ${cat.tax_year}` : ''} return (${cat.source_filename ?? 'catalogued PDF'})`,
    values: catalogValues((cat.entries as CatalogEntry[] | null) ?? []),
  }
}

export async function amendmentBase(
  supabase: SupabaseClient, userId: string, entityId: string, taxYear: number, formType: string,
): Promise<AmendmentBase | null> {
  const holders = formType === '1120S' ? await shareholdersOf(supabase, userId, entityId, taxYear) : undefined
  const inputsFor = (values: Record<string, number>): Record<string, unknown> => {
    const carry = carriedLines(formType, values)
    return { ...baseInputs(formType, values), ...(holders ? { shareholders: holders } : {}), ...(Object.keys(carry).length ? { amend_carry: carry } : {}) }
  }
  const { data: imported } = await supabase.from('tax_return')
    .select(`id, field_values, computed_at, ${RETURN_ENC_COLS}`)
    .eq('entity_id', entityId).eq('tax_year', taxYear).eq('form_type', formType).eq('source', 'filed_import')
    .order('computed_at', { ascending: false }).limit(1).maybeSingle()
  const { data: cats } = await supabase.from('return_catalog')
    .select('id, user_id, source_filename, status, entries, entries_enc')
    .eq('user_id', userId).eq('entity_id', entityId).eq('tax_year', taxYear).eq('kind', 'filed_return').is('superseded_by', null)
  const rows = await hydrateAll(supabase, cats ?? [], { json: ['entries'] })
  const cat = rows.find(r => r.status === 'complete')
  if (cat) {
    const values = catalogValues((cat.entries as CatalogEntry[] | null) ?? [])
    if (Object.keys(values).length) {
      return {
        source: 'filed_catalog', label: `the filed ${taxYear} return (${cat.source_filename ?? 'catalogued PDF'})`,
        catalog_id: cat.id, ...(imported ? { return_id: imported.id } : {}), values, inputs: inputsFor(values),
      }
    }
  }
  if (imported) {
    await hydrate(supabase, imported, { ...ENCRYPTED_RETURN_FIELDS, userId })
    const values = goldenValues(formType, (imported.field_values ?? {}) as Record<string, unknown>)
    return { source: 'filed_import', label: `the filed ${taxYear} return`, return_id: imported.id, values, inputs: Object.keys(values).length ? inputsFor(values) : {} }
  }
  const partial = rows[0]
  if (!partial) return null
  const values = catalogValues((partial.entries as CatalogEntry[] | null) ?? [])
  return {
    source: 'filed_catalog', label: `the filed ${taxYear} return (${partial.source_filename ?? 'catalogued PDF'})`,
    catalog_id: partial.id, values, inputs: inputsFor(values),
  }
}

/** Lines where the computed amendment, before any change, is not the base:
 *  where the engine computes a line differently from how it was filed, or
 *  the amendment lost a line the filed return has. */
export function differsFromBase(base: Record<string, number>, computed: Record<string, unknown>, tolerance = 1): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(base)) {
    const c = computed[k]
    if (typeof c === 'number' ? Math.abs(c - v) > tolerance : Math.abs(v) > tolerance) out.push(k)
  }
  return out
}
