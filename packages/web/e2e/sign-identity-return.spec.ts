import { test, expect, type Page } from '@playwright/test'

/**
 * The signer comes back from the identity check (2026-10-27).
 *
 * A live test signer finished Didit (approved), landed back on the signature
 * page before the decision was read, and was shown the identity form again
 * with a blank SSN. Submitting it started a second session that replaced the
 * approved one. The page now waits for a check Didit is finishing and offers
 * the form only to a signer who never got going.
 *
 * The signature API is answered in the browser (page.route) with a fictional
 * request: no practice, no Didit session, nothing real is read or written.
 */

const TOKEN = 'e2eFictionalSignToken0000000000'
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function request(idv: Record<string, unknown> | null) {
  return {
    practice: 'Example Fictional Practice', taxpayer: 'Example Fictional LLC', form_type: '1120', tin_last4: '0004', business: true,
    designee: { name: 'Dana Fictional, EA', caf: '0000-00000R', city: 'Springfield', state: 'IL' },
    scope: { income: [], payroll: ['941'], from_year: 2019, to_year: 2027 },
    expires: minutesAgo(-60 * 24 * 7),
    signer: {
      name: 'Pat Example', title: 'President', verified: false, signed: false, print_name: null, proof: null,
      idv: idv && { environment: 'live', started_at: minutesAgo(1), decided_at: null, attempts: 1, ssn_last4: '6789', reason: null, person: null, checks: null, ...idv },
    },
  }
}

/** Answer GET /api/sign/<token> with each body in turn (the last one repeats). */
async function answer(page: Page, bodies: unknown[]) {
  let n = 0
  await page.route(`**/api/sign/${TOKEN}`, route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 500, json: { error: 'not in this test' } })
    const body = bodies[Math.min(n++, bodies.length - 1)]
    return route.fulfill({ status: 200, json: body })
  })
}

test.describe('Signer back from the identity check', () => {
  test('a check Didit is finishing: the page waits for it, no form, then moves on by itself', async ({ page }) => {
    await answer(page, [
      request({ status: 'started', didit_status: 'In Progress' }),
      request({ status: 'approved', didit_status: 'Approved', decided_at: minutesAgo(0) }),
    ])
    await page.goto(`/sign/${TOKEN}`)
    await expect(page.getByText('Finishing your identity check…')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel('Your Social Security number')).toHaveCount(0)
    // The page polls on its own; the approved check then asks for the business proof.
    await expect(page.getByText('Your ID and SSN are confirmed.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByLabel('Your Social Security number')).toHaveCount(0)
  })

  test('a check the signer never started: the form is offered again', async ({ page }) => {
    await answer(page, [request({ status: 'started', didit_status: 'Not Started' })])
    await page.goto(`/sign/${TOKEN}`)
    await expect(page.getByText('Your identity check was not started or not finished.')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel('Your Social Security number')).toBeVisible()
  })

  test('a declined check says why and offers the form', async ({ page }) => {
    const reason = 'The SSN entered could not be checked against credit and financial records. Check the number and try again.'
    await answer(page, [request({ status: 'declined', didit_status: 'Approved', reason })])
    await page.goto(`/sign/${TOKEN}`)
    await expect(page.getByText(reason)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel('Your Social Security number')).toBeVisible()
  })
})
