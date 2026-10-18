/**
 * Fact answers: record them (superseding, never overwriting), list them, and
 * compute the gap list that holds every return of a type to the same
 * standard.
 *
 * Why: the facts that decide how a return is prepared — who lent the money
 * and from whose account, material participation, the S election and its
 * acceptance, which EIN issues the W-2s, what the IRS transcript shows — used
 * to surface one at a time, months apart, whenever a nearby question happened
 * to be asked. The registry (@taxengine/shared facts.ts) now says which facts
 * each return type needs; this module answers "which of them do we have for
 * THIS return, which are missing, and which does the return itself
 * contradict?" — the same list for every return of that type, every year.
 *
 * Shape:
 *   - computeFactGaps / checkFactInput / compareWithCatalog are PURE (no DB,
 *     no env) so the rules are unit-tested directly.
 *   - recordFact / listFacts / factGaps take the Supabase client and the
 *     resolved user id as arguments; the route owns auth and ownership.
 *
 * Coordinates: one CURRENT answer per (entity, fact_key, tax_year, subject).
 * Subjects are matched case- and whitespace-insensitively, because the same
 * owner typed twice ("Jane  Doe" / "jane doe") must not become two owners.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listLinks } from './entity_map.js'
import { withMapAnswers } from '../review/map.js'
import {
  FACT_DEFS, FACT_FORM_TYPES, FACT_SOURCES, FACT_STATUSES,
  evaluateRequired, factAppliesInYear, getFactDef, isFactDate,
  scopeHasSubject, scopeIsYearly, validateFactCoordinates, validateFactValue,
  type CatalogSelector, type EvidenceKind, type FactAnswer, type FactArea, type FactDef,
  type FactFormType, type FactItemField, type FactScope, type FactSource, type FactStatus,
  type FactType, type FactValue,
} from '@taxengine/shared'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_FACT_FIELDS } from '../lib/row_crypto.js'

// ─── Types ──────────────────────────────────────────────────────────────────

/** A tax_fact row after hydration (ciphertext columns stripped). */
export interface StoredFact {
  id: string
  entity_id: string
  tax_year: number | null
  subject: string | null
  fact_key: string
  value: FactValue | null
  status: FactStatus
  source: FactSource
  source_note: string | null
  evidence_document_id: string | null
  recorded_by: string | null
  recorded_at: string
  superseded_by: string | null
}

export type GapStatus = 'answered' | 'unknown' | 'not_applicable' | 'missing' | 'contradicted'

export interface FactGap {
  key: string
  question: string
  why: string
  scope: FactScope
  type: FactType
  options?: readonly string[]
  item_fields?: readonly FactItemField[]
  affects: readonly FactArea[]
  accepted_evidence: readonly EvidenceKind[]
  /** Owner / K-1 issuer / counterparty this row is about. */
  subject?: string
  status: GapStatus
  value?: FactValue | null
  source?: FactSource
  source_note?: string | null
  /** Evidence document id for the current answer. */
  evidence?: string | null
  recorded_at?: string
  /** What the return says, from the first catalog line that answered (or contradicted). */
  catalog_value?: unknown
  catalog_line?: CatalogSelector
  /** Missing because it hinges on these unanswered facts — ask them together. */
  conditional_on?: string[]
  /** Missing because nobody has listed the owners / K-1s / counterparties yet. */
  needs_subjects_from?: string
  /** Why a not_applicable row is not applicable, when the system decided it. */
  not_applicable_reason?: 'condition' | 'not_in_law_this_year' | 'no_subjects'
}

export interface FactGapSummary {
  total: number
  answered: number
  unknown: number
  not_applicable: number
  missing: number
  contradicted: number
}

/** Context handed to a catalog lookup so it can pick the right instance (K-1 for this owner, 7203 for this issuer). */
export interface CatalogLookupContext {
  key: string
  subject?: string
  tax_year: number
}
export type CatalogLookup = (selector: CatalogSelector, ctx: CatalogLookupContext) => unknown
export type CatalogComparison = 'agree' | 'disagree' | 'not_comparable'
export type CatalogCompare = (
  def: FactDef, value: FactValue, catalogValue: unknown, selector: CatalogSelector,
) => CatalogComparison

// ─── Coordinates ────────────────────────────────────────────────────────────

/** Display form of a subject: trimmed, inner whitespace collapsed. Null when blank. */
export function cleanSubject(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim().replace(/\s+/g, ' ')
  return t || null
}

/** Matching form of a subject. */
function subjectKey(s: string | null | undefined): string {
  return (cleanSubject(s) ?? '').toLowerCase()
}

function coordinate(key: string, year: number | null, subject: string | null | undefined): string {
  return `${key}|${year ?? ''}|${subjectKey(subject)}`
}

/**
 * The current answer per coordinate. Normally there is exactly one row with
 * superseded_by null per coordinate; two concurrent writes can briefly leave
 * two, and the later one wins here until the next write supersedes both.
 */
export function currentFactIndex(rows: readonly StoredFact[]): Map<string, StoredFact> {
  const out = new Map<string, StoredFact>()
  for (const r of rows) {
    if (r.superseded_by) continue
    const c = coordinate(r.fact_key, r.tax_year, r.subject)
    const prev = out.get(c)
    if (!prev || r.recorded_at > prev.recorded_at || (r.recorded_at === prev.recorded_at && r.id > prev.id)) {
      out.set(c, r)
    }
  }
  return out
}

// ─── Catalog comparison ─────────────────────────────────────────────────────

/** 'YYYY-MM-DD' or 'MM/DD/YYYY' (the IRS's own format) → 'YYYY-MM-DD'. */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  // `as unknown`: isFactDate is a type guard, and on a string its false
  // branch would narrow `s` to never.
  if (isFactDate(s as unknown)) return s
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (!m) return null
  const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return isFactDate(iso) ? iso : null
}

function catalogBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (['yes', 'x', 'true', 'checked', '1'].includes(s)) return true
  if (['no', 'false', 'unchecked', '0'].includes(s)) return false
  return null
}

function normText(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Option names are snake_case; the return prints "Cash" / "Accrual". */
function normOption(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** Rounding on a return is to whole dollars; percentages print to six places. */
const TOLERANCE: Partial<Record<FactType, number>> = { money: 1, percent: 0.001, number: 1e-9 }

/**
 * Default comparison: plain equality per type. Deliberately conservative —
 * anything it cannot read with confidence is 'not_comparable', never a
 * contradiction, because a false "the return disagrees with you" costs the
 * owner a wasted answer.
 *
 * Catalog amounts arrive as numbers (the catalog normalises them), so no
 * money-string parsing happens here.
 */
export function compareWithCatalog(
  def: FactDef, value: FactValue, catalogValue: unknown, selector: CatalogSelector,
): CatalogComparison {
  if (selector.relation === 'related') return 'not_comparable'
  if (catalogValue === undefined || catalogValue === null) return 'not_comparable'

  let type: FactType = def.type
  let mine: unknown = value
  if (def.type === 'list') {
    if (!selector.aggregate || !Array.isArray(value)) return 'not_comparable'
    if (selector.aggregate.op === 'count') {
      mine = value.length
      type = 'number'
    } else {
      const field = selector.aggregate.field
      if (!field) return 'not_comparable'
      mine = value.reduce((s, row) => s + (typeof row[field] === 'number' ? (row[field] as number) : 0), 0)
      type = 'money'
    }
  }

  switch (type) {
    case 'date': {
      const a = isoDate(mine), b = isoDate(catalogValue)
      if (!a || !b) return 'not_comparable'
      return a === b ? 'agree' : 'disagree'
    }
    case 'bool': {
      const b = catalogBool(catalogValue)
      if (b === null || typeof mine !== 'boolean') return 'not_comparable'
      return b === mine ? 'agree' : 'disagree'
    }
    case 'number':
    case 'money':
    case 'percent': {
      if (typeof mine !== 'number' || typeof catalogValue !== 'number' || !Number.isFinite(catalogValue)) {
        return 'not_comparable'
      }
      const a = selector.shown_negative ? Math.abs(mine) : mine
      const b = selector.shown_negative ? Math.abs(catalogValue) : catalogValue
      return Math.abs(a - b) <= (TOLERANCE[type] ?? 0) ? 'agree' : 'disagree'
    }
    case 'enum': {
      if (typeof mine !== 'string' || typeof catalogValue !== 'string') return 'not_comparable'
      const read = normOption(catalogValue)
      // Only a value that IS one of the options can contradict; anything else
      // is a catalog we cannot interpret, not a disagreement.
      if (!(def.options || []).includes(read)) return 'not_comparable'
      return read === mine ? 'agree' : 'disagree'
    }
    case 'text': {
      if (typeof mine !== 'string' || typeof catalogValue !== 'string') return 'not_comparable'
      return normText(mine) === normText(catalogValue) ? 'agree' : 'disagree'
    }
    default:
      return 'not_comparable'
  }
}

// ─── Gap computation (pure) ─────────────────────────────────────────────────

export interface ComputeFactGapsInput {
  formType: FactFormType | string
  taxYear: number
  /** The entity's facts: rows for taxYear plus all-years rows (tax_year null). History rows are ignored. */
  facts: readonly StoredFact[]
  catalogLookup?: CatalogLookup
  compare?: CatalogCompare
}

function baseGap(def: FactDef): FactGap {
  const g: FactGap = {
    key: def.key,
    question: def.question,
    why: def.why,
    scope: def.scope,
    type: def.type,
    affects: def.affects,
    accepted_evidence: def.evidence,
    status: 'missing',
  }
  if (def.options) g.options = def.options
  if (def.item_fields) g.item_fields = def.item_fields
  return g
}

/**
 * The fact list for one return: every fact the registry defines for the form
 * type, in registry order, each with a status. Facts that do not apply (a
 * condition answered "no", a year before the law existed, nobody to ask about)
 * are still listed as not_applicable, so every return of a type shows the
 * same list — the list never quietly gets shorter.
 */
export function computeFactGaps(input: ComputeFactGapsInput): FactGap[] {
  const { formType, taxYear } = input
  const compare = input.compare ?? compareWithCatalog
  const index = currentFactIndex(input.facts)

  const yearFor = (def: FactDef) => (scopeIsYearly(def.scope) ? taxYear : null)
  const stored = (def: FactDef, subject: string | null) =>
    index.get(coordinate(def.key, yearFor(def), scopeHasSubject(def.scope) ? subject : null))

  const answerFor = (key: string, subject: string | null): FactAnswer | undefined => {
    const ref = getFactDef(key)
    if (!ref) return undefined
    const row = stored(ref, subject)
    return row ? { status: row.status, value: row.value } : undefined
  }

  const lookup = (def: FactDef, subject: string | null, onlyEquals: boolean) => {
    if (!input.catalogLookup || !def.catalog) return []
    const hits: Array<{ selector: CatalogSelector; value: unknown }> = []
    for (const selector of def.catalog) {
      if (onlyEquals && selector.relation === 'related') continue
      const v = input.catalogLookup(selector, {
        key: def.key, tax_year: taxYear, ...(subject ? { subject } : {}),
      })
      if (v !== undefined && v !== null) hits.push({ selector, value: v })
    }
    return hits
  }

  const out: FactGap[] = []
  for (const def of FACT_DEFS) {
    if (!(def.applies_to as readonly string[]).includes(formType)) continue

    if (!factAppliesInYear(def, taxYear)) {
      out.push({ ...baseGap(def), status: 'not_applicable', not_applicable_reason: 'not_in_law_this_year' })
      continue
    }

    // Who to ask about: the names on the roster fact, plus anyone already
    // answered for (an owner dropped from the roster keeps their answers visible).
    let subjects: Array<string | null> = [null]
    if (scopeHasSubject(def.scope) && def.subjects_from) {
      const rosterDef = getFactDef(def.subjects_from.fact)
      const roster = rosterDef ? stored(rosterDef, null) : undefined
      const names = new Map<string, string>()
      if (roster?.status === 'answered' && Array.isArray(roster.value)) {
        for (const row of roster.value) {
          const n = cleanSubject(row[def.subjects_from.field])
          if (n) names.set(subjectKey(n), n)
        }
      }
      for (const r of index.values()) {
        if (r.fact_key !== def.key || r.tax_year !== yearFor(def)) continue
        const n = cleanSubject(r.subject)
        if (n && !names.has(subjectKey(n))) names.set(subjectKey(n), n)
      }
      if (!names.size) {
        const req = evaluateRequired(def, k => answerFor(k, null))
        if (req.state === 'not_required') {
          out.push({ ...baseGap(def), status: 'not_applicable', not_applicable_reason: 'condition' })
        } else if (roster && roster.status !== 'unknown') {
          // The roster was answered (empty, or not applicable): nobody to ask about.
          out.push({ ...baseGap(def), status: 'not_applicable', not_applicable_reason: 'no_subjects' })
        } else {
          out.push({
            ...baseGap(def),
            status: 'missing',
            needs_subjects_from: def.subjects_from.fact,
            conditional_on: [...new Set([def.subjects_from.fact, ...req.waiting_on])],
          })
        }
        continue
      }
      subjects = [...names.values()]
    }

    for (const subject of subjects) {
      const gap = baseGap(def)
      if (subject) gap.subject = subject
      const req = evaluateRequired(def, k => answerFor(k, subject))
      const row = stored(def, subject)

      if (row) {
        gap.status = row.status
        gap.value = row.value
        gap.source = row.source
        gap.source_note = row.source_note
        gap.evidence = row.evidence_document_id
        gap.recorded_at = row.recorded_at
        if (row.status === 'answered' && row.value !== null && row.value !== undefined) {
          for (const hit of lookup(def, subject, true)) {
            const verdict = compare(def, row.value, hit.value, hit.selector)
            if (verdict === 'disagree') {
              gap.status = 'contradicted'
              gap.catalog_value = hit.value
              gap.catalog_line = hit.selector
              break
            }
            if (verdict === 'agree' && gap.catalog_line === undefined) {
              gap.catalog_value = hit.value
              gap.catalog_line = hit.selector
            }
          }
        }
      } else if (req.state === 'not_required') {
        gap.status = 'not_applicable'
        gap.not_applicable_reason = 'condition'
      } else {
        gap.status = 'missing'
        if (req.state === 'undetermined') gap.conditional_on = req.waiting_on
        // A fact the return itself can answer is still missing — the owner
        // confirms it and it is recorded with source 'catalog' — but the
        // suggestion rides along so the question can be "is it X?".
        if (def.derive_from_catalog) {
          const first = lookup(def, subject, true)[0]
          if (first) {
            gap.catalog_value = first.value
            gap.catalog_line = first.selector
          }
        }
      }
      out.push(gap)
    }
  }
  return out
}

export function summarizeGaps(gaps: readonly FactGap[]): FactGapSummary {
  const s: FactGapSummary = { total: gaps.length, answered: 0, unknown: 0, not_applicable: 0, missing: 0, contradicted: 0 }
  for (const g of gaps) s[g.status]++
  return s
}

// ─── Input checking (pure) ──────────────────────────────────────────────────

export interface RecordFactInput {
  entity_id: string
  tax_year?: number | null
  subject?: string | null
  fact_key: string
  value?: unknown
  status: FactStatus
  source: FactSource
  source_note?: string | null
  evidence_document_id?: string | null
  recorded_by?: string | null
}

export interface CheckedFact {
  def: FactDef
  row: {
    entity_id: string
    tax_year: number | null
    subject: string | null
    fact_key: string
    value: FactValue | null
    status: FactStatus
    source: FactSource
    source_note: string | null
    evidence_document_id: string | null
    recorded_by: string | null
  }
}

export type FactInputCheck =
  | { ok: true; fact: CheckedFact }
  | { ok: false; error: string; field?: string; [extra: string]: unknown }

/**
 * Validate a fact write against the registry before anything touches the
 * database: the key exists and applies to this entity's return type, the
 * coordinates match the fact's scope, and an answered value matches its type.
 * An 'unknown' or 'not_applicable' answer carries no value — it is a
 * statement about the fact, not a value of it.
 */
export function checkFactInput(raw: any, entityFormType: string): FactInputCheck {
  const b = raw && typeof raw === 'object' ? raw : {}
  if (typeof b.entity_id !== 'string' || !b.entity_id) return { ok: false, error: 'entity_id is required', field: 'entity_id' }
  if (typeof b.fact_key !== 'string' || !b.fact_key) return { ok: false, error: 'fact_key is required', field: 'fact_key' }

  const def = getFactDef(b.fact_key)
  if (!def) {
    const prefix = b.fact_key.split('.')[0]
    return {
      ok: false, field: 'fact_key',
      error: `Unknown fact_key: ${b.fact_key}. Facts are defined in the registry; use get_fact_gaps to see the keys this return needs.`,
      similar: FACT_DEFS.filter(d => d.key.startsWith(`${prefix}.`)).map(d => d.key).slice(0, 25),
    }
  }
  if (!(def.applies_to as readonly string[]).includes(entityFormType)) {
    return {
      ok: false, field: 'fact_key',
      error: `${def.key} applies to ${def.applies_to.join('/')} returns, not ${entityFormType}.`,
    }
  }

  const status = b.status ?? 'answered'
  if (!(FACT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, field: 'status', error: `status must be one of: ${FACT_STATUSES.join(', ')}` }
  }
  if (!(FACT_SOURCES as readonly string[]).includes(b.source)) {
    return { ok: false, field: 'source', error: `source must be one of: ${FACT_SOURCES.join(', ')}` }
  }

  const taxYear = b.tax_year === undefined || b.tax_year === null || b.tax_year === '' ? null : Number(b.tax_year)
  const subject = cleanSubject(b.subject)
  const coordErr = validateFactCoordinates(def, { tax_year: taxYear, subject })
  if (coordErr) return { ok: false, field: /tax_year/.test(coordErr) ? 'tax_year' : 'subject', error: coordErr }

  let value: FactValue | null = null
  if (status === 'answered') {
    if (b.value === undefined || b.value === null) {
      return { ok: false, field: 'value', error: `value is required when status is 'answered' (use status 'unknown' if the answer is not known)` }
    }
    const v = validateFactValue(def, b.value)
    if (!v.ok) return { ok: false, field: 'value', error: v.error }
    value = v.value
  } else if (b.value !== undefined && b.value !== null) {
    return { ok: false, field: 'value', error: `a '${status}' answer carries no value — record it as 'answered' instead` }
  }

  const note = typeof b.source_note === 'string' && b.source_note.trim() ? b.source_note.trim() : null
  const evidence = typeof b.evidence_document_id === 'string' && b.evidence_document_id ? b.evidence_document_id : null
  const recordedBy = typeof b.recorded_by === 'string' && b.recorded_by.trim() ? b.recorded_by.trim().slice(0, 200) : null

  return {
    ok: true,
    fact: {
      def,
      row: {
        entity_id: b.entity_id,
        tax_year: taxYear,
        subject,
        fact_key: def.key,
        value,
        status,
        source: b.source,
        source_note: note,
        evidence_document_id: evidence,
        recorded_by: recordedBy,
      },
    },
  }
}

export function isFactFormType(v: unknown): v is FactFormType {
  return typeof v === 'string' && (FACT_FORM_TYPES as readonly string[]).includes(v)
}

// ─── Database ───────────────────────────────────────────────────────────────

/** Drop ciphertext and internal columns before a row leaves the server. */
function publicRow(row: Record<string, any>): StoredFact {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_enc') || k === 'user_id') continue
    out[k] = v
  }
  return out as StoredFact
}

/**
 * Record an answer. Always a new row: the previous current answer at the
 * same coordinate is pointed at it via superseded_by, never edited.
 *
 * Order matters. The current rows are read BEFORE the insert, so a row can
 * only ever be superseded by one written after it was read — two concurrent
 * writes can leave two current rows for a moment (the read side keeps the
 * later one), but never a cycle in which each supersedes the other.
 */
export async function recordFact(
  supabase: SupabaseClient, userId: string, fact: CheckedFact,
): Promise<{ fact: StoredFact; superseded: string[] }> {
  const { row } = fact

  let q = supabase.from('tax_fact')
    .select('id, subject')
    .eq('entity_id', row.entity_id)
    .eq('user_id', userId)
    .eq('fact_key', row.fact_key)
    .is('superseded_by', null)
  q = row.tax_year === null ? q.is('tax_year', null) : q.eq('tax_year', row.tax_year)
  const { data: current, error: readErr } = await q
  if (readErr) throw new Error(readErr.message)
  const previous = (current || [])
    .filter((r: any) => subjectKey(r.subject) === subjectKey(row.subject))
    .map((r: any) => r.id as string)

  const payload: Record<string, any> = { user_id: userId, ...row }
  const enc = await encryptedFields(supabase, userId, payload, ENCRYPTED_FACT_FIELDS)
  const { data: inserted, error: insErr } = await supabase.from('tax_fact')
    .insert({ ...payload, ...enc })
    .select('*')
    .single()
  if (insErr) throw new Error(insErr.message)

  let superseded: string[] = []
  if (previous.length) {
    const { data: upd, error: updErr } = await supabase.from('tax_fact')
      .update({ superseded_by: inserted.id })
      .in('id', previous)
      .eq('user_id', userId)
      .is('superseded_by', null)
      .select('id')
    if (updErr) throw new Error(updErr.message)
    superseded = (upd || []).map((r: any) => r.id)
  }

  await hydrate(supabase, inserted, ENCRYPTED_FACT_FIELDS)
  return { fact: publicRow(inserted), superseded }
}

/**
 * The entity's facts. With a year: that year's answers plus the all-years
 * ones (tax_year null), which is everything a return for that year reads.
 * Current answers only unless includeHistory.
 */
export async function listFacts(
  supabase: SupabaseClient, userId: string, entityId: string,
  opts: { taxYear?: number; includeHistory?: boolean } = {},
): Promise<StoredFact[]> {
  let q = supabase.from('tax_fact')
    .select('*')
    .eq('entity_id', entityId)
    .eq('user_id', userId)
  if (opts.taxYear !== undefined) q = q.or(`tax_year.eq.${opts.taxYear},tax_year.is.null`)
  if (!opts.includeHistory) q = q.is('superseded_by', null)
  const { data, error } = await q
    .order('fact_key', { ascending: true })
    .order('tax_year', { ascending: true, nullsFirst: true })
    .order('recorded_at', { ascending: false })
  if (error) throw new Error(error.message)
  const rows = await hydrateAll(supabase, data || [], ENCRYPTED_FACT_FIELDS)
  return rows.map(publicRow)
}

/** Gap list for one return, read from the database. */
export async function factGaps(
  supabase: SupabaseClient, userId: string,
  entity: { id: string }, formType: FactFormType, taxYear: number,
  catalogLookup?: CatalogLookup,
): Promise<{ summary: FactGapSummary; gaps: FactGap[] }> {
  // The entity map answers the registry's related-company questions
  // (review/map.ts mapFactAnswers); a stored answer still wins.
  const [stored, links, { data: ents, error }] = await Promise.all([
    listFacts(supabase, userId, entity.id, { taxYear }),
    listLinks(supabase, userId),
    supabase.from('tax_entity').select('id, name, form_type').eq('user_id', userId),
  ])
  if (error) throw new Error(error.message)
  const facts = withMapAnswers(stored, entity.id, links, ents ?? [])
  const gaps = computeFactGaps({ formType, taxYear, facts, catalogLookup })
  return { summary: summarizeGaps(gaps), gaps }
}
