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
 *     the 2023 return in the 2024 period): the banner, the books' summed
 *     totals and accounts, the year switch — and the EIN a QuickBooks account
 *     name can carry never reaches the screen.
 *  3. (2026-10-21) The owner asked for the filed · IRS · books layout and a
 *     way to pick a base and what to set beside it: the default is the filed
 *     return against the IRS and the books, key lines first in the form's
 *     order, each figure's difference from the base under it; sources toggle
 *     on and off, any source can be the base, and the choice lives in the URL
 *     (it survives a reload and a year switch).
 */

function watch(page: Page) {
  const problems: string[] = []
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_BLOCKED_BY_CLIENT|DevTools/i.test(m.text())) problems.push(`console: ${m.text()}`) })
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`) })
  return problems
}

const FAKE_EIN = '98-7654321'
const PROFORMA_ID = '815a9144-aaaa-bbbb-cccc-000000000000'

function fixture(entityId: string, year: number) {
  const where = (s: string) => `${year} ${s}`
  const proforma = 'proforma 2026-10-15 (815a9144)'
  return {
    entity: { id: entityId, name: 'E2E Sources Inc', form_type: '1120S' },
    year,
    sources: {
      filed_return: { catalog_id: 'c1', filename: 'E2E_2024_filed.pdf' },
      irs_return_transcript: { catalog_id: 'c2', type: 'return', as_of: '2026-10-20', holds_return_of: 2023, note: 'The IRS has the 2023 return in the 2024 period.' },
      returns: [{ id: PROFORMA_ID, label: proforma }],
      books: { pnl_as_of: '2026-10-20T21:36:47Z', lines: 4, unplaced: [], dropped: 0, warnings: [] },
      scenarios: [{ id: 's1', label: 'Pay officer more' }],
      documents: { count: 2, types: ['w2', '1099_int'], lines: 1, k1s_from_group_returns: [], unplaced: [], notes: [] },
    },
    summary: { keys: 10, agrees: 1, differs: 1, irs_only: 1, filed_only: 3, irs_recomputed: 1, returns_only: 0, headline_differs: 1, books_lines: 4, books_differ_from_golden: 3 },
    // the API sends headline rows first; the page prints them in the form's order
    rows: [
      {
        form: 'f1120s', key: 'tax.L22_ordinary_income', label: 'Ordinary business income (loss). Subtract line 21 from line 6', section: '', line: '22', headline: true, key_line: true,
        filed: { value: 162007, where: where('filed return, Form 1120-S line 22, page 1') },
        irs: { value: 3044422, where: where('IRS return transcript dated 2026-10-20: Deductions — Ordinary Income/Loss') },
        books: { value: 150000, where: '2024 books (sum of the lines mapped from the books)', summed: true },
        returns: { [proforma]: { value: 162007, where: 'proforma, tax.L22_ordinary_income' } },
        scenarios: { 'Pay officer more': { value: 102007, where: 'scenario' } },
        golden: 162007, golden_from: 'filed', status: 'differs', books_differs: true,
      },
      {
        form: 'f1120s', key: 'income.L1a_gross_receipts', label: 'Gross receipts or sales', section: '', line: '1a', headline: true, key_line: true,
        filed: { value: 2100000, where: where('filed return, line 1a') }, irs: { value: 2100000, where: where('IRS: Gross Receipts') },
        books: { value: 2100000, where: '2024 books' }, golden: 2100000, golden_from: 'filed', status: 'agrees',
      },
      {
        form: 'f1125a', key: 'cogs.L1_inventory', label: 'Inventory at beginning of year', section: '', line: '1',
        filed: { value: 5000, where: where('filed return, Form 1125-A line 1') }, books: { value: 5500, where: '2024 books' },
        golden: 5000, golden_from: 'filed', status: 'filed_only', books_differs: true,
      },
      {
        form: 'f1120s', key: 'schedL.L7_loans_eoy_d', label: 'Loans to shareholders — End of tax year. (d)', section: 'Schedule L', line: '7', col: 'd', key_line: true,
        irs: { value: 3070386, where: where('IRS: Loans to Shareholders End of Year') }, status: 'irs_only',
      },
      {
        form: 'f1120s', key: 'deductions.L8_salaries', label: 'Salaries and wages (less employment credits)', section: '', line: '8', key_line: true,
        filed: { value: 177802, where: where('filed return, Form 1120-S line 8, page 1') },
        documents: { value: 177802, where: '2024 documents on file: 1 × W-2', sources: ['1 × W-2'] },
        books: { value: 150987, where: '2024 books', accounts: [{ account: `Payroll > Wages (EIN ${FAKE_EIN})`, amount: 150987, rule: 'rule:salaries' }] },
        golden: 177802, golden_from: 'filed', status: 'filed_only', books_differs: true,
      },
      {
        form: 'f1120s', key: 'income.L3_gross_profit', label: 'Gross profit. Subtract line 2 from line 1c', section: '', line: '3', key_line: true,
        filed: { value: 1516138, where: where('filed return, line 3') },
        irs_computed: { value: 5171913, where: where('IRS return transcript: Income — Gross Profit Per Computer') },
        golden: 1516138, golden_from: 'filed', status: 'irs_recomputed',
      },
      {
        form: 'f1120s', key: 'schedK.L5a_dividends', label: 'Dividends: a. Ordinary dividends', section: 'Schedule K', line: '5a', key_line: true,
        filed: { value: 516, where: where('filed return, Schedule K line 5a') }, books: { value: 516, where: '2024 books' }, golden: 516, golden_from: 'filed', status: 'filed_only',
      },
      // a zero no other source speaks to: never shown
      { form: 'f1120s', key: 'schedM2.L8_end_balance', label: 'Balance at end of tax year', section: 'Schedule M-2', line: '8', col: 'a', key_line: true, filed: { value: 0, where: where('filed return, M-2 line 8') }, golden: 0, golden_from: 'filed', status: 'filed_only' },
      // the same page printed twice in the PDF: the second copy is not a key line
      { form: 'f1120s', key: 'tax.L22_ordinary_income', instance: '#2', label: 'Ordinary business income (loss). Subtract line 21 from line 6', section: '', line: '22', filed: { value: 162007, where: where('filed return, line 22, page 40') }, golden: 162007, golden_from: 'filed', status: 'filed_only' },
      {
        form: 'f1120s', key: 'deductions.L16_advertising', label: 'Advertising', section: '', line: '16', key_line: true,
        filed: { value: 600000, where: where('filed return, line 16') },
        returns: { [proforma]: { value: 600000, where: 'proforma' } },
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

  // 2026-10-21: the view shipped behind a "Compare years" button shown only
  // when a year had an amendment — none of the owner's entities has one, so
  // nobody could reach it without typing the URL. The other tests here open
  // the URL directly, which is how that went unseen.
  test('reached from the entity page: Returns → Compare opens all sources', async ({ page }) => {
    const problems = watch(page)
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/entities/${entityId}`)
    await page.getByRole('button', { name: 'Compare sources' }).click()
    await expect(page).toHaveURL(new RegExp(`/app/compare/${entityId}\\?view=sources&year=\\d{4}`))
    await expect(page.getByRole('tab', { name: 'All sources, one year' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('sources-view')).toBeVisible()
    await expect(page.getByTestId('sources-empty')).toContainText('Nothing is on file', { timeout: 20_000 })
    expect(problems).toEqual([])
  })

  const open = async (page: Page, query: string, asked: string[] = []) => {
    await page.route('**/api/golden/**', async route => {
      const url = new URL(route.request().url())
      asked.push(url.searchParams.get('year') ?? '')
      await route.fulfill({ json: fixture(entityId, Number(url.searchParams.get('year'))) })
    })
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/compare/${entityId}?${query}`)
  }
  const pressed = (page: Page, group: string, name: string | RegExp) => page.getByRole('group', { name: group }).getByRole('button', { name })

  test('default: the filed return against the IRS and the books, key lines in the form\'s order', async ({ page }) => {
    const problems = watch(page)
    await open(page, 'view=sources&year=2024')

    await expect(page.getByTestId('irs-holds')).toContainText('holds the 2023 return in the 2024 period')
    await expect(pressed(page, 'Base', 'Filed return')).toHaveAttribute('aria-pressed', 'true')
    await expect(pressed(page, 'Compare with', 'IRS')).toHaveAttribute('aria-pressed', 'true')
    await expect(pressed(page, 'Compare with', 'Books')).toHaveAttribute('aria-pressed', 'true')
    await expect(pressed(page, 'Compare with', 'Documents')).toHaveAttribute('aria-pressed', 'false')
    await expect(pressed(page, 'Compare with', 'Proforma 10/15/2026')).toHaveAttribute('aria-pressed', 'false')

    const table = page.getByTestId('sources-table')
    await expect(table.locator('thead th')).toHaveText(['Line', 'Filed return (base)', 'IRS', 'Books', 'Against base'])

    // key lines, as the form prints them
    await expect(page.getByRole('button', { name: 'Key lines (7)' })).toBeVisible()
    await expect(page.getByTestId('line-ref')).toHaveText(['1120-S line 1a', '1120-S line 3', '1120-S line 8', '1120-S line 16', '1120-S line 22', '1120-S Schedule K line 5a', '1120-S Schedule L line 7 (d)'])
    await expect(page.locator('[data-key="schedK.L5a_dividends"]')).toContainText('Dividends: a. Ordinary dividends')

    const obi = page.locator('[data-key="tax.L22_ordinary_income"]')
    await expect(obi).toContainText('$3,044,422')
    await expect(obi).toContainText('$150,000 Σ')
    await expect(obi.getByTestId('delta')).toHaveText(['+$2,882,415', '-$12,007'])
    await expect(obi).toContainText('Differs: IRS, Books')
    await expect(page.locator('[data-key="income.L3_gross_profit"]')).toContainText('$5,171,913 ¹')
    await expect(page.locator('[data-key="income.L1a_gross_receipts"]')).toContainText('Matches')
    await expect(page.locator('[data-key="schedL.L7_loans_eoy_d"]')).toContainText('Not in base')
    await expect(page.locator('[data-key="deductions.L16_advertising"]')).toContainText('Only in base')
    await expect(page.getByTestId('tile-irs')).toContainText('2 differ')
    await expect(page.getByTestId('tile-irs')).toContainText('1 match · 1 not in base')
    await expect(page.getByTestId('tile-books')).toContainText('3 differ')

    // differences against the base: a blank is not a difference
    await page.getByRole('button', { name: 'Differences (5)' }).click()
    await expect(page.getByTestId('source-row')).toHaveCount(5)
    await expect(page.locator('[data-key="deductions.L16_advertising"]')).toHaveCount(0)
    await expect(page.locator('[data-key="cogs.L1_inventory"]')).toHaveCount(1)
    await page.getByRole('button', { name: 'All lines (9)' }).click()
    await expect(page.getByTestId('source-row')).toHaveCount(9)
    await expect(page.locator('[data-key="schedM2.L8_end_balance"]')).toHaveCount(0)
    await expect(page.getByTestId('line-ref').filter({ hasText: 'copy 2' })).toHaveText('1120-S line 22 · copy 2')

    // a row opens to its provenance; the EIN in an account name is masked
    await page.locator('[data-key="deductions.L8_salaries"]').click()
    await expect(page.getByTestId('books-accounts')).toContainText('••-•••4321')
    expect(await page.content()).not.toContain(FAKE_EIN)
    expect(problems).toEqual([])
  })

  test('pick the base and what to compare it with; the choice survives a reload and a year switch', async ({ page }) => {
    const problems = watch(page)
    const asked: string[] = []
    await open(page, 'view=sources&year=2024', asked)
    const table = page.getByTestId('sources-table')
    await expect(pressed(page, 'Base', 'Filed return')).toHaveAttribute('aria-pressed', 'true')

    await pressed(page, 'Compare with', 'Documents').click()
    await pressed(page, 'Compare with', 'Proforma 10/15/2026').click()
    await pressed(page, 'Compare with', 'Books').click() // off
    await expect(page).toHaveURL(/base=filed&with=irs%2Cdocuments%2Cret%3A815a9144/)
    await expect(table.locator('thead th')).toHaveText(['Line', 'Filed return (base)', 'IRS', 'Documents', 'Proforma 10/15/2026', 'Against base'])
    await expect(page.locator('[data-key="deductions.L8_salaries"]')).toContainText('Matches')

    // the proforma becomes the base; the filed return takes its place beside it
    await pressed(page, 'Base', 'Proforma 10/15/2026').click()
    await expect(table.locator('thead th')).toHaveText(['Line', 'Proforma 10/15/2026 (base)', 'Filed return', 'IRS', 'Documents', 'Against base'])
    await expect(page.getByTestId('base-column')).toContainText('Proforma 10/15/2026')
    await expect(page.locator('[data-key="deductions.L16_advertising"]')).toContainText('Matches')

    // a scenario against the proforma, nothing else
    for (const name of ['Filed return', 'IRS', 'Documents']) await pressed(page, 'Compare with', name).click()
    await pressed(page, 'Compare with', 'Scenario: Pay officer more').click()
    await expect(table.locator('thead th')).toHaveText(['Line', 'Proforma 10/15/2026 (base)', 'Scenario: Pay officer more', 'Against base'])
    await expect(page.locator('[data-key="tax.L22_ordinary_income"]').getByTestId('delta')).toHaveText('-$60,000')

    await page.reload()
    await expect(table.locator('thead th')).toHaveText(['Line', 'Proforma 10/15/2026 (base)', 'Scenario: Pay officer more', 'Against base'])

    await page.getByTestId('sources-year').filter({ hasText: '2023' }).click()
    await expect(page).toHaveURL(/year=2023/)
    await expect(page).toHaveURL(/base=ret%3A815a9144/)
    await expect.poll(() => asked).toContain('2023')
    await expect(page.getByTestId('base-column')).toContainText('Proforma 10/15/2026')
    expect(problems).toEqual([])
  })
})
