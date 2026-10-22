/**
 * Review routes — the fixed framework of checks run against catalogued
 * returns (docs/RETURN_CATALOG_AND_REVIEW.md, requirement R3).
 *
 *   POST /api/review/:entity_id/run       run the framework for one or more years
 *   GET  /api/review/:entity_id           the latest run per year, with resolutions
 *   GET  /api/review/summary              one list across entities: everything to act on,
 *                                         including every open return note
 *   POST /api/review/:entity_id/resolve   record a decision about a finding
 *
 * A run with ai=true calls the model for the judgement checks and can take a
 * minute; it runs after the response (202) unless wait=true, because the proxy
 * in front of the API gives up at ~26s (see routes/documents.ts registerHandler).
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { runReview, latestRuns, resolveFinding, loadBundles, loadMapInputs, setBreaksReport } from '../review/store.js'
import { listSets } from '../services/versions.js'
import { yearFilings } from '../review/filing.js'
import { listNotes } from '../services/notes.js'

const supabase = lazyServiceClient()
const router = Router()

async function ownsEntity(userId: string, entityId: string): Promise<boolean> {
  const { data } = await supabase.from('tax_entity').select('id').eq('id', entityId).eq('user_id', userId).maybeSingle()
  return !!data
}

const ACT = new Set(['finding', 'gap', 'error'])
const SEV: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

function compact(f: any) {
  return {
    fingerprint: f.fingerprint, check: f.check, area: f.area, kind: f.kind, tax_year: f.tax_year,
    status: f.status, severity: f.severity, title: f.title, detail: f.detail, ...(f.tie ? { tie: true } : {}),
    dollar_effect: f.dollar_effect, deadline: f.deadline, asks: f.asks, evidence: f.evidence,
    change: f.change, cause: f.cause, resolution: f.resolution,
  }
}

router.post('/:entity_id/run', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const entityId = req.params.entity_id
  try {
    if (!(await ownsEntity(userId, entityId))) return res.status(404).json({ error: 'Entity not found' })
    const years: number[] = (Array.isArray(req.body?.years) ? req.body.years : [req.body?.tax_year]).map(Number).filter(Number.isFinite)
    if (!years.length) return res.status(400).json({ error: 'tax_year or years required' })
    const ai = req.body?.ai === true
    const wait = req.body?.wait === true || !ai
    const work = async () => {
      const bundles = await loadBundles(supabase, userId)
      const map = await loadMapInputs(supabase, userId, bundles)
      const out = []
      for (const y of years) out.push(await runReview(supabase, userId, entityId, y, { ai, bundles, map }))
      return out
    }
    if (wait) {
      const runs = await work()
      return res.json({
        runs: runs.map(r => ({
          run_id: r.run_id, tax_year: r.tax_year, framework_version: r.framework_version, summary: r.summary,
          to_act_on: r.findings.filter(f => ACT.has(f.status) && f.change !== 'resolved').sort((a, b) => SEV[a.severity] - SEV[b.severity]).map(compact),
          passed: r.findings.filter(f => f.status === 'pass').map(f => f.title),
        })),
      })
    }
    res.status(202).json({ status: 'running', years, note: 'AI checks take up to a few minutes; read the result with GET /api/review/:entity_id' })
    work().catch(e => console.error(`review run failed for ${entityId}: ${e?.message ?? e}`))
  } catch (e: any) {
    sendError(res, e)
  }
})

router.get('/summary', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { data: ents } = await supabase.from('tax_entity').select('id, name, form_type').eq('user_id', userId)
    const wanted = req.query.entity_ids ? String(req.query.entity_ids).split(',') : undefined
    const items: any[] = []
    for (const e of (ents ?? []).filter(x => !wanted || wanted.includes(x.id))) {
      for (const r of await latestRuns(supabase, userId, e.id)) {
        for (const f of r.findings) {
          if (!ACT.has(f.status) || f.change === 'resolved' || (f.resolution && f.resolution.resolution !== 'reopened')) continue
          items.push({ entity: e.name, entity_id: e.id, form_type: e.form_type, ...compact(f) })
        }
      }
    }
    // Breaks: tie findings. The filed returns' breaks are already items. A
    // draft version set's breaks that the filed returns do not have are open
    // items too (the package does not tie yet), marked with the set's label.
    const scopedEnts = (ents ?? []).filter(x => !wanted || wanted.includes(x.id))
    const drafts = (await listSets(supabase, userId)).filter(s => s.status === 'draft')
    const setReports = []
    for (const s of drafts) {
      const r = await setBreaksReport(supabase, userId, scopedEnts, s.label)
      setReports.push({ set: s.label, title: s.title, ties: r.ties, reviewed_returns: r.reviewed_returns, new_breaks: r.new_breaks.length, inherited_breaks: r.inherited_breaks.length, fixes: r.fixes.map(f => ({ entity: f.entity, tax_year: f.tax_year, title: f.title })) })
      for (const b of r.new_breaks) items.push({ ...b, status: 'finding', tie: true, version_set: s.label, title: `[${s.label}] ${b.title}` })
    }
    items.sort((a, b) => SEV[a.severity] - SEV[b.severity] || Math.abs(b.dollar_effect ?? 0) - Math.abs(a.dollar_effect ?? 0) || String(a.deadline ?? '9').localeCompare(String(b.deadline ?? '9')))
    const asks = [...new Set(items.flatMap(i => i.asks ?? []))]
    // Open notes are the threads no check can see (services/notes.ts); the
    // summary is only "everything to act on" if it carries them too.
    const scoped = (ents ?? []).filter(x => !wanted || wanted.includes(x.id))
    const byId = new Map(scoped.map(e => [e.id, e]))
    const openNotes = (await listNotes(supabase, userId, scoped.map(e => e.id), { statuses: ['open'] }))
      .map(n => ({ entity: byId.get(n.entity_id)?.name, form_type: byId.get(n.entity_id)?.form_type, ...n }))
    const filedBreaks = items.filter(i => i.tie && i.status === 'finding' && !i.version_set).length
    res.json({
      count: items.length, items, facts_to_ask: asks, open_notes_count: openNotes.length, open_notes: openNotes,
      breaks: { filed: filedBreaks, sets: setReports },
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// Filed and accepted, per entity and year (review/filing.ts): filed = a
// filed return on file here (catalogued PDF or imported row); accepted = the
// IRS's transcript confirms it. Read-only, computed from the catalog.
router.get('/filing', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const wanted = req.query.entity_id ? [String(req.query.entity_id)] : undefined
    const bundles = await loadBundles(supabase, userId, wanted)
    if (wanted && !bundles.length) return res.status(404).json({ error: 'Entity not found' })
    const { data: rows, error } = await supabase.from('tax_return')
      .select('id, entity_id, tax_year, source, form_type, computed_at')
      .in('entity_id', bundles.map(b => b.entity.id))
    if (error) throw new Error(error.message)
    const today = new Date()
    res.json({
      entities: bundles.map(b => ({
        entity_id: b.entity.id, name: b.entity.name, form_type: b.entity.form_type,
        years: yearFilings(b.entity, b.catalogs, (rows ?? []).filter(r => r.entity_id === b.entity.id), today),
      })),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.get('/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    if (!(await ownsEntity(userId, req.params.entity_id))) return res.status(404).json({ error: 'Entity not found' })
    const years = req.query.years ? String(req.query.years).split(',').map(Number).filter(Number.isFinite) : undefined
    const runs = await latestRuns(supabase, userId, req.params.entity_id, years)
    const all = req.query.include_passed === '1'
    const notes = await listNotes(supabase, userId, [req.params.entity_id], { years, statuses: all ? undefined : ['open', 'info'] })
    res.json({
      runs: runs.map(r => ({
        run_id: r.run_id, tax_year: r.tax_year, framework_version: r.framework_version, summary: r.summary,
        findings: r.findings.filter(f => all || ACT.has(f.status) || f.change === 'resolved').sort((a, b) => SEV[a.severity] - SEV[b.severity]).map(compact),
      })),
      notes,
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/:entity_id/resolve', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const { fingerprint, resolution, note } = req.body ?? {}
  if (!fingerprint || !['fixed', 'accepted', 'not_an_issue', 'reopened'].includes(resolution)) {
    return res.status(400).json({ error: 'fingerprint and resolution (fixed | accepted | not_an_issue | reopened) are required' })
  }
  try {
    if (!(await ownsEntity(userId, req.params.entity_id))) return res.status(404).json({ error: 'Entity not found' })
    res.json(await resolveFinding(supabase, userId, req.params.entity_id, { fingerprint, resolution, note, resolved_by: userId }))
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
