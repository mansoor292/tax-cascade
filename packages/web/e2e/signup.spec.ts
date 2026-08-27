import { test, expect } from '@playwright/test'
import { signUpThroughUi, testEmail, deleteUserByEmail } from './helpers'

/**
 * Regression test for the SOP 01 signup blocker.
 *
 * Reported: creating an account returned "Database error saving new user",
 * with both a work address and a personal Gmail. Cause was two triggers left
 * on auth.users by the April coach-table teardown, still referencing the
 * dropped public.coaches and public.user_roles.
 *
 * This test must FAIL if those triggers ever come back.
 */
test.describe('signup', () => {
  const email = testEmail('signup')

  test.afterAll(async () => {
    const r = await deleteUserByEmail(email)
    if (r === 'skipped') console.log(`NOTE: no service role key — left test account ${email} behind`)
  })

  test('a new person can create an account', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })

    await signUpThroughUi(page, email)

    // The reported symptom, asserted directly: the form renders the auth
    // error inline, so if it comes back this is what the user sees.
    await expect(page.getByText('Database error saving new user')).toHaveCount(0)

    // Any inline auth error at all means signup did not succeed.
    await expect(page.locator('p.text-red-400')).toHaveCount(0)

    // Success leaves /login for the app shell.
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    expect(consoleErrors.join('\n')).not.toContain('Database error')
  })
})
