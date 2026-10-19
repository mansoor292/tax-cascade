import { test, expect, type Page } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi, authed, createEntityViaApi } from './helpers'

/**
 * The Group page (/app/group): the entity map, the breaks and the open
 * items, which until 2026-10-19 existed only through the API and Claude.
 *
 *  1. The real path: an account with two entities and one recorded link
 *     renders the map from the live API, and an account nothing has been
 *     reviewed for says so on every tab instead of painting a blank page.
 *  2. A full group, served from a fixture: every tab renders its data,
 *     recording a suggested link posts what the API needs, and the EIN that
 *     the review's evidence quotes never reaches the screen (the summary on
 *     prod carried 24 of them in evidence text when this page was built).
 */

const BASE = process.env.BASE_URL || 'https://fin.catipult.ai'

function watch(page: Page) {
  const problems: string[] = []
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_BLOCKED_BY_CLIENT|DevTools/i.test(m.text())) problems.push(`console: ${m.text()}`) })
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`) })
  return problems
}

test.describe('Group page — live API', () => {
  const email = testEmail('group')
  test.beforeAll(async () => {
    const token = await signUpViaApi(email)
    const home = await createEntityViaApi(token, { name: 'E2E Household', form_type: '1040' })
    const corp = await createEntityViaApi(token, { name: 'E2E Holdings Inc', form_type: '1120S' })
    const res = await fetch(`${BASE}/api/entity-map/links`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'owns', from_entity_id: home.id, to_entity_id: corp.id, subject: 'Pat Tester', pct: 100, source: 'owner' }),
    })
    if (res.status !== 201) throw new Error(`link not recorded: ${res.status} ${(await res.text()).slice(0, 200)}`)
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('the map draws the recorded link; an unreviewed account says so on each tab', async ({ page }) => {
    const problems = watch(page)
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.getByRole('link', { name: 'Group' }).click()
    await expect(page).toHaveURL(/\/app\/group/)
    await expect(page.getByRole('heading', { name: 'Group' })).toBeVisible()

    const map = page.getByRole('img', { name: 'Entity map' })
    await expect(map.locator('[data-node="E2E Holdings Inc"]')).toBeVisible({ timeout: 20_000 })
    await expect(map.locator('[data-node="E2E Household"]')).toBeVisible()
    await expect(map.locator('text', { hasText: 'Pat 100%' })).toBeVisible()
    await expect(page.getByTestId('map-link')).toHaveCount(1)
    await expect(page.getByTestId('all-recorded')).toBeVisible()

    await page.getByRole('tab', { name: 'Breaks' }).click()
    await expect(page.getByTestId('breaks-not-reviewed')).toContainText('No return has been reviewed yet')
    await page.getByRole('tab', { name: 'Open items' }).click()
    await expect(page.getByTestId('no-open-items')).toBeVisible()
    await expect(page).toHaveURL(/tab=open/)

    expect(problems).toEqual([])
  })
})

// ─── A full group, from a fixture ────────────────────────────────────────────

const FAKE_EIN = '98-7654321'
const HH = 'e2e-hh', SC = 'e2e-sc', CC = 'e2e-cc'
const link = (p: Record<string, unknown>) => ({
  to_entity_id: null, to_name: null, subject: null, pct: null, nature: null, from_year: null, to_year: null,
  source: 'filed_return', evidence: null, detail: null, recorded_at: '2026-10-18T00:00:00Z', ...p,
})
const MAP = {
  entities: [
    { id: HH, name: 'Pat & Sam Example', form_type: '1040', years: [2024, 2025], touches: [] },
    { id: SC, name: 'Example Holdings Inc', form_type: '1120S', years: [2024, 2025], touches: [{ entity_id: CC, name: 'Example Ventures Inc', via: 'intercompany (services)', effect: 'the other side\'s matching revenue or expense', link_key: 'l3' }] },
    { id: CC, name: 'Example Ventures Inc', form_type: '1120', years: [2025], touches: [] },
  ],
  links: [
    link({ link_key: 'l1', kind: 'owns', from_entity_id: HH, to_entity_id: SC, subject: 'Pat Example', pct: 100, from_entity_name: 'Pat & Sam Example', to_entity_name: 'Example Holdings Inc' }),
    link({ link_key: 'l3', kind: 'intercompany', from_entity_id: SC, to_entity_id: CC, nature: 'services', from_year: 2022, source: 'owner', evidence: `Fee schedule; payee ${FAKE_EIN}`, detail: 'Monthly management fee.', from_entity_name: 'Example Holdings Inc', to_entity_name: 'Example Ventures Inc' }),
    link({ link_key: 'l4', kind: 'intercompany', from_entity_id: SC, to_entity_id: CC, nature: 'settlement', from_year: 2023, from_entity_name: 'Example Holdings Inc', to_entity_name: 'Example Ventures Inc' }),
    link({ link_key: 'l5', kind: 'disregarded', from_entity_id: SC, to_name: 'Example Advisors LLC', source: 'fact', evidence: 'W-2 issuer', from_entity_name: 'Example Holdings Inc', to_entity_name: 'Example Advisors LLC' }),
  ],
  removed_links: [],
  owners: [],
  unrecorded: [{ kind: 'owns', from_entity_id: HH, to_entity_id: CC, to_name: null, subject: 'Pat Example', pct: 60, nature: null, years: [2025, 2024], source: 'filed_return', evidence: ['2025 Form 1125-E column (d)'], from_entity_name: 'Pat & Sam Example', to_entity_name: 'Example Ventures Inc' }],
}
const brk = (entity: string, entity_id: string, tax_year: number, title: string, extra: Record<string, unknown> = {}) => ({
  entity, entity_id, form_type: entity_id === CC ? '1120' : '1120S', tax_year, fingerprint: `${title}|${tax_year}`, check: 'intercompany.fees_match',
  severity: 'high', title, detail: `Detail for ${title}`, evidence: [{ where: `2025 Form 1120 Schedule L statement, EXAMPLE VENTURES INC ${FAKE_EIN}` }], ...extra,
})
const FEE = brk('Example Holdings Inc', SC, 2023, 'Intercompany fee 50,000 apart')
const BAL = brk('Example Holdings Inc', SC, 2025, 'Due-to / due-from 70,000 apart')
const SUMMARY = {
  count: 3,
  items: [
    { ...FEE, status: 'finding', tie: true, kind: 'rule', dollar_effect: -10500 },
    { ...brk('Example Ventures Inc', CC, 2025, 'Schedule K question 28 answered No'), status: 'finding', severity: 'medium', kind: 'rule' },
    { ...brk('Example Holdings Inc', SC, 2025, 'Number of shares not recorded'), status: 'gap', severity: 'low', kind: 'fact', asks: ['corp.shares_outstanding_end'] },
  ],
  facts_to_ask: ['corp.shares_outstanding_end'],
  open_notes_count: 1,
  open_notes: [{ note_key: 'n1', entity: 'Example Holdings Inc', entity_id: SC, form_type: '1120S', tax_year: 2023, status: 'open', waiting_on: 'owner', title: 'Amend 2023 for the fee, or leave it?', body: `Payee ${FAKE_EIN} billed 50,000 the payer never deducted.`, due_date: '2026-12-11', recorded_at: '2026-10-18T00:00:00Z' }],
  breaks: { filed: 2, sets: [] },
}
const SETS = { sets: [{ label: 'v1', title: 'Fee true-up', description: 'Restates the 2023 fee on both sides.', status: 'draft', filed_on: null, versions: [] }] }
const BREAKS: Record<string, unknown> = {
  filed: { set: 'filed', reviewed_returns: 5, breaks_count: 2, ties: false, breaks: [FEE, BAL] },
  v1: { set: 'v1', reviewed_returns: 5, breaks_count: 2, ties: false, new_breaks: [brk('Example Ventures Inc', CC, 2023, 'Line 1c no longer equals 1a minus 1b')], inherited_breaks: [BAL], fixes: [FEE] },
}

test.describe('Group page — a full group', () => {
  const email = testEmail('groupfx')
  test.beforeAll(async () => { await signUpViaApi(email) })
  test.afterAll(() => deleteUserByEmail(email))

  test('every tab renders the group, recording a suggestion posts it, and no EIN reaches the screen', async ({ page }) => {
    const problems = watch(page)
    let posted: Record<string, unknown> | null = null
    await page.route('**/api/entity-map', r => r.fulfill({ json: MAP }))
    await page.route('**/api/entity-map/links', r => { posted = r.request().postDataJSON(); return r.fulfill({ status: 201, json: { link: {} } }) })
    await page.route('**/api/review/summary', r => r.fulfill({ json: SUMMARY }))
    await page.route('**/api/version-sets', r => r.fulfill({ json: SETS }))
    await page.route('**/api/version-sets/*/breaks', r => r.fulfill({ json: BREAKS[r.request().url().split('/').slice(-2)[0]] }))

    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto('/app/group')

    // Map: the picture, one arc for two kinds of dealing, the outside LLC.
    const map = page.getByRole('img', { name: 'Entity map' })
    await expect(map.locator('[data-node="Example Holdings Inc"]')).toBeVisible({ timeout: 20_000 })
    await expect(map.locator('[data-node="Example Advisors LLC"]')).toBeVisible()
    await expect(map.locator('[data-kind="intercompany"]')).toHaveCount(1)
    await expect(map.locator('text', { hasText: 'Services / fees · Due to / due from' })).toBeVisible()
    await expect(page.getByTestId('map-link')).toHaveCount(4)
    await page.getByTestId('map-link').filter({ hasText: 'Intercompany' }).first().getByRole('button').click()
    await expect(page.getByText('Monthly management fee.')).toBeVisible()
    await expect(page.getByText(/payee ••-•••4321/)).toBeVisible()

    // Recording a suggestion sends the link as the API validates it.
    await page.getByTestId('unrecorded-link').getByRole('button', { name: 'Record' }).click()
    await expect.poll(() => posted).not.toBeNull()
    expect(posted).toEqual({ kind: 'owns', from_entity_id: HH, to_entity_id: CC, subject: 'Pat Example', pct: 60, from_year: 2024, source: 'filed_return', evidence: '2025 Form 1125-E column (d)' })

    // Breaks: filed, then the draft package's new / fixed / carried.
    await page.getByRole('tab', { name: 'Breaks' }).click()
    await expect(page.getByText('2 breaks in the returns as filed')).toBeVisible()
    await page.getByRole('button', { name: 'v1 · Fee true-up' }).click()
    await expect(page.getByText('New breaks (1)')).toBeVisible()
    await expect(page.getByText('Fixes (1)')).toBeVisible()
    await expect(page.getByText('Carried over from filed (1)')).toBeVisible()
    await expect(page.getByText('Line 1c no longer equals 1a minus 1b')).toBeVisible()

    // Open items: filters, a gap's question, the note, the evidence masked.
    await page.getByRole('tab', { name: 'Open items' }).click()
    await expect(page.getByText('3 open items')).toBeVisible()
    await page.getByRole('button', { name: 'Example Ventures Inc (1)' }).click()
    await expect(page.getByText('1 open item', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^All entities/ }).click()
    await page.getByRole('button', { name: 'Breaks', exact: true }).click()
    await expect(page.getByText('1 open item', { exact: true })).toBeVisible()
    await page.getByTestId('review-item').getByRole('button').first().click()
    await expect(page.getByText(/EXAMPLE VENTURES INC ••-•••4321/)).toBeVisible()
    await page.getByTestId('open-note').getByRole('button').click()
    await expect(page.getByText(/Payee ••-•••4321 billed/)).toBeVisible()

    expect(await page.content(), 'the review quotes an EIN; the screen must not').not.toContain(FAKE_EIN)
    expect(problems).toEqual([])
  })
})
