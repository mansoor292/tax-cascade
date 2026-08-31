import { test, expect } from '@playwright/test'
import { signUpThroughUi, signInViaApi, testEmail, deleteUserByEmail, TEST_PASSWORD, authed } from './helpers'

/**
 * The complete path a new person walks on SOP 01 — in ONE session, in order,
 * the way a human actually does it.
 *
 * Both blockers Christy hit had the same shape: something removed or missed
 * in an earlier change, on a path nobody had exercised since. Signup and
 * API-key creation are steps one and two for a NEW user, and every existing
 * user was already past them, so nothing else in the system touched that
 * ground. This test is the thing that walks it.
 *
 * The per-feature specs each sign up and check one thing. This checks that
 * the steps still connect to each other end to end, which is where the gaps
 * actually were.
 */
test.describe('full new-user journey', () => {
  const email = testEmail('journey')
  const ENTITY = 'E2E Test Corp'

  test.describe.configure({ mode: 'serial', timeout: 120_000 })

  test.afterAll(async () => {
    const r = await deleteUserByEmail(email)
    if (r === 'skipped') console.log(`NOTE: no service role key — left test account ${email} behind`)
  })

  test('signup → API key → connector → entity → calendar, in one session', async ({ page }) => {
    const serverErrors: string[] = []
    page.on('response', r => {
      const u = r.url()
      if ((u.includes('/api/') || u.includes('/auth/')) && r.status() >= 500) {
        serverErrors.push(`${r.status()} ${r.request().method()} ${u}`)
      }
      // A backend path answered with HTML is the /auth/* proxy bug's signature:
      // it looks like success and returns the wrong thing entirely.
      if (u.includes('/auth/') && (r.headers()['content-type'] || '').includes('text/html')) {
        serverErrors.push(`HTML from ${u} — request never reached the API`)
      }
    })

    // ── 1. Create the account ────────────────────────────────────────────
    await signUpThroughUi(page, email, 'Journey Test User')
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    // ── 2. Mint an API key (the connector step depends on this) ──────────
    await page.goto('/app/settings')
    await page.getByRole('button', { name: 'Create Key' }).first().click()
    await page.getByPlaceholder('e.g. Development, Claude MCP').fill('Claude Cowork')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByRole('textbox')).toHaveValue(/^txk_/)
    await page.getByRole('button', { name: 'Done' }).click()

    // The key must persist and be listed — created-but-not-saved would look
    // identical in the dialog above.
    await page.reload()
    await expect(page.getByText('Claude Cowork')).toBeVisible({ timeout: 20_000 })

    // ── 3. The connector page renders its instructions ───────────────────
    await page.goto('/app/connect-claude')
    await expect(page.getByRole('heading', { name: 'Connect Claude' })).toBeVisible()
    await expect(page.getByText('fin.catipult.ai/mcp').first()).toBeVisible()

    // ── 4. Create the first entity ───────────────────────────────────────
    await page.goto('/app/entities')
    await expect(page.getByText('No entities yet')).toBeVisible()
    await page.getByRole('button', { name: /Create Entity|New Entity|Create/ }).first().click()
    await page.getByPlaceholder('e.g. John Smith or Acme Corp').fill(ENTITY)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByText(ENTITY).first()).toBeVisible({ timeout: 20_000 })

    // ── 5. The calendar builds itself from that entity ───────────────────
    // Nothing was typed in. If the generator or its persistence breaks, this
    // page stays empty and the deadline feature is silently dead.
    await page.goto('/app/calendar')
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    await expect(page.getByText(/return due|estimated tax payment|annual report/i).first())
      .toBeVisible({ timeout: 30_000 })

    // ── 6. The dashboard reflects the new state ──────────────────────────
    await page.goto('/app')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText(ENTITY).first()).toBeVisible()

    expect(serverErrors, `backend problems during the journey: ${serverErrors.join(' | ')}`).toHaveLength(0)
  })

  test('the account survives a sign-out and sign-in', async ({ page }) => {
    // A new user closes the tab and comes back. Their entity and key must
    // still be there — this is what proves the data actually persisted
    // against RLS rather than living in a session.
    await page.goto('/login')
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Sign In' }).last().click()

    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto('/app/entities')
    await expect(page.getByText(ENTITY).first()).toBeVisible({ timeout: 20_000 })

    await page.goto('/app/settings')
    await expect(page.getByText('Claude Cowork')).toBeVisible({ timeout: 20_000 })
  })

  test('a computed return shows up on the entity, in the browser', async ({ page, request, baseURL }) => {
    // The journey so far stops at "entity exists". The product's point is
    // computing a return and SEEING it — so compute one through the API (the
    // same call the Compute page makes) and verify the entity detail screen
    // actually renders it.
    const token = await signInViaApi(email)
    const list = await request.get(`${baseURL}/api/entities`, { headers: authed(token) })
    const entity = (await list.json()).entities.find((e: any) => e.name === ENTITY)
    expect(entity, 'the entity from the journey must be listed').toBeTruthy()

    const computed = await request.post(`${baseURL}/api/returns/compute`, {
      headers: authed(token),
      data: {
        entity_id: entity.id, tax_year: 2025, form_type: entity.form_type || '1040',
        inputs: entity.form_type === '1120S'
          ? { gross_receipts: 500_000, salaries_wages: 100_000, shareholders: [{ name: 'Owner', pct: 100 }] }
          : { filing_status: 'single', wages: 90_000 },
      },
    })
    expect(computed.status(), await computed.text()).toBe(200)

    await page.goto('/login')
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Sign In' }).last().click()
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    await page.goto(`/app/entities/${entity.id}`)
    await expect(page.getByText(ENTITY).first()).toBeVisible({ timeout: 20_000 })
    // The Returns tab is the default; the freshly computed 2025 return must
    // be visible, not an empty state.
    await expect(page.getByText(/2025/).first(), 'the computed return must render').toBeVisible({ timeout: 20_000 })
  })
})
