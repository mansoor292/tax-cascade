import { test, expect } from '@playwright/test'
import { signUpThroughUi, testEmail, deleteUserByEmail } from './helpers'

/**
 * An error message has to outlive the glance that misses it.
 *
 * Reported from SOP 02: an upload failed, the error flashed up and was gone
 * before it could be read, and all that remained was a screen where nothing
 * had happened. The toast was the ONLY report of the failure, and it
 * dismissed itself after about four seconds.
 *
 * Errors and warnings now stay until dismissed; confirmations still fade.
 * This drives a real failure through the UI — the network call is forced to
 * fail, the way it would on a genuine outage — and then waits well past the
 * old timeout to prove the message is still on screen.
 */
test.describe('errors stay readable', () => {
  const email = testEmail('errvis')
  test.afterAll(() => deleteUserByEmail(email))

  test('a failed action leaves its error on screen, not a four-second flash', async ({ page }) => {
    test.setTimeout(120_000)
    await signUpThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    await page.goto('/app/entities')

    // Force the create to fail, exactly as a real outage would.
    await page.route('**/api/entities', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forced failure for error-visibility test' }),
        })
      }
      return route.fallback()
    })

    await page.getByRole('button', { name: /Create Entity|New Entity|Create/ }).first().click()
    await page.getByPlaceholder('e.g. John Smith or Acme Corp').fill('Error Visibility Probe')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    const toast = page.getByText(/Forced failure for error-visibility test/i)
    await expect(toast, 'the error must appear at all').toBeVisible({ timeout: 15_000 })

    // Sonner's old default was ~4s. Wait well past it.
    await page.waitForTimeout(9_000)
    await expect(
      toast,
      'the error vanished before it could be read — this is the reported symptom',
    ).toBeVisible()

    // And it must be dismissible, or it becomes clutter.
    const close = page.locator('[data-sonner-toast] button[data-close-button]').first()
    if (await close.count()) {
      await close.click()
      await expect(toast).toBeHidden({ timeout: 5_000 })
    }
  })
})
