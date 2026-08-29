/**
 * Entity routes — CRUD for tax entities (individuals, corps)
 */
import { Router,  } from 'express'
import { encryptedFields, encryptionEnabled, hydrate, hydrateAll, ENCRYPTED_ENTITY_FIELDS } from '../lib/row_crypto.js'
import { accountingMethodCacheBust } from './qbo.js'
import { blindIndex } from '../lib/crypto.js'
import { sendDbError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'

const safeBlindIndex = (v: string | null | undefined) =>
  (v && encryptionEnabled() && process.env.TAX_API_BLIND_HMAC) ? blindIndex(v) : null

const supabase = lazyServiceClient()


const router = Router()

// List entities with return counts
router.get('/', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data, error } = await supabase.from('tax_entity')
    .select('*, tax_return(id, tax_year, form_type, status, source)')
    .eq('user_id', userId)
    .order('name')

  if (error) return sendDbError(res, error)

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

  const { name, ein, address, entity_type, legal_form } = req.body
  let { form_type } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })

  // Derive entity_type from form_type if not provided
  // These four are what the database actually accepts. The map used to also
  // list 990, 4868, 7004 and 8868 — so those were offered as entity form types
  // and every one of them failed on a check constraint with a 500. The
  // extension forms were never entity types at all; they are filings an entity
  // makes, and 990 is not supported yet.
  const FORM_TO_ENTITY: Record<string, string> = {
    '1040': 'individual', '1120': 'c_corp', '1120S': 's_corp', '1065': 'partnership',
  }
  // form_type is NOT NULL in the database, but this handler used to write
  // `form_type || null` — so creating an entity without one answered 500 with
  // a raw Postgres constraint error. The MCP tool documents form_type as
  // optional, which made "create an entity for the family trust" a guaranteed
  // crash on the most natural phrasing.
  //
  // Recover it from entity_type when we can. When we cannot, ask — silently
  // picking a tax form for someone is not a kindness in a tax product.
  if (!form_type && entity_type) {
    form_type = Object.keys(FORM_TO_ENTITY).find(f => FORM_TO_ENTITY[f] === entity_type)
  }
  if (!form_type) {
    return res.status(400).json({
      error: 'form_type is required (or pass entity_type and it will be derived).',
      supported: Object.keys(FORM_TO_ENTITY),
    })
  }
  if (!FORM_TO_ENTITY[form_type]) {
    return res.status(400).json({
      error: `Unsupported form_type: ${form_type}`,
      supported: Object.keys(FORM_TO_ENTITY),
    })
  }
  const resolvedEntityType = entity_type || FORM_TO_ENTITY[form_type]

  const einEnc = await encryptedFields(supabase, userId, { ein }, ENCRYPTED_ENTITY_FIELDS)
  const { data, error } = await supabase.from('tax_entity').insert({
    user_id: userId,
    name,
    form_type,
    entity_type: resolvedEntityType,
    ein: ein || null,
    ein_hash: safeBlindIndex(ein),
    ...einEnc,
    address: address || null,
    legal_form: legal_form || null,
  }).select().single()

  if (error) return sendDbError(res, error)
  await hydrate(supabase, data, ENCRYPTED_ENTITY_FIELDS)
  res.json({ entity: data })
})

// Update entity
router.put('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { name, form_type, ein, address, city, state, zip, date_incorporated, meta, meta_merge, legal_form } = req.body
  const updates: any = {}
  if (name !== undefined) updates.name = name
  if (form_type !== undefined) {
    updates.form_type = form_type
    // Keep entity_type in sync with form_type on update. Mirrors create_entity
    // and avoids stale c_corp on a 1120S-switched entity (which confuses both
    // the compute engine and any downstream filtering).
    const FORM_TO_ENTITY: Record<string, string> = {
      '1040': 'individual', '1120': 'c_corp', '1120S': 's_corp', '1065': 'partnership',
    }
    if (FORM_TO_ENTITY[form_type]) updates.entity_type = FORM_TO_ENTITY[form_type]
  }
  if (ein !== undefined) {
    updates.ein = ein
    updates.ein_hash = safeBlindIndex(ein)
    Object.assign(updates, await encryptedFields(supabase, userId, { ein }, ENCRYPTED_ENTITY_FIELDS))
  }
  if (address !== undefined) updates.address = address
  // Legal form is its own axis — changing the tax treatment must not clear it.
  if (legal_form !== undefined) updates.legal_form = legal_form || null
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

  if (error) return sendDbError(res, error)
  if (!data) return res.status(404).json({ error: 'Entity not found' })

  // If the accounting method override changed, bust the QBO cache so the
  // next /financials or /reports fetch requests the new basis from QBO.
  const touchesMethod =
    (meta && Object.prototype.hasOwnProperty.call(meta, 'accounting_method')) ||
    (meta_merge && Object.prototype.hasOwnProperty.call(meta_merge, 'accounting_method'))
  if (touchesMethod) accountingMethodCacheBust(req.params.id)

  // Decrypt before answering, and never hand the ciphertext blob back. Without
  // this the response reported ein as null on any edit that did not touch it —
  // the stored value was intact, but a client trusting the response would have
  // concluded the identifier had been cleared.
  await hydrate(supabase, data, ENCRYPTED_ENTITY_FIELDS)
  for (const k of Object.keys(data || {})) if (k.endsWith('_enc')) delete (data as any)[k]

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
  if (error) return sendDbError(res, error)

  res.json({
    success: true,
    deleted: { id: entity.id, name: entity.name, form_type: entity.form_type },
  })
})

export default router
