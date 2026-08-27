import { test, expect } from '@playwright/test'
import { signUpThroughUi, testEmail, deleteUserByEmail } from './helpers'

/**
 * Regression test for the SOP 01 API-key blocker.
 *
 * Reported: Settings -> Create API Key with the name "Claude Cowork"
 * returned a bare 404 and no key was created, blocking connector setup.
 *
 * Cause was routing, not application code. The SPA calls /auth/api-keys, but
 * netlify.toml proxied only /api/* and /mcp — so /auth/* fell through to the
 * SPA fallback and a POST to a static file 404s. The same gap made
 * GET /auth/me return index.html with a 200, which is why the key list also
 * silently showed nothing.
 *
 * Creating a key is the step that unblocks the Claude connector, so this
 * covers the whole path a new person walks.
 */
test.describe('API keys', () => {
  const email = testEmail('apikey')

  test.afterAll(async () => {
    const r = await deleteUserByEmail(email)
    if (r === 'skipped') console.log(`NOTE: no service role key — left test account ${email} behind`)
  })

  test('a new user can create an API key from Settings', async ({ page }) => {
    const failed: string[] = []
    page.on('response', r => {
      if (r.url().includes('/auth/') && !r.ok()) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`)
    })

    await signUpThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    await page.goto('/app/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    await page.getByRole('button', { name: 'Create Key' }).first().click()
    await page.getByPlaceholder('e.g. Development, Claude MCP').fill('Claude Cowork')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    // The key is shown exactly once, on success. Its prefix is txk_.
    await expect(page.getByText(/txk_/)).toBeVisible({ timeout: 20_000 })

    // The reported symptom, asserted directly.
    await expect(page.getByText('404', { exact: true })).toHaveCount(0)
    expect(failed, `failed /auth/ requests: ${failed.join(', ')}`).toHaveLength(0)
  })

  test('the /auth API is reachable through the deployed site, not swallowed by the SPA', async ({ request, baseURL }) => {
    // Guards the routing gap directly, independent of any UI. Unauthenticated
    // POST must reach the API and be REJECTED (401) — a 404, or HTML with a
    // 200, means the request never left the static host.
    const res = await request.post(`${baseURL}/auth/api-keys`, { data: { name: 'routing probe' } })
    expect(res.status(), 'POST /auth/api-keys must reach the API, not the SPA fallback').toBe(401)

    const me = await request.get(`${baseURL}/auth/me`)
    expect(me.headers()['content-type'] || '').toContain('application/json')
  })
})
