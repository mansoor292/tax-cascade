/**
 * Entity-map routes (services/entity_map.ts, review/map.ts): how the entities
 * in one account are tied together.
 *
 *   GET   /api/entity-map                    the map: entities (and what a change to
 *                                            each touches), links, owners, and the
 *                                            evidence no link answers yet (?history=1
 *                                            adds every version of every link)
 *   POST  /api/entity-map/links              record a link
 *   PATCH /api/entity-map/links/:link_key    change or retire a link (a new version;
 *                                            the old one is kept)
 *
 * Mounted with the other /api routes, ahead of the SPA fallback (root
 * CLAUDE.md, fact 2).
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { loadBundles } from '../review/store.js'
import { addLink, assembleMap, checkLinkComplete, checkLinkFields, factsByEntity, listLinks, updateLink } from '../services/entity_map.js'

const supabase = lazyServiceClient()
const router = Router()

async function accountEntities(userId: string) {
  const { data, error } = await supabase.from('tax_entity').select('id, form_type, name').eq('user_id', userId)
  if (error) throw new Error(error.message)
  return data ?? []
}

router.get('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const bundles = await loadBundles(supabase, userId)
    const [links, facts] = await Promise.all([listLinks(supabase, userId), factsByEntity(supabase, userId, bundles.map(b => b.entity.id))])
    const map = assembleMap(bundles, links, facts)
    res.json(req.query.history === '1' ? { ...map, history: await listLinks(supabase, userId, { includeHistory: true }) } : map)
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/links', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const checked = checkLinkFields(req.body ?? {})
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field })
  try {
    const complete = checkLinkComplete(checked.fields, await accountEntities(userId))
    if (!complete.ok) return res.status(400).json({ error: complete.error, field: complete.field })
    res.status(201).json({ link: await addLink(supabase, userId, complete.link, userId) })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.patch('/links/:link_key', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const checked = checkLinkFields(req.body ?? {})
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field })
  if (!Object.keys(checked.fields).length) return res.status(400).json({ error: 'nothing to change' })
  try {
    const out = await updateLink(supabase, userId, req.params.link_key, checked.fields, await accountEntities(userId), userId)
    if (!out) return res.status(404).json({ error: 'Link not found' })
    if ('error' in out) return res.status(400).json({ error: out.error, field: out.field })
    res.json(out)
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
