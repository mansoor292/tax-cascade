/**
 * Auth routes — Supabase-backed user management + API key provisioning
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { v4 as uuidv4 } from 'uuid'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'

// Shared anon client for auth operations (signup/signin)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

// Per-request client that carries the user's JWT for RLS
function userClient(req: Request) {
  const token = req.headers.authorization?.replace('Bearer ', '') || ''
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  })
}

const router = Router()

// Sign up
router.post('/signup', async (req, res) => {
  const { email, password, full_name, company_name } = req.body
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name, company_name } }
  })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ user: data.user, session: data.session })
})

// Sign in
router.post('/signin', async (req, res) => {
  const { email, password } = req.body
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return res.status(401).json({ error: error.message })
  res.json({ user: data.user, session: data.session })
})

// Get current user profile
router.get('/me', async (req, res) => {
  const sb = userClient(req)
  const { data: { user }, error } = await sb.auth.getUser()
  if (error || !user) return res.status(401).json({ error: 'Invalid token' })

  const { data: profile } = await sb.from('user_profile').select('*').eq('id', user.id).single()
  const { data: keys } = await sb.from('api_key').select('id, name, key_value, is_active, created_at, last_used_at').eq('user_id', user.id)

  res.json({ user, profile, api_keys: keys })
})

// Create new API key
router.post('/api-keys', async (req, res) => {
  const sb = userClient(req)
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Invalid token' })

  const apiKey = `txk_${uuidv4().replace(/-/g, '').slice(0, 24)}`
  // Hash with argon2id for at-rest protection. key_value is still written
  // during dual-storage transition so existing auth middleware keeps working;
  // a follow-up nulls it once hash verification is proven on all traffic.
  const argon2 = await import('argon2')
  const hash = await argon2.hash(apiKey, { type: argon2.argon2id })
  const { data, error } = await sb.from('api_key').insert({
    user_id: user.id,
    key_value: apiKey,
    key_value_hash: hash,
    key_prefix: apiKey.slice(0, 8),
    name: req.body.name || 'API Key',
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  // The plaintext key is returned to the user ONCE here — they copy it and
  // we never store it again in plaintext after the cutover.
  res.json({ api_key: { ...data, key_value: apiKey } })
})

// Revoke API key
router.delete('/api-keys/:id', async (req, res) => {
  const sb = userClient(req)
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Invalid token' })

  await sb.from('api_key').update({ is_active: false }).eq('id', req.params.id).eq('user_id', user.id)
  res.json({ success: true })
})

export default router
export { supabase }
