/**
 * Entity routes — CRUD for tax entities (individuals, corps)
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'

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
    .select('*, tax_return(id, tax_year, form_type, status)')
    .eq('user_id', userId)
    .order('name')

  if (error) return res.status(500).json({ error: error.message })

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

  const [{ data: returns }, { data: scenarios }] = await Promise.all([
    supabase.from('tax_return')
      .select('id, tax_year, form_type, status, computed_at')
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

  const { name, form_type, ein, address } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })

  const { data, error } = await supabase.from('tax_entity').insert({
    user_id: userId,
    name,
    form_type: form_type || null,
    ein: ein || null,
    address: address || null,
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ entity: data })
})

// Update entity
router.put('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { name, form_type, ein, address } = req.body
  const updates: any = {}
  if (name !== undefined) updates.name = name
  if (form_type !== undefined) updates.form_type = form_type
  if (ein !== undefined) updates.ein = ein
  if (address !== undefined) updates.address = address

  const { data, error } = await supabase.from('tax_entity')
    .update(updates).eq('id', req.params.id).eq('user_id', userId).select().single()

  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Entity not found' })
  res.json({ entity: data })
})

export default router
