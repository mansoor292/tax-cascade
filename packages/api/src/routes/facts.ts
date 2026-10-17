/**
 * Fact routes — the answers to the fact registry (@taxengine/shared facts.ts).
 *
 *   GET  /api/facts/:entity_id?year=&history=1   current answers (or full history)
 *   GET  /api/facts/:entity_id/gaps?year=&form_type=
 *                                                the registry's list for this
 *                                                return, each fact with a status
 *   POST /api/facts                              record one answer (supersedes
 *                                                the previous one, never edits it)
 *
 * Why these exist: facts like who lent the company money, material
 * participation and the S-election history used to live in free-text notes
 * and surfaced one at a time. Every write here is validated against the
 * registry — an unknown key, a key for another return type, or a value of the
 * wrong type is refused — so the answers stay in the one shape the gap check
 * and the review can read.
 *
 * Mounted in server.ts with the other /api routes, ahead of the SPA fallback
 * (root CLAUDE.md, fact 2).
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import {
  checkFactInput, factGaps, isFactFormType, listFacts, recordFact,
} from '../services/facts.js'

const supabase = lazyServiceClient()

const router = Router()

/** The entity, if the caller owns it. */
async function ownedEntity(userId: string, entityId: string) {
  const { data } = await supabase.from('tax_entity')
    .select('id, name, form_type')
    .eq('id', entityId)
    .eq('user_id', userId)
    .maybeSingle()
  return data as { id: string; name: string; form_type: string } | null
}

function parseYear(v: unknown): number | null | 'bad' {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : 'bad'
}

// Registered before '/:entity_id' only for readability — the extra path
// segment already keeps the two apart.
router.get('/:entity_id/gaps', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const year = parseYear(req.query.year)
  if (year === null || year === 'bad') {
    return res.status(400).json({ error: 'year is required as a four-digit tax year', field: 'year' })
  }

  const entity = await ownedEntity(userId, req.params.entity_id)
  if (!entity) return res.status(404).json({ error: 'Entity not found' })

  const formType = (req.query.form_type as string | undefined) || entity.form_type
  if (!isFactFormType(formType)) {
    return res.status(400).json({ error: `Unsupported form_type: ${formType}`, field: 'form_type' })
  }

  try {
    const { summary, gaps } = await factGaps(supabase, userId, entity, formType, year)
    res.json({ entity_id: entity.id, entity_name: entity.name, form_type: formType, tax_year: year, summary, gaps })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.get('/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const year = parseYear(req.query.year)
  if (year === 'bad') return res.status(400).json({ error: 'year must be a four-digit tax year', field: 'year' })

  const entity = await ownedEntity(userId, req.params.entity_id)
  if (!entity) return res.status(404).json({ error: 'Entity not found' })

  const history = req.query.history === '1' || req.query.history === 'true'
  try {
    const facts = await listFacts(supabase, userId, entity.id, {
      ...(year !== null ? { taxYear: year } : {}),
      includeHistory: history,
    })
    res.json({ entity_id: entity.id, tax_year: year, include_history: history, facts })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = req.body || {}
  if (typeof body.entity_id !== 'string' || !body.entity_id) {
    return res.status(400).json({ error: 'entity_id is required', field: 'entity_id' })
  }
  const entity = await ownedEntity(userId, body.entity_id)
  if (!entity) return res.status(404).json({ error: 'Entity not found' })

  const checked = checkFactInput({ ...body, recorded_by: body.recorded_by || `user:${userId}` }, entity.form_type)
  if (!checked.ok) {
    const { ok: _ok, ...rest } = checked
    return res.status(400).json(rest)
  }

  // The evidence must be the caller's own document — a foreign document id
  // would otherwise sit on this fact as "support" nobody here can open.
  const evidenceId = checked.fact.row.evidence_document_id
  if (evidenceId) {
    const { data: doc } = await supabase.from('document')
      .select('id').eq('id', evidenceId).eq('user_id', userId).maybeSingle()
    if (!doc) return res.status(400).json({ error: 'evidence_document_id does not name one of your documents', field: 'evidence_document_id' })
  }

  try {
    const out = await recordFact(supabase, userId, checked.fact)
    res.json(out)
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
