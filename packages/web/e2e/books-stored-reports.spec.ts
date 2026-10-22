import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, createEntityViaApi, authed, SUPABASE_URL } from './helpers'

/**
 * The books from stored QuickBooks reports, with no live connection
 * (2026-10-22).
 *
 * Reports are cached for a day; past that the API re-fetched from QuickBooks,
 * and an entity with no active connection — one that disconnected, or the
 * demo group set up from stored reports — threw, so its books vanished from
 * the financials, the golden view and Compare a day after they were last
 * pulled. The last stored reports are the books, however old; fetched_at
 * says as of when.
 */
const BASE = process.env.BASE_URL || 'https://fin.catipult.ai'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

test.describe('books from stored reports, no QuickBooks connection', () => {
  test.skip(!SERVICE, 'needs SUPABASE_SERVICE_ROLE_KEY to seed stored reports')
  const email = testEmail('books-stored')
  let token = ''
  let entityId = ''
  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'E2E Books Inc', form_type: '1120S' })).id
    const stale = '2026-01-15T12:00:00Z'   // far older than the one-day cache
    const report = (report_type: string, summary: Record<string, number>) => ({
      entity_id: entityId, report_type, period_start: '2024-01-01', period_end: '2024-12-31', accounting_method: 'Cash',
      fetched_at: stale, summary, raw_data: { Header: { ReportName: report_type === 'balance-sheet' ? 'BalanceSheet' : 'ProfitAndLoss', Currency: 'USD' } },
    })
    const res = await fetch(`${SUPABASE_URL}/rest/v1/qbo_report`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([
        report('profit-and-loss', { 'Income > Sales': 250000, 'Expenses > Advertising': 40000, 'NetIncome': 210000 }),
        report('balance-sheet', { 'TotalAssets > CurrentAssets > Checking': 90000 }),
      ]),
    })
    expect(res.ok, `seeding stored reports: ${res.status}`).toBe(true)
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('the stored reports are served, dated, however old', async () => {
    const res = await fetch(`${BASE}/api/qbo/${entityId}/financials?year=2024`, { headers: authed(token) })
    const body: any = await res.json()
    expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200)
    expect(body.profit_and_loss.items['Income > Sales']).toBe(250000)
    expect(body.profit_and_loss.fetched_at).toMatch(/^2026-01-15/)
    expect(body.balance_sheet.items['TotalAssets > CurrentAssets > Checking']).toBe(90000)
  })
})
