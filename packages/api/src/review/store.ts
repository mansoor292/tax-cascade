/**
 * Review runs against the database: load everything a review reads (this
 * entity's catalogs, every other entity of the user with ITS catalogs for
 * evidence-based linking, facts, third-party documents), run the framework,
 * diff with the previous run, store the result.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, hydrate, hydrateAll, ENCRYPTED_REVIEW_FIELDS, ENCRYPTED_RESOLUTION_FIELDS, REVIEW_ENC_COLS } from '../lib/row_crypto.js'
import { listFacts, computeFactGaps } from '../services/facts.js'
import { isFactFormType } from '../services/facts.js'
import type { CatalogEntry, CatalogCoverage } from '../catalog/types.js'
import type { CatalogView, DocumentFact, EntityInfo, FormType, ReviewContext } from './types.js'
import { buildContext, type EntityBundle } from './context.js'
import { runFramework, diffRuns, tieCheckIds, type Finding } from './framework.js'
import type { AskJson } from './ai.js'
import { withMapAnswers, type FactLike } from './map.js'
import { keyEntries } from '../schema/index.js'
import { listLinks } from '../services/entity_map.js'
import { listSets, versionRows } from '../services/versions.js'
import { versionsForView, viewBundles, viewFacts, type VersionRow } from './versions.js'

export async function loadBundles(supabase: SupabaseClient, userId: string, entityIds?: string[]): Promise<EntityBundle[]> {
  let eq = supabase.from('tax_entity')
    .select('id, name, form_type, entity_type, date_incorporated, meta').eq('user_id', userId)
  if (entityIds) eq = eq.in('id', entityIds)
  const { data: ents, error } = await eq
  if (error) throw new Error(error.message)
  let cq = supabase.from('return_catalog')
    .select('id, user_id, entity_id, tax_year, kind, transcript_type, as_of, source_filename, status, coverage, entries, entries_enc')
    .eq('user_id', userId).is('superseded_by', null)
  if (entityIds) cq = cq.in('entity_id', entityIds)
  const { data: cats, error: e2 } = await cq
  if (e2) throw new Error(e2.message)
  const rows = await hydrateAll(supabase, cats ?? [], { json: ['entries'] })
  const byEntity = new Map<string, CatalogView[]>()
  for (const r of rows) {
    const v: CatalogView = {
      id: r.id, kind: r.kind, tax_year: r.tax_year, source_filename: r.source_filename, status: r.status,
      transcript_type: r.transcript_type ?? null, as_of: r.as_of ?? null,
      coverage: r.coverage as CatalogCoverage, entries: keyEntries((r.entries as CatalogEntry[] | null) ?? []),
    }
    byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) ?? []), v])
  }
  return (ents ?? []).map(e => ({
    entity: { id: e.id, name: e.name, form_type: e.form_type as FormType, entity_type: e.entity_type, date_incorporated: e.date_incorporated, meta: (e.meta ?? {}) as Record<string, unknown> } as EntityInfo,
    catalogs: byEntity.get(e.id) ?? [],
  }))
}

export interface MapInputs { links: Awaited<ReturnType<typeof listLinks>>; factsByEntity: Map<string, FactLike[]> }

/** Current facts of every entity: map suggestions read some (disregarded
 *  entities), and the cross-entity checks read the other side's answers. */
export async function factsByEntity(supabase: SupabaseClient, userId: string, entityIds: string[]): Promise<Map<string, FactLike[]>> {
  const lists = await Promise.all(entityIds.map(id => listFacts(supabase, userId, id)))
  return new Map(entityIds.map((id, i) => [id, lists[i]]))
}

/** The account's entity map (recorded links) and every entity's facts, loaded
 *  once and shared by every run in a request. */
export async function loadMapInputs(supabase: SupabaseClient, userId: string, bundles: EntityBundle[]): Promise<MapInputs> {
  const [links, facts] = await Promise.all([listLinks(supabase, userId), factsByEntity(supabase, userId, bundles.map(b => b.entity.id))])
  return { links, factsByEntity: facts }
}

async function loadDocuments(supabase: SupabaseClient, userId: string, entityId: string): Promise<DocumentFact[]> {
  const { data, error } = await supabase.from('document')
    .select('id, user_id, doc_type, tax_year, meta, meta_enc').eq('user_id', userId).eq('entity_id', entityId)
  if (error) throw new Error(error.message)
  const rows = await hydrateAll(supabase, data ?? [], { json: ['meta'] })
  return rows
    .filter(r => /^(1099_|w2|k1)/.test(r.doc_type ?? ''))
    .map(r => ({ id: r.id, doc_type: r.doc_type, tax_year: r.tax_year, key_values: ((r.meta as any)?.key_values ?? {}) as Record<string, unknown>, summary: (r.meta as any)?.summary }))
}

/** Extensions stored here, and the first year with any record: a filed
 *  return, a stored return or a source document (not a transcript alone). */
async function loadFiling(supabase: SupabaseClient, entityId: string, catalogs: CatalogView[], documents: DocumentFact[]): Promise<NonNullable<ReviewContext['filing']>> {
  const { data, error } = await supabase.from('tax_return').select('tax_year, source').eq('entity_id', entityId)
  if (error) throw new Error(error.message)
  const rows = data ?? []
  const years = [
    ...rows.map(r => r.tax_year as number),
    ...catalogs.filter(c => c.kind === 'filed_return' && c.tax_year).map(c => c.tax_year as number),
    ...documents.map(d => d.tax_year).filter((y): y is number => typeof y === 'number'),
  ].filter(y => Number.isFinite(y))
  return {
    extended_years: rows.filter(r => r.source === 'extension').map(r => r.tax_year as number),
    ...(years.length ? { first_record_year: Math.min(...years) } : {}),
  }
}

export interface RunReviewResult {
  run_id: string
  tax_year: number
  framework_version: string
  summary: Record<string, unknown>
  findings: Array<Finding & { change?: string; cause?: string; resolution?: { resolution: string; note?: string | null; resolved_at: string } }>
}

export async function runReview(
  supabase: SupabaseClient, userId: string, entityId: string, year: number,
  opts: { ai?: boolean; ask?: AskJson; bundles?: EntityBundle[]; map?: MapInputs; versionSet?: string; versions?: VersionRow[] } = {},
): Promise<RunReviewResult> {
  // The view under review: 'filed' (the filed returns plus every filed
  // version set) or a draft set's label. A set is held to the tie checks
  // only — it is a package of amendments, and the question is whether the
  // package ties (review/versions.ts).
  const view = opts.versionSet ?? 'filed'
  const versions = versionsForView(opts.versions ?? versionRows(await listSets(supabase, userId)), view)
  const bundles = viewBundles(opts.bundles ?? await loadBundles(supabase, userId), versions)
  const self = bundles.find(b => b.entity.id === entityId)
  if (!self) throw Object.assign(new Error('Entity not found'), { status: 404 })
  const map = opts.map ?? await loadMapInputs(supabase, userId, bundles)
  const ents = bundles.map(b => ({ id: b.entity.id, name: b.entity.name, form_type: b.entity.form_type }))
  const ownFacts = viewFacts(new Map([[entityId, await listFacts(supabase, userId, entityId)]]), versions).get(entityId) ?? []
  const facts = withMapAnswers(ownFacts, entityId, map.links, ents)
  // A newly recorded link, or a changed version, is new information like a
  // fact: findings it brings are reported as caused by a new fact, not a miss.
  const factsAt = [...facts.map(f => f.recorded_at), ...map.links.map(l => l.recorded_at), ...versions.map(v => v.updated_at)]
    .reduce<string | null>((m, t) => (!m || t > m ? t : m), null)
  const formType = self.entity.form_type
  const gaps = isFactFormType(formType)
    ? computeFactGaps({ formType, taxYear: year, facts }).map(g => ({ key: g.key, question: g.question, status: g.status }))
    : undefined
  const documents = await loadDocuments(supabase, userId, entityId)
  const filing = await loadFiling(supabase, entityId, self.catalogs, documents)
  const ctx = buildContext({
    self, others: bundles.filter(b => b !== self), year,
    facts: facts.map(f => ({ fact_key: f.fact_key, tax_year: f.tax_year, subject: f.subject, value: f.value, status: f.status, source: f.source, recorded_at: f.recorded_at, superseded_by: f.superseded_by })),
    documents, factGaps: gaps, links: map.links, factsByEntity: viewFacts(map.factsByEntity, versions), filing,
  })
  const catalogIds = [...self.catalogs, ...ctx.linked.flatMap(l => l.catalogs)].map(c => c.id)

  const { data: run, error } = await supabase.from('review_run').insert({
    user_id: userId, entity_id: entityId, tax_year: year, framework_version: 'pending', status: 'running',
    ai: view === 'filed' && !!opts.ai, catalog_ids: catalogIds, facts_at: factsAt, version_set: view,
  }).select('id').single()
  if (error || !run) throw new Error(`could not start review run: ${error?.message}`)

  try {
    const ai = view === 'filed' && !!opts.ai
    const { version, findings } = await runFramework(ctx, { ai, ask: opts.ask, ...(view === 'filed' ? {} : { only: tieCheckIds() }) })
    const { data: prevRows } = await supabase.from('review_run')
      .select(`id, user_id, framework_version, catalog_ids, facts_at, findings, ${REVIEW_ENC_COLS}`)
      .eq('entity_id', entityId).eq('tax_year', year).eq('version_set', view).eq('status', 'done').neq('id', run.id)
      .order('started_at', { ascending: false }).limit(1)
    const prev = prevRows?.[0]
    if (prev) await hydrate(supabase, prev, { ...ENCRYPTED_REVIEW_FIELDS, userId })
    const diffed = diffRuns({
      previous: prev ? { findings: (prev.findings as Finding[]) ?? [], catalog_ids: prev.catalog_ids ?? [], facts_at: prev.facts_at, version: prev.framework_version } : undefined,
      current: { findings, catalog_ids: catalogIds, facts_at: factsAt, version, ai },
    })
    const summary = summarize(diffed)
    const payload = { findings: diffed }
    await supabase.from('review_run').update({
      framework_version: version, status: 'done', finished_at: new Date().toISOString(), summary,
      previous_run_id: prev?.id ?? null, ...payload,
      ...(await encryptedFields(supabase, userId, payload, ENCRYPTED_REVIEW_FIELDS)),
    }).eq('id', run.id)
    const resolutions = await currentResolutions(supabase, userId, entityId)
    return {
      run_id: run.id, tax_year: year, framework_version: version, summary,
      findings: diffed.map(f => ({ ...f, ...(resolutions.get(f.fingerprint) ? { resolution: resolutions.get(f.fingerprint) } : {}) })),
    }
  } catch (e: any) {
    await supabase.from('review_run').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e?.message ?? e).slice(0, 500) }).eq('id', run.id)
    throw e
  }
}

export function summarize(findings: Array<Finding & { change?: string; cause?: string }>): Record<string, unknown> {
  const open = findings.filter(f => f.change !== 'resolved')
  const count = (pred: (f: Finding & { change?: string; cause?: string }) => boolean) => open.filter(pred).length
  const act = open.filter(f => f.status === 'finding' || f.status === 'gap' || f.status === 'error')
  return {
    checks: new Set(findings.map(f => f.check)).size,
    findings: count(f => f.status === 'finding'),
    gaps: count(f => f.status === 'gap'),
    errors: count(f => f.status === 'error'),
    passed: count(f => f.status === 'pass'),
    by_severity: Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map(s => [s, act.filter(f => f.severity === s).length])),
    new: count(f => f.change === 'new' && (f.status === 'finding' || f.status === 'gap')),
    new_by_cause: Object.fromEntries(['new_document', 'new_fact', 'framework', 'first_run', 'miss'].map(c => [c, act.filter(f => f.change === 'new' && f.cause === c).length])),
    resolved_since_last: findings.filter(f => f.change === 'resolved').length,
  }
}

export async function currentResolutions(supabase: SupabaseClient, userId: string, entityId: string): Promise<Map<string, { resolution: string; note?: string | null; resolved_at: string }>> {
  const { data } = await supabase.from('review_resolution')
    .select('id, user_id, fingerprint, resolution, note, note_enc, resolved_at')
    .eq('user_id', userId).eq('entity_id', entityId).is('superseded_by', null)
  const rows = await hydrateAll(supabase, data ?? [], ENCRYPTED_RESOLUTION_FIELDS)
  return new Map(rows.map(r => [r.fingerprint as string, { resolution: r.resolution as string, note: r.note as string | null, resolved_at: r.resolved_at as string }]))
}

export async function resolveFinding(
  supabase: SupabaseClient, userId: string, entityId: string,
  args: { fingerprint: string; resolution: 'fixed' | 'accepted' | 'not_an_issue' | 'reopened'; note?: string; resolved_by?: string },
): Promise<{ id: string }> {
  const { data: prev } = await supabase.from('review_resolution').select('id')
    .eq('entity_id', entityId).eq('fingerprint', args.fingerprint).is('superseded_by', null)
  const row = {
    user_id: userId, entity_id: entityId, fingerprint: args.fingerprint, check_id: args.fingerprint.split('|')[0],
    resolution: args.resolution, note: args.note ?? null, resolved_by: args.resolved_by ?? null,
  }
  const { data, error } = await supabase.from('review_resolution')
    .insert({ ...row, ...(await encryptedFields(supabase, userId, row, ENCRYPTED_RESOLUTION_FIELDS)) })
    .select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'insert failed')
  if (prev?.length) await supabase.from('review_resolution').update({ superseded_by: data.id }).in('id', prev.map(p => p.id))
  return { id: data.id }
}

export async function latestRuns(supabase: SupabaseClient, userId: string, entityId: string, years?: number[], view = 'filed'): Promise<RunReviewResult[]> {
  let q = supabase.from('review_run')
    .select(`id, user_id, tax_year, framework_version, summary, started_at, findings, ${REVIEW_ENC_COLS}`)
    .eq('user_id', userId).eq('entity_id', entityId).eq('version_set', view).eq('status', 'done').order('started_at', { ascending: false })
  if (years?.length) q = q.in('tax_year', years)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const seen = new Set<number>()
  const latest = (data ?? []).filter(r => (seen.has(r.tax_year) ? false : (seen.add(r.tax_year), true)))
  await hydrateAll(supabase, latest, ENCRYPTED_REVIEW_FIELDS)
  const resolutions = await currentResolutions(supabase, userId, entityId)
  return latest.sort((a, b) => a.tax_year - b.tax_year).map(r => ({
    run_id: r.id, tax_year: r.tax_year, framework_version: r.framework_version, summary: r.summary,
    findings: ((r.findings as Finding[]) ?? []).map(f => ({ ...f, ...(resolutions.get(f.fingerprint) ? { resolution: resolutions.get(f.fingerprint) } : {}) })),
  }))
}

export interface BreakItem {
  entity: string
  entity_id: string
  form_type: string
  tax_year: number
  fingerprint: string
  check: string
  severity: string
  title: string
  detail: string
  dollar_effect?: number
  evidence: unknown
  /** For a draft set: the same break is in the filed returns too */
  in_filed?: boolean
}

/** Breaks (tie findings still open) in one view, from its latest runs. */
export async function viewBreaks(supabase: SupabaseClient, userId: string, ents: Array<{ id: string; name: string; form_type: string }>, view: string): Promise<{ breaks: BreakItem[]; covered: Set<string> }> {
  const breaks: BreakItem[] = []
  const covered = new Set<string>()
  for (const e of ents) {
    for (const r of await latestRuns(supabase, userId, e.id, undefined, view)) {
      covered.add(`${e.id}|${r.tax_year}`)
      for (const f of r.findings) {
        if (!f.tie || f.status !== 'finding' || f.change === 'resolved' || (f.resolution && f.resolution.resolution !== 'reopened')) continue
        breaks.push({
          entity: e.name, entity_id: e.id, form_type: e.form_type, tax_year: r.tax_year, fingerprint: f.fingerprint, check: f.check,
          severity: f.severity, title: f.title, detail: f.detail, ...(f.dollar_effect !== undefined ? { dollar_effect: f.dollar_effect } : {}), evidence: f.evidence,
        })
      }
    }
  }
  return { breaks, covered }
}

/** A draft set against the filed returns: its breaks (each marked new or
 *  inherited from filed) and the filed breaks it fixes. */
export async function setBreaksReport(supabase: SupabaseClient, userId: string, ents: Array<{ id: string; name: string; form_type: string }>, label: string) {
  const [filedView, setView] = await Promise.all([viewBreaks(supabase, userId, ents, 'filed'), viewBreaks(supabase, userId, ents, label)])
  const key = (b: BreakItem) => `${b.entity_id}|${b.fingerprint}`
  const inFiled = new Set(filedView.breaks.map(key))
  const inSet = new Set(setView.breaks.map(key))
  const breaks = setView.breaks.map(b => ({ ...b, in_filed: inFiled.has(key(b)) }))
  const fixes = filedView.breaks.filter(b => setView.covered.has(`${b.entity_id}|${b.tax_year}`) && !inSet.has(key(b)))
  return {
    set: label,
    reviewed_returns: setView.covered.size,
    breaks_count: breaks.length,
    new_breaks: breaks.filter(b => !b.in_filed),
    inherited_breaks: breaks.filter(b => b.in_filed),
    fixes,
    ties: breaks.length === 0 && setView.covered.size > 0,
  }
}
