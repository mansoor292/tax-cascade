import type { Page } from '@playwright/test'

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/** Unique address per run so tests never collide on an existing account. */
export function testEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`
}

export const TEST_PASSWORD = 'TestPassw0rd!x9'

/**
 * Create an account through the actual UI — the exact path a new person takes,
 * which is what the "Database error saving new user" report was about.
 * Returns once the app has taken over from the login screen.
 */
export async function signUpThroughUi(page: Page, email: string, name = 'E2E Test User') {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign Up' }).click()
  await page.getByPlaceholder('Full Name').fill(name)
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Create Account' }).click()
}

/**
 * Remove an account created by a test. Needs the service role key; without it
 * the account is left behind and the caller is told, rather than failing the
 * run for a cleanup concern.
 */
export async function deleteUserByEmail(email: string): Promise<'deleted' | 'skipped' | 'not-found'> {
  if (!SERVICE) return 'skipped'
  const auth = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }

  const list = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, { headers: auth },
  )
  const body: any = await list.json().catch(() => ({}))
  const user = (body?.users || []).find((u: any) => u.email === email)
  if (!user) return 'not-found'

  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: auth })
  return 'deleted'
}

/**
 * Sign up via the API and mint an API key, without driving a browser.
 * Used by the MCP tests, where the subject is the protocol rather than the UI.
 */
export async function createUserWithApiKey(email: string): Promise<{ apiKey: string }> {
  const ANON = process.env.VITE_SUPABASE_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
  const base = process.env.BASE_URL || 'https://fin.catipult.ai'

  const signup = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  })
  const session: any = await signup.json()
  if (!session?.access_token) throw new Error(`signup failed: ${JSON.stringify(session).slice(0, 200)}`)

  const keyRes = await fetch(`${base}/auth/api-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'e2e mcp probe' }),
  })
  const key: any = await keyRes.json()
  if (!key?.api_key?.key_value) throw new Error(`key creation failed: ${JSON.stringify(key).slice(0, 200)}`)
  return { apiKey: key.api_key.key_value }
}
