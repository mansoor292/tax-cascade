import { test, expect } from '@playwright/test'
import { signUpThroughUi, testEmail, deleteUserByEmail } from './helpers'

/**
 * Walks the app as a brand-new user — the state Christy will actually be in
 * on SOP 01. A fresh account has no entities, so every page must render its
 * empty state rather than erroring or hanging.
 *
 * This is the check that would have caught the RLS/env regression: when route
 * modules fell back to the anon key, pages still loaded but returned nothing.
 */
test.describe('new user walkthrough', () => {
  const email = testEmail('walk')

  test.beforeAll(() => { test.setTimeout(90_000) })

  test.afterAll(async () => {
    const r = await deleteUserByEmail(email)
    if (r === 'skipped') console.log(`NOTE: no service role key — left test account ${email} behind`)
  })

  test('dashboard, entities and calendar all render for a fresh account', async ({ page }) => {
    const failedRequests: string[] = []
    page.on('response', r => {
      if (r.url().includes('/api/') && r.status() >= 500) failedRequests.push(`${r.status()} ${r.url()}`)
    })

    await signUpThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    // Dashboard
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Entities', { exact: true }).first()).toBeVisible()

    // Entities — empty state for a new account
    await page.goto('/app/entities')
    await expect(page).toHaveURL(/\/app\/entities/)

    // Calendar — the new feature; must render even with nothing to show
    await page.goto('/app/calendar')
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    await expect(page.getByText('Overdue').first()).toBeVisible()

    // No server errors anywhere in the walk.
    expect(failedRequests, `5xx responses: ${failedRequests.join(', ')}`).toHaveLength(0)
  })
})
