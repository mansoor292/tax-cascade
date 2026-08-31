import { test, expect } from '@playwright/test'
import {
  testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi, authed, createEntityViaApi,
} from './helpers'

/**
 * Entity create/update, pinning the August 2026 bug class:
 *
 *  - ff88b3f: the PUT response reported ein as null on any edit that did not
 *    touch it (the stored value was fine; a client trusting the response
 *    concluded the identifier was cleared) — and handed the ciphertext blob
 *    back alongside.
 *  - 7fa68d5: the edit dialog re-exposed the full EIN on screen every time
 *    it opened.
 *
 * Split API/UI on purpose: the response contract is asserted at the API
 * level, the no-re-exposure rule at the screen level.
 */

test.describe('entity update — API response contract', () => {
  const email = testEmail('entcrud')
  const EIN = '45-6789123'
  let token = ''
  let entityId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'Crud Corp', form_type: '1120S', ein: EIN, legal_form: 'llc',
    })).id
  })
  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  test('an update that does not touch the EIN still reports it, decrypted', async ({ request, baseURL }) => {
    const res = await request.put(`${baseURL}/api/entities/${entityId}`, {
      headers: authed(token),
      data: { address: '1 Main St', legal_form: 'corporation' },
    })
    expect(res.status(), await res.text()).toBe(200)
    const e = (await res.json()).entity
    expect(e.ein, 'the ff88b3f regression: untouched EIN must not read as cleared').toBe(EIN)
    expect(e.legal_form).toBe('corporation')
    // No ciphertext in the response — the client has no key to use it and
    // its presence is how blobs end up echoed back on later writes.
    for (const k of Object.keys(e)) expect(k, 'no _enc columns in responses').not.toMatch(/_enc$/)
  })

  test('a later GET still decrypts (the update must not corrupt the row)', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) })
    expect(res.status()).toBe(200)
    expect((await res.json()).entity.ein).toBe(EIN)
  })
})

test.describe('entity edit — the screen never re-exposes the EIN', () => {
  const email = testEmail('entui')
  const EIN = '56-7891234'
  let entityId = ''

  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'Mask Corp', form_type: '1120S', ein: EIN,
    })).id
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('detail page masks; the edit dialog opens with an EMPTY EIN field', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)
    await expect(page.getByText('Mask Corp').first()).toBeVisible({ timeout: 20_000 })

    // On the page: masked only, full value nowhere in the DOM.
    const html = await page.content()
    expect(html, 'the full EIN must never reach the DOM').not.toContain(EIN)

    // In the edit dialog: the field starts empty (placeholder carries the
    // masked hint), so reopening the form cannot re-display the identifier.
    await page.getByRole('button', { name: /edit/i }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Edit Entity' })).toBeVisible()
    const einInput = dialog.getByPlaceholder(/Saved: /)
    await expect(einInput).toHaveValue('')
    expect(await page.content(), 'opening Edit must not re-expose the EIN').not.toContain(EIN)
  })
})
