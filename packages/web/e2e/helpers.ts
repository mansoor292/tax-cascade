import type { Page } from '@playwright/test'

function requireAnonKey(): string {
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!key) throw new Error('VITE_SUPABASE_ANON_KEY must be set to run the API-signup e2e helpers')
  return key
}

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
  // Without the service role key every run silently leaves its accounts behind.
  // That went unnoticed long enough to accumulate 52 of them in the production
  // auth table. `npm run test:e2e:clean` loads the key from SSM first.
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
  const ANON = requireAnonKey()
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

/**
 * Sign up via the API and return the access token. Used by the API-level
 * specs, where driving a browser adds nothing but time.
 */
export async function signUpViaApi(email: string): Promise<string> {
  const ANON = requireAnonKey()
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  })
  const session: any = await res.json()
  if (!session?.access_token) throw new Error(`signup failed: ${JSON.stringify(session).slice(0, 200)}`)
  return session.access_token
}

/**
 * Sign in an existing account through the UI.
 *
 * The mode toggle and the submit button are BOTH labelled "Sign In", so a
 * by-name lookup finds the tab and clicking it does nothing. Target the
 * form's submit button explicitly.
 */
export async function signInThroughUi(page: Page, email: string, password = TEST_PASSWORD) {
  await page.goto('/login')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(password)
  await page.locator('form button[type="submit"]').click()
}

/** Authorization headers for the API-context specs. */
export function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/**
 * Sign IN an existing account via the API (signUpViaApi's counterpart) —
 * for tests that created the account through the UI but need a token to
 * arrange state without driving more screens.
 */
export async function signInViaApi(email: string, password = TEST_PASSWORD): Promise<string> {
  const ANON = requireAnonKey()
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const session: any = await res.json()
  if (!session?.access_token) throw new Error(`signin failed: ${JSON.stringify(session).slice(0, 200)}`)
  return session.access_token
}

/** Create an entity through the API; several specs need one as scaffolding. */
export async function createEntityViaApi(
  token: string,
  overrides: Record<string, any> = {},
): Promise<{ id: string; [k: string]: any }> {
  const base = process.env.BASE_URL || 'https://fin.catipult.ai'
  const res = await fetch(`${base}/api/entities`, {
    method: 'POST',
    headers: { ...authed(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'E2E Entity', form_type: '1040', ...overrides }),
  })
  const body: any = await res.json()
  if (!body?.entity?.id) throw new Error(`entity creation failed: ${JSON.stringify(body).slice(0, 200)}`)
  return body.entity
}

/**
 * Seed a filed_import tax_return row directly (service role). Filed imports
 * normally only exist via PDF ingest — Textract + Gemini, slow and
 * non-deterministic — so specs that need one as SCAFFOLDING (line-level view,
 * amendment flows) insert the row instead. Plaintext-only write: hydrate()
 * only overrides when an _enc twin exists, so reads serve these values as-is.
 * Requires SUPABASE_SERVICE_ROLE_KEY; callers should test.skip() without it.
 */
export async function seedFiledReturn(
  entityId: string,
  opts: {
    tax_year: number
    form_type: string
    field_values: Record<string, number>
    verification?: Record<string, any>
  },
): Promise<string> {
  if (!SERVICE) throw new Error('seedFiledReturn needs SUPABASE_SERVICE_ROLE_KEY')
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tax_return`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      entity_id: entityId,
      tax_year: opts.tax_year,
      form_type: opts.form_type,
      source: 'filed_import',
      status: 'filed',
      field_values: opts.field_values,
      computed_data: { computed: {} },
      input_data: {},
      verification: opts.verification ?? {},
      // A filed import represents a return a human already reviewed and
      // filed; without this the PDF route's completeness gate can 400.
      reviewed_at: new Date().toISOString(),
    }),
  })
  const body: any = await res.json().catch(() => null)
  if (!res.ok || !body?.[0]?.id) {
    throw new Error(`seedFiledReturn failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body[0].id
}

export const HAS_SERVICE_KEY = Boolean(SERVICE)

/**
 * Poll a document until background extraction settles. The ingest contract
 * is 202 + processing_status, so any test that needs the extracted result
 * has to wait for the row, not the response.
 */
export async function pollDocumentUntilDone(
  token: string, docId: string, timeoutMs = 240_000,
): Promise<any> {
  const base = process.env.BASE_URL || 'https://fin.catipult.ai'
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${base}/api/documents/${docId}`, { headers: authed(token) })
    const doc: any = ((await res.json().catch(() => null)) as any)?.document ?? null
    if (doc?.processing_status === 'done') return doc
    if (doc?.processing_status === 'failed') {
      throw new Error(`extraction failed: ${doc.processing_error || '(no detail)'}`)
    }
    if (Date.now() > deadline) throw new Error(`document ${docId} still processing after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 5_000))
  }
}
