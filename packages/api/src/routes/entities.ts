/**
 * Entity routes — CRUD for tax entities (individuals, corps)
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { encryptedFields, encryptionEnabled, hydrate, hydrateAll } from '../lib/row_crypto.js'
import { blindIndex } from '../lib/crypto.js'

const ENCRYPTED_ENTITY_FIELDS = { text: ['ein'] }
const safeBlindIndex = (v: string | null | undefined) =>
  (v && encryptionEnabled() && process.env.TAX_API_BLIND_HMAC) ? blindIndex(v) : null

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

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

// List entities with return counts
router.get('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data, error } = await supabase.from('tax_entity')
    .select('*, tax_return(id, tax_year, form_type, status, source)')
    .eq('user_id', userId)
    .order('name')

  if (error) return res.status(500).json({ error: error.message })

  await hydrateAll(supabase, data || [], ENCRYPTED_ENTITY_FIELDS)

  const entities = (data || []).map((e: any) => ({
    ...e,
    return_count: e.tax_return?.length || 0,
    tax_return: undefined,
    returns: e.tax_return || [],
  }))

  res.json({ entities })
})

// Get single entity with returns and scenarios
router.get('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data: entity } = await supabase.from('tax_entity')
    .select('*').eq('id', req.params.id).eq('user_id', userId).single()
  if (!entity) return res.status(404).json({ error: 'Entity not found' })
  await hydrate(supabase, entity, ENCRYPTED_ENTITY_FIELDS)

  const [{ data: returns }, { data: scenarios }] = await Promise.all([
    supabase.from('tax_return')
      .select('id, tax_year, form_type, status, source, computed_at')
      .eq('entity_id', entity.id)
      .order('tax_year', { ascending: false }),
    supabase.from('scenario')
      .select('id, name, tax_year, status, created_at')
      .eq('entity_id', entity.id)
      .order('created_at', { ascending: false }),
  ])

  res.json({ entity, returns: returns || [], scenarios: scenarios || [] })
})

// Create entity
router.post('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { name, form_type, ein, address, entity_type } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })

  // Derive entity_type from form_type if not provided
  const FORM_TO_ENTITY: Record<string, string> = {
    '1040': 'individual', '1120': 'c_corp', '1120S': 's_corp', '1065': 'partnership',
    '990': 'nonprofit', '4868': 'individual', '7004': 'c_corp', '8868': 'nonprofit',
  }
  const resolvedEntityType = entity_type || FORM_TO_ENTITY[form_type] || 'individual'

  const einEnc = await encryptedFields(supabase, userId, { ein }, ENCRYPTED_ENTITY_FIELDS)
  const { data, error } = await supabase.from('tax_entity').insert({
    user_id: userId,
    name,
    form_type: form_type || null,
    entity_type: resolvedEntityType,
    ein: ein || null,
    ein_hash: safeBlindIndex(ein),
    ...einEnc,
    address: address || null,
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  await hydrate(supabase, data, ENCRYPTED_ENTITY_FIELDS)
  res.json({ entity: data })
})

// Update entity
router.put('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { name, form_type, ein, address, city, state, zip, date_incorporated, meta, meta_merge } = req.body
  const updates: any = {}
  if (name !== undefined) updates.name = name
  if (form_type !== undefined) updates.form_type = form_type
  if (ein !== undefined) {
    updates.ein = ein
    updates.ein_hash = safeBlindIndex(ein)
    Object.assign(updates, await encryptedFields(supabase, userId, { ein }, ENCRYPTED_ENTITY_FIELDS))
  }
  if (address !== undefined) updates.address = address
  if (city !== undefined) updates.city = city
  if (state !== undefined) updates.state = state
  if (zip !== undefined) updates.zip = zip
  if (date_incorporated !== undefined) updates.date_incorporated = date_incorporated
  if (meta !== undefined) updates.meta = meta  // replaces entire meta

  // meta_merge shallow-merges with existing meta (preserves other keys)
  if (meta_merge !== undefined) {
    const { data: existing } = await supabase.from('tax_entity')
      .select('meta').eq('id', req.params.id).eq('user_id', userId).single()
    updates.meta = { ...(existing?.meta || {}), ...meta_merge }
  }

  const { data, error } = await supabase.from('tax_entity')
    .update(updates).eq('id', req.params.id).eq('user_id', userId).select().single()

  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Entity not found' })
  res.json({ entity: data })
})

// Delete entity — cascades to tax_return, scenario, document
router.delete('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data: entity } = await supabase.from('tax_entity')
    .select('id, name, form_type, user_id').eq('id', req.params.id).single()
  if (!entity) return res.status(404).json({ error: 'Entity not found' })
  if (entity.user_id !== userId) return res.status(403).json({ error: 'Forbidden' })

  // Cascade: scenarios → returns → documents → qbo_connection → stripe_connection
  await supabase.from('scenario').delete().eq('entity_id', req.params.id)
  await supabase.from('tax_return').delete().eq('entity_id', req.params.id)
  await supabase.from('document').delete().eq('entity_id', req.params.id)
  await supabase.from('qbo_connection').delete().eq('entity_id', req.params.id)
  await supabase.from('stripe_connection').delete().eq('entity_id', req.params.id)

  const { error } = await supabase.from('tax_entity').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  res.json({
    success: true,
    deleted: { id: entity.id, name: entity.name, form_type: entity.form_type },
  })
})

export default router
