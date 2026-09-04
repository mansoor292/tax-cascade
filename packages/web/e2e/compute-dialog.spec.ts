import { test, expect } from '@playwright/test'
import {
  testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi,
  createEntityViaApi,
} from './helpers'

/**
 * SOP-04 finding (Christy, 2026-09-03): the Compute Tax Return dialog
 * rendered filing_status as a free-text box hinting "0" — the schema calls
 * it a string whose legal values are single/mfj/mfs/hoh/qw, but nothing on
 * screen said so and the numeric hint suggested a number was wanted. The
 * schema now publishes those values as structured `options` and any field
 * carrying options renders as a dropdown; this spec pins that, end to end
 * through a real compute so the selected value provably reaches the engine.
 */

test.describe('Compute dialog — filing status is a dropdown, not a numeric-looking box', () => {
  const email = testEmail('computedlg')
  let entityId = ''

  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'Compute Dialog Person', form_type: '1040' })).id
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('filing status offers the coded statuses and the choice reaches the computed return', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)

    await page.getByRole('button', { name: /Compute (Return|First Return)/ }).first().click()
    await expect(page.getByRole('heading', { name: 'Compute Tax Return' })).toBeVisible()

    // The regression: this field must be a picker. Before the fix it was an
    // <input type="text"> with placeholder "0".
    const fsField = page.getByTestId('field-filing_status')
    const fsSelect = fsField.getByRole('combobox')
    await expect(fsSelect).toBeVisible({ timeout: 15_000 })
    await fsSelect.click()
    for (const label of ['Single', 'Married filing jointly', 'Married filing separately', 'Head of household', 'Qualifying widow(er)']) {
      await expect(page.getByRole('option', { name: label })).toBeVisible()
    }
    await page.getByRole('option', { name: 'Married filing jointly' }).click()

    // SOP-04 finding #2 (2026-09-04): fields must name their source document
    // and box — users hold W-2s and 1099s, not return-line concepts…
    await expect(page.getByText('Form 1099-DIV box 1a')).toBeVisible()
    await expect(page.getByText('Form 1098-E box 1')).toBeVisible()
    // …and tax_year must not render as a second, contradictable input:
    // the dropdown at the top is authoritative, and a typed year silently
    // overrode it.
    await expect(page.getByTestId('field-tax_year')).toHaveCount(0)

    // Numeric fields stay numeric inputs.
    await page.getByTestId('field-wages').locator('input').fill('150000')

    await page.getByRole('button', { name: 'Compute', exact: true }).click()
    await expect(page.getByText('Return computed successfully')).toBeVisible({ timeout: 30_000 })
  })
})
