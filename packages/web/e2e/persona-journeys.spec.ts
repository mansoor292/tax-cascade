import { test, expect, type Page } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi, signInViaApi, authed } from './helpers'

/**
 * The UI audit of 2026-10-22: each persona's journeys from docs/USER_PERSONAS.md
 * walked by clicking only, and every misdirect it fixed pinned here, named for
 * its journey.
 *
 * Most run on the demo account — the Talbrook group, a fictional copy of the
 * owner's four entities with the same shape (filed years, an S-corp, the
 * misposted IRS transcripts), built for exactly this (login in SSM
 * /tax-api/DEMO_ACCOUNT_*; `npm run test:e2e:clean` loads it). They read,
 * except the amendment journey, which creates its own amendment and deletes
 * it. The day-one journeys need an empty account and make their own.
 *
 * Each test starts where its persona starts and reaches the fix by clicking.
 * Only the deep-link test opens a page by address, because the link is its
 * subject.
 */

const DEMO_EMAIL = process.env.DEMO_ACCOUNT_EMAIL || ''
const DEMO_PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD || ''

async function signInDemo(page: Page) {
  test.skip(!DEMO_EMAIL || !DEMO_PASSWORD, 'DEMO_ACCOUNT_EMAIL / DEMO_ACCOUNT_PASSWORD not set')
  await signInThroughUi(page, DEMO_EMAIL, DEMO_PASSWORD)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 20_000 })
}

const sidebar = (page: Page) => page.locator('[data-sidebar="sidebar"]')

test.describe('P1 business owner — demo account', () => {
  test.describe.configure({ timeout: 90_000 })

  test('P1-J1 Dashboard: the next deadline is a date still ahead, and the Calendar agrees', async ({ page }) => {
    await signInDemo(page)
    // Read "Next deadline −311d": the oldest unconfirmed estimated payment.
    const card = page.getByText('Next deadline', { exact: true }).locator('xpath=ancestor::div[contains(@class,"min-w-0")][1]')
    await expect(card).toContainText(/\d+d|Today/)
    await expect(card).not.toContainText(/-\d+d/)

    await card.click()
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    // "Next up" read "311 days overdue" beside an Overdue card reading 0.
    const nextUp = page.getByText('Next up', { exact: true }).locator('..')
    await expect(nextUp).toContainText(/in \d+ days?|Due today/)
    await expect(nextUp).not.toContainText('overdue')
  })

  test('P1-J1 Calendar: a return filed in the catalog is filed, not overdue', async ({ page }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: 'Calendar' }).click()
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    // The three 2025 returns filed 10/14 are catalogued (Compare shows each PDF)
    // but have no filed_import row; all three read "overdue / needs confirming".
    for (const title of ['1120-S return due (extended) — 2025', '1040 return due (extended) — 2025']) {
      await expect(page.getByText(title, { exact: true })).toHaveCount(0)
    }
    // Talbrook AI has no 2025 return on file: it must still be outstanding.
    await expect(page.getByText('Talbrook AI, Inc · Oct 15, 2026', { exact: false })).toBeVisible()
    await page.getByText(/Show filed and not-applicable/).click()
    await expect(page.getByText('1120-S return due (extended) — 2025', { exact: true })).toBeVisible()
  })

  test('P1-J1 Entity → year: the S-corp card shows its ordinary income', async ({ page }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: /Talbrook Investments Inc/ }).click()
    await page.getByRole('cell', { name: '2025', exact: true }).click()
    // The 1120-S metric keys were the 1120's line numbers: every S-corp card
    // read "—" for total deductions, ordinary income and tax.
    for (const label of ['Ordinary income/loss', 'Total deductions']) {
      await expect(page.getByText(label, { exact: true }).first().locator('..')).toContainText(/\$[\d,]+/)
    }
  })

  test('P1-J4 Entity → year → PDF: the file is named for the return', async ({ page }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: /Talbrook Investments Inc/ }).click()
    await page.getByRole('cell', { name: '2025', exact: true }).click()
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByTitle('Generate / download PDF').first().click(),
    ])
    expect(download.suggestedFilename()).toBe('Talbrook_Investments_Inc_2025_1120S_draft.pdf')
  })

  test('P1-J3 Group → a break → the year it is about, every source side by side', async ({ page }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: 'Group' }).click()
    await page.getByRole('tab', { name: 'Breaks' }).click()
    // A break explained itself and led nowhere.
    await page.getByRole('button', { name: /deducted [\d,]+ for Talbrook Ventures Inc's fees/ }).click()
    await page.getByRole('link', { name: 'Open 2023, every source side by side' }).click()
    await expect(page).toHaveURL(/\/app\/compare\/[0-9a-f-]+\?view=sources&year=2023/)
    await expect(page.getByText('Sources for 2023')).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('P1 business owner — filed, accepted, amended (2026-10-22 decisions)', () => {
  test.describe.configure({ timeout: 120_000 })

  test('P1-J1 a filed PDF is filed; accepted only once the IRS transcript shows it', async ({ page }) => {
    await signInDemo(page)
    // "Filed returns" counts filed entity-years and says how many the IRS accepted.
    await expect(page.getByText(/\d+ accepted by the IRS/).first()).toBeVisible()
    await sidebar(page).getByRole('link', { name: /Talbrook Investments Inc/ }).click()
    // 2025 is filed only as a catalogued PDF: it read Filed "—".
    const row2025 = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '2025', exact: true }) })
    await expect(row2025).toContainText('Filed')
    // The IRS posted the 2024 return in the 2025 period: not accepted.
    await expect(row2025).toContainText('Misposted')
    const row2023 = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '2023', exact: true }) })
    await expect(row2023).toContainText('Accepted')
    await page.getByRole('cell', { name: '2024', exact: true }).click()
    await expect(page.getByTestId('filing-status')).toContainText('The IRS processed the 2023 return in the 2024 period')
  })

  test('P1-J3 open items do not ask for returns not yet due or before the records', async ({ page }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: 'Group' }).click()
    await page.getByRole('tab', { name: 'Open items' }).click()
    await expect(page.getByText(/\d+ open items?/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('No filed 2026 return is catalogued')).toHaveCount(0)
    await expect(page.getByText(/No filed 201[6-8] return is catalogued/)).toHaveCount(0)
    // A return past due with nothing on file is still asked for.
    await expect(page.getByText('No filed 2025 return is catalogued').first()).toBeVisible()
    // Before the records, a return the IRS shows processed asks only for its copy, at low priority.
    await expect(page.getByText(/The IRS has a 201[6-8] return; no copy is on file here/).first()).toBeVisible()
  })

  test('P1-J5 an amendment starts from the filed return; its lines can be changed; books shown beside it', async ({ page, baseURL }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: /Talbrook Investments Inc/ }).click()
    const entityId = page.url().match(/entities\/([0-9a-f-]{36})/)![1]
    try {
      await amendmentJourney(page)
    } finally {
      // A failed run must not leave an amendment on the demo account.
      const token = await signInViaApi(DEMO_EMAIL, DEMO_PASSWORD)
      type Row = { id: string; entity_id: string; source: string; tax_year: number }
      const list = await (await fetch(`${baseURL}/api/returns`, { headers: authed(token) })).json() as { returns?: Row[] }
      for (const r of (list.returns ?? []).filter(x => x.entity_id === entityId && x.source === 'amendment' && x.tax_year === 2024)) {
        await fetch(`${baseURL}/api/returns/${r.id}`, { method: 'DELETE', headers: authed(token) })
      }
    }
  })

  async function amendmentJourney(page: Page) {
    const row2024 = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '2024', exact: true }) })
    page.once('dialog', d => d.accept())
    await row2024.getByRole('button', { name: 'Create' }).click()
    // It started blank: every computed line $0 against the filed return.
    await expect(page.getByText(/2024 amendment started from the filed 2024 return/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Started from the filed 2024 return.', { exact: true })).toBeVisible()
    await expect(page.getByTestId('books-agreement')).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Edit lines' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: "Edit the 2024 amendment's lines" })).toBeVisible()
    const receipts = dialog.getByTestId('field-gross_receipts').getByRole('spinbutton')
    await expect(receipts).not.toHaveValue('')
    await expect(receipts).not.toHaveValue('0')
    await dialog.getByTestId('field-officer_compensation').getByRole('spinbutton').fill('61000')
    await dialog.getByRole('button', { name: 'Save and recompute' }).click()
    await expect(page.getByText('Amendment recomputed with your changes')).toBeVisible({ timeout: 60_000 })

    // Compare vs filed: the readable side-by-side view, filed as base, books beside it.
    await page.getByRole('button', { name: 'Compare vs filed' }).click()
    await expect(page).toHaveURL(/view=sources&year=2024&base=filed&with=ret%3A[0-9a-f]{8}%2Cbooks/)
    await expect(page.getByText('Sources for 2024')).toBeVisible({ timeout: 30_000 })

    // Delete it by clicking, as a person would; the finally above is the net.
    await page.goBack()
    await page.getByRole('cell', { name: '2024', exact: true }).click()
    page.once('dialog', d => d.accept())
    await page.getByTitle('Delete').first().click()
    await expect(row2024.getByRole('button', { name: 'Create' })).toBeVisible({ timeout: 30_000 })
  }

  test('P1-J5 a scenario defaults to the best base: the filed return', async ({ page }) => {
    await signInDemo(page)
    await sidebar(page).getByRole('link', { name: /Talbrook Investments Inc/ }).click()
    await page.getByRole('tab', { name: /Scenarios/ }).click()
    await page.getByRole('button', { name: 'New Scenario' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox').first().click()
    await page.getByRole('option', { name: '2024', exact: true }).click()
    // It defaulted to no base at all.
    await expect(dialog.getByRole('combobox').nth(1)).toContainText('2024 · Filed')
    // 2025 is filed only as a catalogued PDF: it fell back to the draft.
    await dialog.getByRole('combobox').first().click()
    await page.getByRole('option', { name: '2025', exact: true }).click()
    await expect(dialog.getByRole('combobox').nth(1)).toContainText('2025 · Filed (PDF)')
  })
})

test('P4-J1 a link opened signed out comes back to itself after sign-in', async ({ page }) => {
  test.skip(!DEMO_EMAIL || !DEMO_PASSWORD, 'DEMO_ACCOUNT_EMAIL / DEMO_ACCOUNT_PASSWORD not set')
  // It went to the landing page, and after sign-in to the Dashboard.
  await page.goto('/app/group?tab=breaks')
  await expect(page).toHaveURL(/\/login\?next=/)
  await page.getByPlaceholder('Email').fill(DEMO_EMAIL)
  await page.getByPlaceholder('Password').fill(DEMO_PASSWORD)
  await page.locator('form button[type="submit"]').click()
  await expect(page).toHaveURL(/\/app\/group\?tab=breaks/, { timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Group' })).toBeVisible()
})

test.describe('P3 business owner on day one — a new account', () => {
  const email = testEmail('dayone')
  test.describe.configure({ mode: 'serial', timeout: 90_000 })
  test.beforeAll(async () => { await signUpViaApi(email) })
  test.afterAll(async () => { await deleteUserByEmail(email) })

  test('P3-J1 empty Dashboard says what to do → first entity → upload its papers', async ({ page }) => {
    await signInThroughUi(page, email)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 20_000 })
    // The main area was blank cards; the only pointer a small sidebar link.
    await page.getByRole('button', { name: 'Add your first entity' }).click()

    const dialog = page.getByRole('dialog')
    // Base UI printed the raw values: "1040" and the sentinel "__none__".
    await expect(dialog).toContainText('Individual (1040)')
    await expect(dialog).toContainText('Not specified')
    await expect(dialog).not.toContainText('__none__')
    await page.getByPlaceholder('e.g. John Smith or Acme Corp').fill('Day One Person')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()

    // The sidebar kept "Create your first entity" and never listed the new one.
    await expect(sidebar(page).getByText('Day One Person')).toBeVisible()
    await expect(sidebar(page).getByText('Create your first entity')).toHaveCount(0)

    // The empty Returns tab offered only "Compute First Return" (40 blank inputs).
    await page.getByRole('button', { name: 'Upload documents' }).click()
    await expect(page.getByText(/Drag & drop tax documents/)).toBeVisible()
    await expect(page).toHaveURL(/tab=documents/)
  })

  test('P2-J3 Compute Return opens on the year being prepared', async ({ page }) => {
    await signInThroughUi(page, email)
    await sidebar(page).getByText('Day One Person').click()
    await page.getByRole('button', { name: 'Compute Return' }).click()
    // Hardcoded to 2024 in seven pickers.
    const want = String(Math.min(new Date().getFullYear() - 1, 2025))
    await expect(page.getByRole('dialog').getByRole('combobox').nth(1)).toHaveText(new RegExp(`^${want}`))
  })
})
