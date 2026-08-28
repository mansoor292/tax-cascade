import { test, expect, type Page } from '@playwright/test'
import { signUpThroughUi, signInThroughUi, testEmail, deleteUserByEmail, signUpViaApi } from './helpers'

/**
 * Every page in the app, walked once.
 *
 * The existing walk covered three pages of twelve. Every bug reported on
 * SOPs 01 and 02 was on ground a new user crosses and no test did — so this
 * crosses all of it, in both states that matter:
 *
 *   - a brand-new account with NO data, where empty states must render
 *     rather than crash on undefined; and
 *   - an account WITH an entity, which is what unlocks the detail pages.
 *
 * Each page is judged on what a person would actually notice: did it paint
 * something, did the console throw, did any API call 5xx, and is the React
 * error boundary showing. A page that loads and quietly shows nothing is the
 * failure mode that hid the env/RLS regression, so a blank main region fails.
 */

type PageProbe = { path: string; expect?: RegExp; needsEntity?: boolean }

const PAGES: PageProbe[] = [
  { path: '/app',                 expect: /Dashboard/i },
  { path: '/app/calendar',        expect: /Calendar/i },
  { path: '/app/entities',        expect: /Entit/i },
  { path: '/app/scenarios',       expect: /Scenario/i },
  { path: '/app/compute',         expect: /Comput/i },
  { path: '/app/cascade',         expect: /Cascade/i },
  { path: '/app/extensions',      expect: /Extension/i },
  { path: '/app/tax-tables',      expect: /Tax Table|Bracket/i },
  { path: '/app/settings',        expect: /Setting/i },
  { path: '/app/connect-claude',  expect: /Claude|Connect/i },
]

/** Collects everything a user would call "the page is broken". */
function watch(page: Page) {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const serverErrors: string[] = []

  page.on('console', m => {
    if (m.type() !== 'error') return
    const t = m.text()
    // Favicon and extension noise are not the app's failures.
    if (/favicon|ERR_BLOCKED_BY_CLIENT|Download the React DevTools/i.test(t)) return
    consoleErrors.push(t)
  })
  page.on('pageerror', e => pageErrors.push(String(e?.message || e)))
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`)
  })

  return { consoleErrors, pageErrors, serverErrors }
}

async function assertHealthy(page: Page, probe: PageProbe, w: ReturnType<typeof watch>) {
  // The error boundary, if the page threw during render.
  await expect(
    page.getByText(/Something went wrong|Application error|Unexpected Application Error/i),
    `${probe.path} rendered an error boundary`,
  ).toHaveCount(0)

  if (probe.expect) {
    await expect(
      page.locator('body'),
      `${probe.path} did not render its expected content`,
    ).toContainText(probe.expect, { timeout: 15_000 })
  }

  // A page that paints almost nothing is the silent-empty failure mode.
  const textLength = (await page.locator('main, #root').first().innerText().catch(() => '')).trim().length
  expect(textLength, `${probe.path} rendered a near-empty page (${textLength} chars)`).toBeGreaterThan(20)

  expect(w.pageErrors, `${probe.path} threw: ${w.pageErrors.join(' | ')}`).toHaveLength(0)
  expect(w.serverErrors, `${probe.path} got 5xx: ${w.serverErrors.join(', ')}`).toHaveLength(0)
  expect(w.consoleErrors, `${probe.path} console errors: ${w.consoleErrors.join(' | ')}`).toHaveLength(0)
}

test.describe('every page renders for a brand-new account', () => {
  const email = testEmail('pages-empty')
  test.afterAll(() => deleteUserByEmail(email))

  test('walks all pages with no data', async ({ page }) => {
    test.setTimeout(180_000)
    const w = watch(page)

    await signUpThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    for (const probe of PAGES) {
      w.consoleErrors.length = 0; w.pageErrors.length = 0; w.serverErrors.length = 0
      await page.goto(probe.path)
      await page.waitForLoadState('networkidle').catch(() => {})
      await assertHealthy(page, probe, w)
    }
  })
})

test.describe('every page renders for an account with an entity', () => {
  const email = testEmail('pages-data')
  let entityId = ''

  test.beforeAll(async ({ request, baseURL }) => {
    const token = await signUpViaApi(email)
    const res = await request.post(`${baseURL}/api/entities`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Walkthrough Entity', form_type: '1040' },
    })
    entityId = (await res.json())?.entity?.id
    expect(entityId, 'setup: entity must exist').toBeTruthy()
  })

  test.afterAll(() => deleteUserByEmail(email))

  test('walks all pages, plus entity detail and compare', async ({ page }) => {
    test.setTimeout(180_000)
    const w = watch(page)

    // Sign in as the account that owns the entity.
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    const withDetail: PageProbe[] = [
      ...PAGES,
      { path: `/app/entities/${entityId}`, expect: /Walkthrough Entity/i },
      { path: `/app/compare/${entityId}`,  expect: /Compar|Year/i },
    ]

    for (const probe of withDetail) {
      w.consoleErrors.length = 0; w.pageErrors.length = 0; w.serverErrors.length = 0
      await page.goto(probe.path)
      await page.waitForLoadState('networkidle').catch(() => {})
      await assertHealthy(page, probe, w)
    }
  })
})

test.describe('public pages', () => {
  for (const path of ['/', '/security', '/login']) {
    test(`${path} renders without error`, async ({ page }) => {
      const w = watch(page)
      await page.goto(path)
      await page.waitForLoadState('networkidle').catch(() => {})
      await assertHealthy(page, { path }, w)
    })
  }
})
