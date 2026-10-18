/**
 * Return-note routes (services/notes.ts): the open threads about a return.
 *
 *   GET   /api/notes/:entity_id?year=&status=&history=1
 *                                        current notes for that year plus the
 *                                        entity-wide ones (or all years)
 *   POST  /api/notes/:entity_id          add a note
 *   PATCH /api/notes/:entity_id/:note_key
 *                                        edit or close a note (a new version;
 *                                        the old one is kept)
 *
 * Open notes are also listed by GET /api/review/summary, beside the findings.
 * Mounted with the other /api routes, ahead of the SPA fallback (root
 * CLAUDE.md, fact 2).
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { addNote, checkComplete, checkNoteFields, listNotes, updateNote, NOTE_STATUSES, type NoteStatus } from '../services/notes.js'

const supabase = lazyServiceClient()
const router = Router()

async function ownsEntity(userId: string, entityId: string): Promise<boolean> {
  const { data } = await supabase.from('tax_entity').select('id').eq('id', entityId).eq('user_id', userId).maybeSingle()
  return !!data
}

router.get('/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const year = req.query.year === undefined || req.query.year === '' ? undefined : Number(req.query.year)
  if (year !== undefined && !Number.isInteger(year)) return res.status(400).json({ error: 'year must be a four-digit tax year', field: 'year' })
  const statuses = req.query.status ? String(req.query.status).split(',') : undefined
  if (statuses?.some(s => !NOTE_STATUSES.includes(s as NoteStatus))) return res.status(400).json({ error: `status must be among ${NOTE_STATUSES.join(', ')}`, field: 'status' })
  try {
    if (!(await ownsEntity(userId, req.params.entity_id))) return res.status(404).json({ error: 'Entity not found' })
    const notes = await listNotes(supabase, userId, [req.params.entity_id], {
      years: year !== undefined ? [year] : undefined, statuses: statuses as NoteStatus[] | undefined, includeHistory: req.query.history === '1',
    })
    res.json({ count: notes.length, notes })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.post('/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const checked = checkNoteFields(req.body ?? {})
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field })
  const complete = checkComplete(checked.fields)
  if (!complete.ok) return res.status(400).json({ error: complete.error, field: complete.field })
  try {
    if (!(await ownsEntity(userId, req.params.entity_id))) return res.status(404).json({ error: 'Entity not found' })
    res.status(201).json({ note: await addNote(supabase, userId, req.params.entity_id, complete.note, userId) })
  } catch (e: any) {
    sendError(res, e)
  }
})

router.patch('/:entity_id/:note_key', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const checked = checkNoteFields(req.body ?? {})
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field })
  if (!Object.keys(checked.fields).length) return res.status(400).json({ error: 'nothing to change' })
  try {
    if (!(await ownsEntity(userId, req.params.entity_id))) return res.status(404).json({ error: 'Entity not found' })
    const out = await updateNote(supabase, userId, req.params.entity_id, req.params.note_key, checked.fields, userId)
    if (!out) return res.status(404).json({ error: 'Note not found' })
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
