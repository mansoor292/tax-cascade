/**
 * Auth routes — Supabase-backed user management + API key provisioning
 */
import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { v4 as uuidv4 } from 'uuid'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

const router = Router()

// Sign up
router.post('/signup', async (req, res) => {
  const { email, password, full_name, company_name } = req.body
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name, company_name } }
  })
  if (error) return res.status(400).json({ error: error.message })

  // Generate initial API key
  const apiKey = `txk_${uuidv4().replace(/-/g, '').slice(0, 24)}`
  if (data.user) {
    await supabase.from('api_key').insert({
      user_id: data.user.id, key_value: apiKey, name: 'Default'
    })
  }

  res.json({ user: data.user, api_key: apiKey, session: data.session })
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
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid token' })

  const { data: profile } = await supabase.from('user_profile').select('*').eq('id', user.id).single()
  const { data: keys } = await supabase.from('api_key').select('id, name, key_value, is_active, created_at').eq('user_id', user.id)

  res.json({ user, profile, api_keys: keys })
})

// Create new API key
router.post('/api-keys', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return res.status(401).json({ error: 'Invalid token' })

  const apiKey = `txk_${uuidv4().replace(/-/g, '').slice(0, 24)}`
  const { data, error } = await supabase.from('api_key').insert({
    user_id: user.id, key_value: apiKey, name: req.body.name || 'API Key'
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ api_key: data })
})

// Revoke API key
router.delete('/api-keys/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return res.status(401).json({ error: 'Invalid token' })

  await supabase.from('api_key').update({ is_active: false }).eq('id', req.params.id).eq('user_id', user.id)
  res.json({ success: true })
})

export default router
export { supabase }
