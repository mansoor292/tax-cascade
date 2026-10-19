/**
 * Version-set routes (services/versions.ts, review/versions.ts): restatement
 * packages across the group, each held to the tie checks.
 *
 *   GET    /api/version-sets                         every set, its amended returns and their changes
 *   POST   /api/version-sets                         start a draft set {label, title, description}
 *   PATCH  /api/version-sets/:label                  title/description, or status filed/abandoned
 *                                                    (filing re-runs the filed view for its returns)
 *   PUT    /api/version-sets/:label/versions         add or replace one amended return
 *                                                    {entity_id, tax_year, form, note, changes[]}
 *   DELETE /api/version-sets/:label/versions/:entity_id/:tax_year
 *   GET    /api/version-sets/:label/breaks           the view's breaks from its latest runs,
 *                                                    without running anything (the Group page)
 *   POST   /api/version-sets/:label/review           run the view and report its breaks:
 *                                                    a draft set's tie checks for every return,
 *                                                    each break marked new or inherited from
 *                                                    filed, and the filed breaks it fixes;
 *                                                    'filed' re-runs the full rules review
 *
 * Mounted with the other /api routes, ahead of the SPA fallback (root
 * CLAUDE.md, fact 2).
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { loadBundles, loadMapInputs, runReview, setBreaksReport, viewBreaks } from '../review/store.js'
import { checkSetFields, createSet, listSets, putVersion, removeVersion, updateSet, versionRows } from '../services/versions.js'

const supabase = lazyServiceClient()
const router = Router()

async function accountEntities(userId: string) {
  const { data, error } = await supabase.from('tax_entity').select('id, name, form_type').eq('user_id', userId)
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Run one view for every entity and year that has a filed return, or that
 *  the view amends. Draft sets run the tie checks; 'filed' runs the full
 *  rules review (a partial run would mark every other finding resolved). */
async function runView(userId: string, view: string, only?: string[]) {
  const bundles = await loadBundles(supabase, userId)
  const map = await loadMapInputs(supabase, userId, bundles)
  const versions = versionRows(await listSets(supabase, userId))
  let runs = 0
  for (const b of bundles.filter(x => !only || only.includes(x.entity.id))) {
    const years = new Set<number>([
      ...b.catalogs.filter(c => c.kind === 'filed_return' && c.tax_year !== null).map(c => c.tax_year as number),
      ...versions.filter(v => v.entity_id === b.entity.id && (v.set_label === view || v.set_status === 'filed')).map(v => v.tax_year),
    ])
    for (const y of [...years].sort()) {
      await runReview(supabase, userId, b.entity.id, y, { bundles, map, versions, versionSet: view })
      runs++
    }
  }
  return runs
}

router.get('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const ents = await accountEntities(userId)
    const name = (id: string) => ents.find(e => e.id === id)?.name ?? null
    const sets = await listSets(supabase, userId)
    res.json({ sets: sets.map(s => ({ ...s, versions: s.versions.map(v => ({ ...v, entity: name(v.entity_id) })) })) })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const checked = checkSetFields(req.body ?? {}, true)
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field })
  try {
    const out = await createSet(supabase, userId, checked.fields, userId)
    if ('ok' in out && out.ok === false) return res.status(400).json({ error: out.error, field: out.field })
    res.status(201).json({ set: out })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.patch('/:label', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const checked = checkSetFields(req.body ?? {}, false)
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field })
  if (!Object.keys(checked.fields).length) return res.status(400).json({ error: 'nothing to change' })
  try {
    const out = await updateSet(supabase, userId, req.params.label, checked.fields)
    if (!out) return res.status(404).json({ error: 'Version set not found' })
    if (out.ok === false) return res.status(400).json({ error: out.error, field: out.field })
    // A filed set changes what the IRS has: the filed view of the returns it
    // amends is reviewed again at once, so its fixes and breaks show.
    let refreshed = 0
    if (checked.fields.status === 'filed') {
      const set = (await listSets(supabase, userId)).find(s => s.label === req.params.label)
      refreshed = await runView(userId, 'filed', [...new Set(set?.versions.map(v => v.entity_id) ?? [])])
    }
    res.json({ ok: true, ...(refreshed ? { filed_view_runs: refreshed } : {}) })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.put('/:label/versions', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const out = await putVersion(supabase, userId, req.params.label, req.body ?? {}, userId)
    if (!out) return res.status(404).json({ error: 'Version set not found' })
    if ('ok' in out && out.ok === false) return res.status(400).json({ error: out.error, field: out.field })
    res.json(out)
  } catch (e: any) {
    sendError(res, e)
  }
})

router.delete('/:label/versions/:entity_id/:tax_year', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const out = await removeVersion(supabase, userId, req.params.label, req.params.entity_id, Number(req.params.tax_year))
    if (!out) return res.status(404).json({ error: 'Version set not found' })
    if (out.ok === false) return res.status(400).json({ error: out.error, field: out.field })
    res.json(out)
  } catch (e: any) {
    sendError(res, e)
  }
})

// Read-only: what the last review of a view found. The Group page shows
// this on every load, and a page load must not start a review of every
// return (a run of the filed view takes minutes and writes review history).
router.get('/:label/breaks', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const label = req.params.label
  try {
    const ents = await accountEntities(userId)
    if (label === 'filed') {
      const { breaks, covered } = await viewBreaks(supabase, userId, ents, 'filed')
      return res.json({ set: 'filed', reviewed_returns: covered.size, breaks_count: breaks.length, breaks, ties: breaks.length === 0 && covered.size > 0 })
    }
    const set = (await listSets(supabase, userId)).find(s => s.label === label)
    if (!set) return res.status(404).json({ error: 'Version set not found' })
    if (set.status !== 'draft') return res.status(400).json({ error: `set ${label} is ${set.status}; its returns are part of ${set.status === 'filed' ? 'the filed view' : 'no view'}`, field: 'label' })
    res.json(await setBreaksReport(supabase, userId, ents, label))
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/:label/review', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const label = req.params.label
  try {
    const ents = await accountEntities(userId)
    if (label === 'filed') {
      const runs = await runView(userId, 'filed')
      const { breaks } = await viewBreaks(supabase, userId, ents, 'filed')
      return res.json({ set: 'filed', reviewed_returns: runs, breaks_count: breaks.length, breaks, ties: breaks.length === 0 })
    }
    const set = (await listSets(supabase, userId)).find(s => s.label === label)
    if (!set) return res.status(404).json({ error: 'Version set not found' })
    if (set.status !== 'draft') return res.status(400).json({ error: `set ${label} is ${set.status}; its returns are part of ${set.status === 'filed' ? 'the filed view — review "filed"' : 'no view'}`, field: 'label' })
    await runView(userId, label)
    res.json(await setBreaksReport(supabase, userId, ents, label))
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
