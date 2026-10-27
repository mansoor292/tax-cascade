import { test, expect, type Page } from '@playwright/test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signInThroughUi } from './helpers'

/**
 * An imported book (2026-10-26): a practice whose clients come from a
 * transaction export, known only by number, never read from the IRS. Built for
 * Kenneth's export of his book; that file is third parties' IRS data and never
 * enters the repo — these journeys upload a fictional book written as an
 * export (fixtures/fictional_export_v*.csv, kept equal to the API's
 * fixtureExportCsv by a drift test in api/src/taxnow/export.test.ts).
 *
 * Runs on the fictional imported book (login in SSM
 * /tax-api/PRACTICE_IMPORT_DEMO_*; packages/api/scripts/practice/
 * seed_import_demo.ts empties it). In order, because each journey starts where
 * the last one left the book: import → read the evidence and judge it → a
 * newer export → re-run the analysis. Each one is repeatable on the book the
 * previous run left behind.
 *
 * IJ1, IJ3 and IJ4 run through the background jobs, which every deployed
 * worker shares: they prove the queue only against a deploy that knows the
 * import jobs. IJ2 runs anywhere the book holds the first export.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const EMAIL = process.env.PRACTICE_IMPORT_DEMO_EMAIL || ''
const PASSWORD = process.env.PRACTICE_IMPORT_DEMO_PASSWORD || ''
const exportFile = (v: 1 | 2) => join(__dirname, 'fixtures', `fictional_export_v${v}_2026-10-26.csv`)

async function signIn(page: Page) {
  test.skip(!EMAIL || !PASSWORD, 'PRACTICE_IMPORT_DEMO_EMAIL / PRACTICE_IMPORT_DEMO_PASSWORD not set')
  await signInThroughUi(page, EMAIL, PASSWORD)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('group', { name: 'Workspace' }).getByRole('link', { name: 'Practice' }).click()
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 20_000 })
}

const nav = (page: Page) => page.locator('[data-sidebar="sidebar"]')
/** The newest run: the history lists newest first. */
const newest = (page: Page) => page.getByRole('region', { name: 'History' }).getByRole('row').nth(1)

async function importExport(page: Page, v: 1 | 2) {
  await nav(page).getByRole('link', { name: 'Imports' }).click()
  await expect(page.getByRole('heading', { name: 'Imports' })).toBeVisible()
  await page.getByLabel('Export file').setInputFiles(exportFile(v))
  await expect(page.getByLabel('As of')).toHaveValue('2026-10-26')   // taken from the file name
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(newest(page)).toContainText(`fictional_export_v${v}_2026-10-26.csv`, { timeout: 30_000 })
  await expect(newest(page)).toContainText('Done', { timeout: 180_000 })
}

test.describe('P2 tax preparer — an imported book (fictional)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 })

  test('IJ1 Import an export: uploaded, read in batches, every client listed by its number', async ({ page }) => {
    await signIn(page)
    await importExport(page, 1)
    await nav(page).getByRole('link', { name: 'Clients' }).click()
    const row = page.getByRole('row', { name: /Client 1003\b/ })
    await expect(row).toContainText('From the export · no TIN')
    await expect(page.getByRole('row', { name: /Client -1010\b/ })).toBeVisible()   // an individual, numbered negative
  })

  test('IJ2 Evidence and a verdict: a finding opens on its period, the verdict is kept', async ({ page }) => {
    await signIn(page)
    await nav(page).getByRole('link', { name: 'Opportunities' }).click()
    await expect(page.getByRole('heading', { name: 'Opportunities' })).toBeVisible()
    const held = page.getByRole('region', { name: 'Credit held' })
    await held.getByRole('row', { name: /Client 1003\b/ }).getByRole('cell').last().click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByText('Credit held', { exact: false }).first()).toBeVisible()
    await expect(sheet.getByRole('region', { name: 'The period' })).toBeVisible({ timeout: 20_000 })
    await expect(sheet.getByRole('region', { name: 'Every period of the form' }).getByRole('button', { pressed: true })).toHaveCount(1)
    await expect(sheet.getByText('$8,140').first()).toBeVisible()

    const verdict = sheet.getByRole('group', { name: 'Verdict' })
    await sheet.getByLabel('Note').fill('Fictional check: the credit shows on the period.')
    await verdict.getByRole('button', { name: 'Valid', exact: true }).click()
    await expect(verdict.getByRole('button', { name: 'Valid', exact: true })).toHaveAttribute('aria-pressed', 'true')

    // Kept: after a reload the row says so, and the evidence opens with it.
    await page.reload()
    const again = page.getByRole('region', { name: 'Credit held' }).getByRole('row', { name: /Client 1003\b/ })
    await expect(again).toContainText('Valid', { timeout: 20_000 })
    await again.getByRole('cell').last().click()
    const v2 = page.getByRole('dialog').getByRole('group', { name: 'Verdict' })
    await expect(v2.getByRole('button', { name: 'Valid', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('dialog').getByLabel('Note')).toHaveValue('Fictional check: the credit shows on the period.')
    // Cleared, so the next run starts from an open finding.
    await v2.getByRole('button', { name: 'Clear' }).click()
    await expect(v2.getByRole('button', { name: 'Valid', exact: true })).toHaveAttribute('aria-pressed', 'false')
  })

  test('IJ3 A newer export: replaced by client number, and the history says what changed', async ({ page }) => {
    await signIn(page)
    await importExport(page, 2)
    const row = newest(page)
    await expect(row).toContainText('1 not in this file')   // a client the newer file leaves out is kept
    await row.locator('summary').click()
    // Northgate paid its 941 tax: first-time abatement no longer waits on payment.
    await expect(row).toContainText('Penalty, first-time abatement: +1 / −0')
    await expect(row).toContainText('Penalty, FTA once tax is paid: +0 / −1')
    await nav(page).getByRole('link', { name: 'Opportunities' }).click()
    await page.getByRole('tab', { name: /Payroll/ }).click()
    await expect(page.getByRole('region', { name: 'Penalty, first-time abatement' }).getByRole('row', { name: /Client 1006\b/ })).toBeVisible()
  })

  test('IJ4 Re-run the analysis: every client recomputed, with progress, nothing changed', async ({ page }) => {
    await signIn(page)
    await nav(page).getByRole('link', { name: 'Imports' }).click()
    await page.getByRole('button', { name: 'Re-run analysis' }).click()
    await expect(newest(page)).toContainText('Re-run of the analysis', { timeout: 30_000 })
    await expect(newest(page)).toContainText('Done', { timeout: 180_000 })
    await expect(newest(page)).toContainText('nothing changed')
  })
})
