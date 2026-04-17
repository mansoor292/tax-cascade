/**
 * Scratch routes — per-user JSON blob storage so the AI can park large
 * intermediate payloads (QBO transaction lists, Stripe exports, etc.)
 * outside the chat context window and reload them on demand.
 *
 * Storage: Supabase bucket `ai-scratch`, keyed as `{user_id}/{key}.json`.
 * Scoping: enforced here in the app layer via the user_id the API middleware
 * attached to `req` — same convention as documents.ts / entities.ts.
 */
import { Router, type Request } from 'express'
import { supabase as admin } from './auth.js'
// Bucket has permissive RLS policies (anon allowed); app layer enforces {user_id}/ scoping.
// If SUPABASE_SERVICE_ROLE_KEY is later added to env, swap this import for a service-role client.

const BUCKET = 'ai-scratch'
const MAX_BYTES = 10 * 1024 * 1024
const KEY_RE = /^[a-zA-Z0-9][\w.:-]{0,127}$/

const router = Router()

function userId(req: Request): string | null {
  return (req as any).userId || null
}

function objectPath(uid: string, key: string) {
  return `${uid}/${key}.json`
}

// PUT /api/scratch/:key — save a JSON blob
router.put('/:key', async (req, res) => {
  const uid = userId(req)
  if (!uid) return res.status(401).json({ error: 'Unauthorized' })

  const { key } = req.params
  if (!KEY_RE.test(key)) {
    return res.status(400).json({ error: 'Invalid key', pattern: KEY_RE.source })
  }

  const body = Buffer.from(JSON.stringify(req.body))
  if (body.byteLength > MAX_BYTES) {
    return res.status(413).json({
      error: `Payload exceeds ${MAX_BYTES} bytes — narrow your query or split into multiple keys`,
      size_bytes: body.byteLength,
      max_bytes: MAX_BYTES,
    })
  }

  const { error } = await admin.storage.from(BUCKET).upload(objectPath(uid, key), body, {
    contentType: 'application/json',
    upsert: true,
  })
  if (error) return res.status(500).json({ error: error.message })

  res.json({ key, size_bytes: body.byteLength, saved_at: new Date().toISOString() })
})

// GET /api/scratch/:key — fetch the stored JSON
router.get('/:key', async (req, res) => {
  const uid = userId(req)
  if (!uid) return res.status(401).json({ error: 'Unauthorized' })

  const { key } = req.params
  if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid key' })

  const { data, error } = await admin.storage.from(BUCKET).download(objectPath(uid, key))
  if (error || !data) return res.status(404).json({ error: 'Not found', key })

  const text = await data.text()
  try {
    res.json(JSON.parse(text))
  } catch {
    res.status(500).json({ error: 'Stored blob is not valid JSON' })
  }
})

// GET /api/scratch — list blobs for this user
router.get('/', async (req, res) => {
  const uid = userId(req)
  if (!uid) return res.status(401).json({ error: 'Unauthorized' })

  const prefix = (req.query.prefix as string) || ''
  const { data, error } = await admin.storage.from(BUCKET).list(uid, {
    limit: 1000,
    search: prefix || undefined,
  })
  if (error) return res.status(500).json({ error: error.message })

  const blobs = (data || [])
    .filter(o => o.name.endsWith('.json'))
    .map(o => ({
      key: o.name.replace(/\.json$/, ''),
      size_bytes: (o.metadata as any)?.size ?? null,
      updated_at: o.updated_at,
    }))

  res.json({ blobs })
})

// DELETE /api/scratch/:key
router.delete('/:key', async (req, res) => {
  const uid = userId(req)
  if (!uid) return res.status(401).json({ error: 'Unauthorized' })

  const { key } = req.params
  if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid key' })

  const { error } = await admin.storage.from(BUCKET).remove([objectPath(uid, key)])
  if (error) return res.status(500).json({ error: error.message })

  res.json({ deleted: key })
})

export default router

// Exported so other routes (or the MCP layer) can spill payloads directly without
// a localhost round-trip through the PUT handler.
export async function spillForUser(uid: string, key: string, data: any): Promise<{ ok: true; key: string; size_bytes: number } | { ok: false; error: string; status: number }> {
  if (!KEY_RE.test(key)) return { ok: false, error: 'Invalid scratch key', status: 400 }
  const body = Buffer.from(JSON.stringify(data))
  if (body.byteLength > MAX_BYTES) {
    return { ok: false, error: `Payload exceeds ${MAX_BYTES} bytes`, status: 413 }
  }
  const { error } = await admin.storage.from(BUCKET).upload(`${uid}/${key}.json`, body, {
    contentType: 'application/json',
    upsert: true,
  })
  if (error) return { ok: false, error: error.message, status: 500 }
  return { ok: true, key, size_bytes: body.byteLength }
}
