import { test, expect } from '@playwright/test'
import {
  testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi,
  createEntityViaApi, seedFiledReturn, HAS_SERVICE_KEY,
} from './helpers'

/**
 * SOP-03 findings (Christy, 2026-09-02), pinned:
 *
 *  1. A filed return had NO line-level view — the only canonical-line
 *     renderer (LineByLineMatrix) required a filed+amendment pair, so the
 *     SOP's "compare the filed return against the PDF line by line" was
 *     impossible from the Returns tab.
 *  2. "Create" made an amendment on one click, no confirmation — and the
 *     year row then presented the blank amendment as a real tax change
 *     (Filed $33,981 → Amended $0 → Δ −$33,981).
 *
 * The filed row is seeded via service role (real ingest is Textract+Gemini,
 * slow and non-deterministic; the subject here is the Returns UI).
 */

test.describe('filed return — line-level view and amendment guardrails', () => {
  test.skip(!HAS_SERVICE_KEY, 'needs SUPABASE_SERVICE_ROLE_KEY to seed a filed_import row')

  const email = testEmail('filedlines')
  let entityId = ''

  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'Lines Person', form_type: '1040' })).id
    await seedFiledReturn(entityId, {
      tax_year: 2023,
      form_type: '1040',
      field_values: {
        'income.L11_agi': 250110,
        'tax.L15_taxable_income': 236260,
        'tax.L16_income_tax': 54586,
        'tax.L24_total_tax': 55264,
      },
      verification: {
        gemini_gap_fill: {
          gaps_total: 2, gaps_filled: 1, gaps_rejected: 1,
          filled_keys: ['tax.L16_income_tax'],
          model: 'e2e-fixture',
        },
      },
    })
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('a filed return exposes every canonical line, with AI-assisted provenance badges', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)

    // Expand the 2023 year row, then open the line view on the filed return.
    await page.getByRole('cell', { name: /2023/ }).first().click()
    await page.getByRole('button', { name: 'View lines' }).click()

    const detail = page.getByTestId('line-detail')
    await expect(detail).toBeVisible()
    // Canonical lines beyond the 8 summary metrics are visible…
    await expect(detail.getByText('L15 taxable income')).toBeVisible()
    await expect(detail.getByText('$236,260')).toBeVisible()
    await expect(detail.getByText('$54,586')).toBeVisible()
    // …and a gap-filled line is visibly marked as AI-assisted.
    await expect(detail.getByText('AI-assisted')).toBeVisible()
    // The rejection count from grounding surfaces in the gap-fill footer.
    await expect(page.getByText(/1 rejected \(not present in document\)/)).toBeVisible()
  })

  test('Create amendment asks first; declining creates nothing', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)

    page.on('dialog', d => d.dismiss())
    await page.getByRole('button', { name: 'Create' }).click()
    // Nothing may be created on a declined confirm: the Create button stays,
    // no Amended badge appears.
    await page.waitForTimeout(1_500)
    await expect(page.getByRole('button', { name: 'Create' })).toBeVisible()
    await expect(page.getByText('Amended')).toHaveCount(0)
  })

  test('an accepted blank amendment reads as a draft, not a tax change', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)

    page.on('dialog', d => d.accept())
    await page.getByRole('button', { name: 'Create' }).click()

    // The blank amendment must not present as a change to $0…
    await expect(page.getByText('blank — not yet computed')).toBeVisible({ timeout: 20_000 })
    // …and the year row must not show a large negative delta.
    await expect(page.getByText('-$55,264')).toHaveCount(0)
  })
})
