/**
 * Tax calendar routes — upcoming filing and payment obligations.
 *
 * Obligations are generated from rules (src/engine/tax_calendar.ts), not
 * authored. GET /api/calendar auto-refreshes on read so a newly created
 * entity has a calendar immediately without anyone pressing a button.
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import {
  generateObligations,
  daysUntil,
  urgency,
  type EntityForCalendar,
  type GeneratedObligation,
} from '../engine/tax_calendar.js'
import { sendError, sendDbError } from '../lib/http_error.js'

// NOTE: route modules are ESM imports of server.ts, so they evaluate BEFORE
// server.ts calls loadEnv(). process.env is therefore not yet populated here
// and the literal fallback is what actually gets used — same as every other
// route file. An empty-string fallback throws "supabaseKey is required" at
// import time and takes the whole server down, so do not "tidy" this away.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function getUser(req: Request): Promise<string | null> {
  if ((req as any).userId) return (req as any).userId
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token)
    return user?.id || null
  }
  return null
}

const router = Router()

/** Server-side today, so the client cannot shift what counts as overdue. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Which tax years to generate for. Deliberately narrow: the year just ended
 * (still being filed), the current one (estimateds running), and the prior
 * one (late/amended work). Going wider fills the list with noise.
 */
function targetYears(today: string): number[] {
  const y = Number(today.slice(0, 4))
  return [y - 2, y - 1, y]
}

/**
 * Regenerate obligations for a user's entities and upsert them.
 *
 * The upsert deliberately does NOT touch status/completed_at/amount/notes —
 * those are the user's. Supabase upsert would overwrite them with defaults,
 * so existing keys are filtered out and only their derived fields are patched.
 */
async function refreshForUser(userId: string, entityId?: string) {
  let q = supabase.from('tax_entity')
    .select('id, form_type, entity_type, state, fiscal_year_end')
    .eq('user_id', userId)
  if (entityId) q = q.eq('id', entityId)
  const { data: entities, error } = await q
  if (error) throw new Error(error.message)
  if (!entities?.length) return { generated: 0, entities: 0 }

  const ids = entities.map((e: any) => e.id)

  // Which years already have a filed extension, so the generator can use the
  // extended due date rather than the original one.
  const { data: returnRows } = await supabase.from('tax_return')
    .select('entity_id, tax_year, source, status')
    .in('entity_id', ids)

  const extendedByEntity = new Map<string, number[]>()
  // A year whose return is already filed is CLOSED: its estimated payments are
  // history, not outstanding work. Without this the calendar opens with dozens
  // of years-old "overdue" estimateds, which is both wrong and alarming.
  const closedYears = new Map<string, Set<number>>()
  for (const r of returnRows || []) {
    if (r.source === 'extension') {
      const list = extendedByEntity.get(r.entity_id) || []
      list.push(r.tax_year)
      extendedByEntity.set(r.entity_id, list)
    }
    if (r.source === 'filed_import' || r.status === 'filed') {
      const set = closedYears.get(r.entity_id) || new Set<number>()
      set.add(r.tax_year)
      closedYears.set(r.entity_id, set)
    }
  }

  const today = todayIso()
  const generated: GeneratedObligation[] = []
  for (const e of entities as any[]) {
    const forCal: EntityForCalendar = {
      id: e.id,
      form_type: e.form_type,
      entity_type: e.entity_type,
      state: e.state,
      fiscal_year_end: e.fiscal_year_end,
      extended_years: extendedByEntity.get(e.id) || [],
    }
    const closed = closedYears.get(e.id) || new Set<number>()
    for (const year of targetYears(today)) {
      for (const o of generateObligations(forCal, year)) {
        // Closed year: drop everything except the return row itself, which is
        // inserted below already marked done so the history stays legible.
        if (closed.has(year) && o.kind !== 'return') continue
        // Anything more than a full cycle past due is history the calendar
        // cannot act on. A genuine recent miss still surfaces as overdue.
        if (daysUntil(o.due_date, today) < -400) continue
        generated.push(o)
      }
    }
  }
  if (!generated.length) return { generated: 0, entities: entities.length }

  /** A return obligation for an already-filed year lands as done, not pending. */
  const initialStatus = (g: GeneratedObligation): 'pending' | 'done' =>
    g.kind === 'return' && (closedYears.get(g.entity_id)?.has(g.tax_year) ?? false)
      ? 'done'
      : 'pending'

  const { data: existing } = await supabase.from('obligation')
    .select('id, entity_id, obligation_key')
    .eq('user_id', userId)
    .in('entity_id', ids)

  const existingByKey = new Map<string, string>()
  for (const row of existing || []) {
    existingByKey.set(`${row.entity_id}::${row.obligation_key}`, row.id)
  }

  const inserts = generated
    .filter(g => !existingByKey.has(`${g.entity_id}::${g.obligation_key}`))
    .map(g => ({
      user_id: userId,
      entity_id: g.entity_id,
      obligation_key: g.obligation_key,
      source: 'generated',
      kind: g.kind,
      title: g.title,
      due_date: g.due_date,
      tax_year: g.tax_year,
      period: g.period,
      jurisdiction: g.jurisdiction,
      form: g.form,
      extended: g.extended,
      status: initialStatus(g),
      meta: g.note ? { note: g.note } : {},
    }))

  if (inserts.length) {
    const { error: insErr } = await supabase.from('obligation').insert(inserts)
    if (insErr) throw new Error(insErr.message)
  }

  // Patch derived fields on rows that already exist — a due date can move
  // when an extension gets filed. User-owned columns are left alone.
  for (const g of generated) {
    const id = existingByKey.get(`${g.entity_id}::${g.obligation_key}`)
    if (!id) continue
    await supabase.from('obligation').update({
      title: g.title,
      due_date: g.due_date,
      extended: g.extended,
      meta: g.note ? { note: g.note } : {},
      updated_at: new Date().toISOString(),
    }).eq('id', id)
  }

  return { generated: generated.length, inserted: inserts.length, entities: entities.length }
}

/**
 * GET /api/calendar
 *
 * Query: entity_id, within_days, status (default pending), include_dismissed
 * Returns obligations sorted by due date with days_until and urgency attached.
 */
router.get('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    if (req.query.refresh !== 'false') {
      await refreshForUser(userId, req.query.entity_id as string | undefined)
    }

    let q = supabase.from('obligation')
      .select('*, tax_entity(name, form_type)')
      .eq('user_id', userId)
      .order('due_date', { ascending: true })

    if (req.query.entity_id) q = q.eq('entity_id', req.query.entity_id as string)
    if (req.query.status) q = q.eq('status', req.query.status as string)
    else if (req.query.include_dismissed !== 'true') q = q.neq('status', 'dismissed')

    const { data, error } = await q
    if (error) return sendDbError(res, error)

    const today = todayIso()

    // An obligation that fell due before we knew the entity existed cannot be
    // reported as missed — see urgency() in the calendar engine.
    const { data: ents } = await supabase.from('tax_entity')
      .select('id, created_at').eq('user_id', userId)
    const knownSince = new Map<string, string>(
      (ents || []).map((e: any) => [e.id, String(e.created_at).slice(0, 10)]),
    )

    let rows = (data || []).map((r: any) => ({
      ...r,
      days_until: daysUntil(r.due_date, today),
      urgency: urgency(r.due_date, today, r.status, knownSince.get(r.entity_id) || null),
    }))

    const within = Number(req.query.within_days)
    if (!Number.isNaN(within) && within > 0) {
      // Overdue items stay visible regardless of the window — they are the
      // whole point of the feature.
      rows = rows.filter((r: any) => r.days_until <= within)
    }

    res.json({
      today,
      count: rows.length,
      overdue: rows.filter((r: any) => r.urgency === 'overdue').length,
      unverified: rows.filter((r: any) => r.urgency === 'unverified').length,
      due_soon: rows.filter((r: any) => r.urgency === 'due_soon').length,
      obligations: rows,
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

/** POST /api/calendar/refresh — regenerate explicitly. */
router.post('/refresh', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    res.json(await refreshForUser(userId, req.body?.entity_id))
  } catch (e: any) {
    sendError(res, e)
  }
})

/** POST /api/calendar — create a custom obligation (insurance renewal, board meeting). */

/**
 * Accept only a real ISO calendar date.
 *
 * The column is `date`, and Postgres accepts its own special literals there:
 * 'tomorrow' silently became a real date, and 'infinity' was stored as
 * literal infinity. Both produce an obligation whose due date is not the one
 * anyone typed — a wrong deadline that looks like a real one, which in a
 * filing calendar is the whole product being quietly wrong.
 */
function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  // Rejects 2026-02-30 and friends, which JS would otherwise roll forward.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const BAD_DATE = 'due_date must be a real calendar date as YYYY-MM-DD'

router.post('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { entity_id, title, due_date, kind, notes, amount, tax_year } = req.body || {}
  if (!entity_id || !title || !due_date) {
    return res.status(400).json({ error: 'entity_id, title and due_date are required' })
  }
  if (!isCalendarDate(due_date)) {
    return res.status(400).json({ error: BAD_DATE, field: 'due_date', received: due_date })
  }

  const { data: ent } = await supabase.from('tax_entity')
    .select('id').eq('id', entity_id).eq('user_id', userId).maybeSingle()
  if (!ent) return res.status(404).json({ error: 'Entity not found' })

  const { data, error } = await supabase.from('obligation').insert({
    user_id: userId,
    entity_id,
    obligation_key: `custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    source: 'custom',
    kind: kind || 'other',
    title,
    due_date,
    tax_year: tax_year ?? null,
    notes: notes ?? null,
    amount: amount ?? null,
  }).select().single()

  if (error) return sendDbError(res, error)
  res.json({ obligation: data })
})

/** PATCH /api/calendar/:id — mark done/dismissed, record an amount or note. */
router.patch('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { status, amount, notes, due_date } = req.body || {}
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (status) {
    if (!['pending', 'done', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, done or dismissed' })
    }
    patch.status = status
    patch.completed_at = status === 'done' ? new Date().toISOString() : null
  }
  if (amount !== undefined) patch.amount = amount
  if (notes !== undefined) patch.notes = notes
  if (due_date !== undefined) {
    if (!isCalendarDate(due_date)) {
      return res.status(400).json({ error: BAD_DATE, field: 'due_date', received: due_date })
    }
    patch.due_date = due_date
  }

  const { data, error } = await supabase.from('obligation')
    .update(patch)
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .select()
    .maybeSingle()

  if (error) return sendDbError(res, error)
  if (!data) return res.status(404).json({ error: 'Obligation not found' })
  res.json({ obligation: data })
})

/** DELETE /api/calendar/:id — custom rows only; generated rows come back on refresh. */
router.delete('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data: row } = await supabase.from('obligation')
    .select('id, source').eq('id', req.params.id).eq('user_id', userId).maybeSingle()
  if (!row) return res.status(404).json({ error: 'Obligation not found' })
  if (row.source === 'generated') {
    return res.status(400).json({
      error: 'Generated obligations cannot be deleted — dismiss it instead (PATCH status=dismissed).',
    })
  }

  const { error } = await supabase.from('obligation').delete().eq('id', req.params.id)
  if (error) return sendDbError(res, error)
  res.json({ ok: true })
})

export default router
