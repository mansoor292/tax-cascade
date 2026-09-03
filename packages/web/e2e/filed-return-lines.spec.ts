import { test, expect } from '@playwright/test'
import {
  testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi,
  createEntityViaApi, seedFiledReturn, HAS_SERVICE_KEY, authed,
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

  test('the PDF button actually delivers a PDF, not just a toast', async ({ page }) => {
    // SOP-03: "Cati displayed a message indicating that the PDF had been
    // generated, but no PDF downloaded". Cause: the API returns {url}, the
    // hook read {pdf_url} — every URL was dropped.
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)
    await page.getByRole('cell', { name: /2023/ }).first().click()

    // The popup EVENT is the regression signal: with the bug, window.open was
    // never called (the URL arrived under `url` and the code read `pdf_url`),
    // so no popup exists. Asserting the popup's final URL is flaky in
    // headless Chromium (a PDF navigation can convert to a download), so we
    // assert the API handed back a real URL and that the app opened a tab.
    const respP = page.waitForResponse(r => r.url().includes('/pdf'), { timeout: 30_000 })
    const popupP = page.waitForEvent('popup', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Generate / download PDF' }).first().click()
    const body = await (await respP).json()
    expect(body.url, 'the PDF endpoint must return a presigned url').toMatch(/^https?:\/\//)
    await popupP
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

test.describe('year-over-year refund card sums only amended years', () => {
  test.skip(!HAS_SERVICE_KEY, 'needs SUPABASE_SERVICE_ROLE_KEY to seed filed_import rows')

  // Christy's exact numbers: three filed years, ONE amendment. The card once
  // summed all three filed years ($134,909) against the lone amendment and
  // presented +$79,645 as a "potential refund" — a comparison of three years
  // of filed tax against one year's amendment.
  const email = testEmail('yoycard')
  let entityId = ''

  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'YoY Person', form_type: '1040' })).id
    const filed2023 = await seedFiledReturn(entityId, {
      tax_year: 2023, form_type: '1040',
      field_values: { 'tax.L24_total_tax': 55264, 'income.L11_agi': 250110 },
    })
    await seedFiledReturn(entityId, {
      tax_year: 2022, form_type: '1040',
      field_values: { 'tax.L24_total_tax': 45664 },
    })
    await seedFiledReturn(entityId, {
      tax_year: 2024, form_type: '1040',
      field_values: { 'tax.L24_total_tax': 33981 },
    })
    // Amend ONLY 2023.
    const base = process.env.BASE_URL || 'https://fin.catipult.ai'
    const res = await fetch(`${base}/api/returns/compute`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: entityId, tax_year: 2023, form_type: '1040',
        amend_of: filed2023, inputs: { tax_year: 2023 },
      }),
    })
    if (!res.ok) throw new Error(`amendment compute failed: ${await res.text()}`)
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('filed total covers only years that have an amendment', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/compare/${entityId}`)

    const card = page.getByText('Filed vs Amended tax summary').locator('..').locator('..')
    await expect(card).toBeVisible({ timeout: 20_000 })
    // The amended year's filed tax — yes; the three-year sum — never.
    await expect(card.getByText('$55,264').first()).toBeVisible()
    await expect(page.getByText('$134,909')).toHaveCount(0)
    await expect(page.getByText('$79,645')).toHaveCount(0)
  })
})

test.describe('Δ refund with an amendment that does not restate the refund', () => {
  test.skip(!HAS_SERVICE_KEY, 'needs SUPABASE_SERVICE_ROLE_KEY to seed returns')

  // SOP-03 (Christy, 2026-09-03): a year row showed Δ refund = −$15,202 with
  // Δ tax ±$0. Her filed 1040 carried result.L34_overpayment = 15202; the
  // imported 1040-X restated the tax but — as 1040-Xs do — not the refund
  // line, and the missing key was read as $0. Absent must render as —.
  const email = testEmail('drefund')
  let entityId = ''

  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'Refund Delta Person', form_type: '1040' })).id
    const filedId = await seedFiledReturn(entityId, {
      tax_year: 2023, form_type: '1040',
      field_values: {
        'tax.L24_total_tax': 55264,
        'result.L34_overpayment': 15202,
        'refund.L35a_refunded': 15202,
      },
    })
    // The 1040-X: same total tax, NO overpayment key — the refund is simply
    // not restated.
    await seedFiledReturn(entityId, {
      tax_year: 2023, form_type: '1040',
      source: 'amendment', supersedes_id: filedId,
      field_values: { 'tax.L24_total_tax': 55264 },
    })
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('an unrestated refund shows as —, never as a delta to zero', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/compare/${entityId}`)

    await expect(page.getByText('Filed vs Amendment by year')).toBeVisible({ timeout: 20_000 })
    const table = page.getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: 'Δ refund' }) })
    const yearRow = table.getByRole('row').filter({ hasText: '2023' }).first()
    await expect(yearRow).toBeVisible()
    // Same tax both sides → Δ tax ±$0…
    await expect(yearRow.getByText('±$0')).toBeVisible()
    // …and the unrestated refund must NOT present as a −$15,202 change.
    await expect(page.getByText('-$15,202')).toHaveCount(0)
    await expect(yearRow.getByText('—').first()).toBeVisible()
  })
})
