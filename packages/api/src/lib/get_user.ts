/**
 * Get user ID from request — supports both Bearer token and API key auth
 */
import { createClient } from '@supabase/supabase-js'
import type { Request } from 'express'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'

export async function getUserId(req: Request): Promise<string | null> {
  // 1. Check if middleware already set userId (from API key)
  if ((req as any).userId) return (req as any).userId

  // 2. Try Bearer token
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })
    const { data: { user } } = await client.auth.getUser()
    if (user) return user.id
  }

  return null
}

export function userClient(req: Request) {
  const token = req.headers.authorization?.replace('Bearer ', '') || ''
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  })
}
