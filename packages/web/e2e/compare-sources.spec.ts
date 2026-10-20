import { test, expect, type Page } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi, createEntityViaApi } from './helpers'

/**
 * Compare → "All sources, one year" (2026-10-20): one return year across the
 * filed return, the IRS's record, the books, stored returns and scenarios on
 * the golden schema (GET /api/golden).
 *
 *  1. Live API: a fresh account's year with nothing on file says so — the
 *     tab must never paint a blank table.
 *  2. A full year, served from a fixture shaped like EZA 2024 (the IRS holds
 *     the 2023 return in the 2024 period): the banner, the differences
 *     filter, the books' summed totals and accounts, the stored-return and
 *     scenario columns, the year switch — and the EIN a QuickBooks account
 *     name can carry never reaches the screen.
 */

function watch(page: Page) {
  const problems: string[] = []
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_BLOCKED_BY_CLIENT|DevTools/i.test(m.text())) problems.push(`console: ${m.text()}`) })
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`) })
  return problems
}

const FAKE_EIN = '98-7654321'

function fixture(entityId: string, year: number) {
  const where = (s: string) => `${year} ${s}`
  return {
    entity: { id: entityId, name: 'E2E Sources Inc', form_type: '1120S' },
    year,
    sources: {
      filed_return: { catalog_id: 'c1', filename: 'E2E_2024_filed.pdf' },
      irs_return_transcript: { catalog_id: 'c2', type: 'return', as_of: '2026-10-20', holds_return_of: 2023, note: 'The IRS has the 2023 return in the 2024 period.' },
      returns: [{ id: 'r1', label: 'proforma 2026-10-15 (815a9144)' }],
      books: { pnl_as_of: '2026-10-20T21:36:47Z', lines: 3, unplaced: [], dropped: 0, warnings: [] },
      scenarios: [{ id: 's1', label: 'Pay officer more' }],
      documents: { count: 2, types: ['1099_int', '1099_div'], lines: 1, k1s_from_group_returns: [], unplaced: [], notes: [] },
    },
    summary: { keys: 4, agrees: 1, differs: 1, irs_only: 0, filed_only: 1, irs_recomputed: 1, returns_only: 0, headline_differs: 1, books_lines: 2, books_differ_from_golden: 2 },
    rows: [
      {
        form: 'f1120s', key: 'tax.L22_ordinary_income', label: 'Ordinary business income (loss). Subtract line 21 from line 6', section: '', line: '22', headline: true,
        filed: { value: 162007, where: where('filed return, Form 1120-S line 22, page 1') },
        irs: { value: 3044422, where: where('IRS return transcript dated 2026-10-20: Deductions — Ordinary Income/Loss') },
        books: { value: 150000, where: '2024 books (sum of the lines mapped from the books)', summed: true },
        returns: { 'proforma 2026-10-15 (815a9144)': { value: 162007, where: 'proforma, tax.L22_ordinary_income' } },
        scenarios: { 'Pay officer more': { value: 102007, where: 'scenario' } },
        golden: 162007, golden_from: 'filed', status: 'differs', books_differs: true,
      },
      {
        form: 'f1120s', key: 'deductions.L8_salaries', label: 'Salaries and wages (less employment credits)', section: '', line: '8',
        filed: { value: 177802, where: where('filed return, Form 1120-S line 8, page 1') },
        documents: { value: 177802, where: '2024 documents on file: 1 × W-2', sources: ['1 × W-2'] },
        books: { value: 150987, where: '2024 books', accounts: [{ account: `Payroll > Wages (EIN ${FAKE_EIN})`, amount: 150987, rule: 'rule:salaries' }] },
        golden: 177802, golden_from: 'filed', status: 'filed_only', books_differs: true,
      },
      {
        form: 'f1120s', key: 'income.L3_gross_profit', label: 'Gross profit. Subtract line 2 from line 1c', section: '', line: '3',
        filed: { value: 1516138, where: where('filed return, line 3') },
        irs_computed: { value: 5171913, where: where('IRS return transcript: Income — Gross Profit Per Computer') },
        golden: 1516138, golden_from: 'filed', status: 'irs_recomputed',
      },
      {
        form: 'f1120s', key: 'deductions.L16_advertising', label: 'Advertising', section: '', line: '16',
        filed: { value: 600000, where: where('filed return, line 16') },
        returns: { 'proforma 2026-10-15 (815a9144)': { value: 600000, where: 'proforma' } },
        golden: 600000, golden_from: 'filed', status: 'filed_only',
      },
    ],
  }
}

test.describe('Compare — all sources, one year', () => {
  const email = testEmail('sources')
  let entityId = ''
  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'E2E Sources Inc', form_type: '1120S' })).id
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('live: a year with nothing on file says so', async ({ page }) => {
    const problems = watch(page)
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/compare/${entityId}`)
    await page.getByRole('tab', { name: 'All sources, one year' }).click()
    await expect(page).toHaveURL(/view=sources/)
    await expect(page.getByTestId('sources-view')).toBeVisible()
    await expect(page.getByTestId('sources-empty')).toContainText('Nothing is on file', { timeout: 20_000 })
    await expect(page.getByTestId('sources-list')).toContainText('not available')
    expect(problems).toEqual([])
  })

  test('fixture: the IRS holding another year, differences first, books and sources, no EIN', async ({ page }) => {
    const problems = watch(page)
    const asked: string[] = []
    await page.route('**/api/golden/**', async route => {
      const url = new URL(route.request().url())
      asked.push(url.searchParams.get('year') ?? '')
      await route.fulfill({ json: fixture(entityId, Number(url.searchParams.get('year'))) })
    })
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/compare/${entityId}?view=sources&year=2024`)

    await expect(page.getByTestId('irs-holds')).toContainText('holds the 2023 return in the 2024 period')
    await expect(page.getByTestId('sources-list')).toContainText('E2E_2024_filed.pdf')
    // differences first: the agreeing advertising line is hidden until "All lines"
    await expect(page.getByTestId('source-row')).toHaveCount(3)
    await expect(page.locator('[data-key="deductions.L16_advertising"]')).toHaveCount(0)
    await page.getByRole('button', { name: /^All lines/ }).click()
    await expect(page.getByTestId('source-row')).toHaveCount(4)
    await page.getByRole('button', { name: 'Headline' }).click()
    await expect(page.getByTestId('source-row')).toHaveCount(1)
    await page.getByRole('button', { name: /^Differences/ }).click()

    const table = page.getByTestId('sources-table')
    await expect(table.getByRole('columnheader', { name: 'Proforma 10/15/2026' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'Scenario: Pay officer more' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'Documents' })).toBeVisible()
    await expect(page.getByTestId('sources-list')).toContainText('2 on file (1099-INT, 1099-DIV)')
    const obi = page.locator('[data-key="tax.L22_ordinary_income"]')
    await expect(obi).toContainText('$3,044,422')
    await expect(obi).toContainText('$150,000 Σ')
    await expect(obi).toContainText('Differs')

    await page.locator('[data-key="deductions.L8_salaries"]').click()
    await expect(page.getByTestId('books-accounts')).toContainText('••-•••4321')
    expect(await page.content()).not.toContain(FAKE_EIN)

    await page.getByTestId('sources-year').filter({ hasText: '2023' }).click()
    await expect(page).toHaveURL(/year=2023/)
    await expect.poll(() => asked).toContain('2023')
    expect(problems).toEqual([])
  })
})
