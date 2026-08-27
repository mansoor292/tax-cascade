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
