import { test, expect, type Page, type Browser } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { signInThroughUi, authed } from './helpers'

/**
 * The practice workspace (2026-10-24): persona P2, the tax preparer, walked
 * by clicking from where a preparer starts — the client list or the deadline
 * list — one test per journey (docs/USER_PERSONAS.md discipline).
 *
 * Runs on the fictional demo practice (login in SSM /tax-api/PRACTICE_DEMO_*;
 * `npm run test:e2e:clean` loads it; rebuilt by
 * packages/api/scripts/practice/seed_demo.ts). Its IRS-records provider is the
 * in-process fixture: no real taxpayer, and an "IRS request" here never leaves the
 * server. The onboarding journey makes its own client and deletes it.
 *
 * The signer's identity check runs at Didit's sandbox (the demo practice is
 * never sent to the live one): the test stands in for the camera by asking
 * the sandbox to approve the session (DIDIT_SANDBOX_API_KEY, from SSM).
 */

const EMAIL = process.env.PRACTICE_DEMO_EMAIL || ''
const PASSWORD = process.env.PRACTICE_DEMO_PASSWORD || ''
const DIDIT_SANDBOX_KEY = process.env.DIDIT_SANDBOX_API_KEY || ''

async function signIn(page: Page) {
  test.skip(!EMAIL || !PASSWORD, 'PRACTICE_DEMO_EMAIL / PRACTICE_DEMO_PASSWORD not set')
  await signInThroughUi(page, EMAIL, PASSWORD)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 20_000 })
}

/** From the owner Dashboard to the practice, by the workspace switch. */
async function toPractice(page: Page) {
  await page.getByRole('group', { name: 'Workspace' }).getByRole('link', { name: 'Practice' }).click()
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 20_000 })
}

const nav = (page: Page) => page.locator('[data-sidebar="sidebar"]')

test.describe('P2 tax preparer — practice workspace (demo practice)', () => {
  test.describe.configure({ timeout: 120_000 })

  test('PJ1 Clients: every client at a glance; the owner pages do not list them', async ({ page }) => {
    await signIn(page)
    // The owner workspace's entity list holds none of the practice's clients.
    await expect(nav(page).getByText('Harbor Point Dental PC')).toHaveCount(0)
    await toPractice(page)
    const row = page.getByRole('row', { name: /Juniper Freight LLC/ })
    await expect(row).toContainText('Readable')
    await expect(row).toContainText('2024')     // filed through: 2025 shows no return yet
    await expect(row).toContainText('$8,140')   // the credit the IRS holds on 2023
    await expect(page.getByRole('row', { name: /Tallow & Pine Interiors/ })).toContainText('Waiting on signature')
    await expect(page.getByRole('row', { name: /Bluegill Landscaping LLC/ })).toContainText('Submitted')
  })

  test('PJ2 Money the IRS holds: tile → Opportunities → the client’s period and its transactions', async ({ page }) => {
    await signIn(page)
    await toPractice(page)
    await page.getByRole('link', { name: /IRS holds/ }).click()
    await expect(page.getByRole('heading', { name: 'Opportunities' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /Income tax/ })).toHaveAttribute('aria-selected', 'true')
    const held = page.getByRole('region', { name: 'Credit held' })
    await held.getByRole('link', { name: 'Juniper Freight LLC' }).click()
    await expect(page.getByRole('heading', { name: 'Juniper Freight LLC' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'IRS account' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('cell', { name: 'Penalty for late payment of tax' })).toBeVisible()
    await expect(page.getByText('Account balance').locator('..')).toContainText('−$8,140')
  })

  test('PJ3 Penalties: first-time abatement fits, payroll kept in its own section', async ({ page }) => {
    await signIn(page)
    await toPractice(page)
    await nav(page).getByRole('link', { name: 'Opportunities' }).click()
    const fta = page.getByRole('region', { name: 'Penalty, first-time abatement' })
    await expect(fta.getByRole('row', { name: /Ostrander Millwork Inc/ })).toContainText(/refundable until 2027-08-19/)
    // Income first; the 941 deposit penalty is not in the income section.
    await expect(fta.getByRole('row', { name: /Redwick Staffing Group/ })).toHaveCount(0)
    await page.getByRole('tab', { name: /Payroll/ }).click()
    await expect(page.getByRole('region', { name: 'Penalty, first-time abatement' }).getByRole('row', { name: /Redwick Staffing Group/ })).toContainText('$1,840')
    await page.getByRole('tab', { name: /Risks from the returns/ }).click()
    await expect(page.getByRole('region', { name: 'Low officer pay' })).toContainText('Ostrander Millwork Inc')
  })

  test('PJ4 IRS access: a refused period (451) leads to the client’s authorization', async ({ page }) => {
    await signIn(page)
    await toPractice(page)
    await nav(page).getByRole('link', { name: 'IRS access' }).click()
    await expect(page.getByRole('heading', { name: 'IRS access', exact: true })).toBeVisible()
    const gaps = page.getByRole('region', { name: 'Authorization gaps' })
    await expect(gaps).toContainText('2024-03, 2024-06, 2024-09')
    await gaps.getByRole('link', { name: 'Calloway Imaging Partners' }).click()
    await expect(page.getByRole('tab', { name: 'Authorization' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(/refused \(451\)/)).toBeVisible()
  })

  test('PJ5 Onboarding: add a client; by link the client proves who they are, then draws a signature; staff send it; check → readable', async ({ page, browser }) => {
    test.skip(!DIDIT_SANDBOX_KEY, 'DIDIT_SANDBOX_API_KEY not set')
    await signIn(page)
    await toPractice(page)
    await removeLeftoverTestClients(page)
    await nav(page).getByRole('link', { name: 'IRS access' }).click()
    await page.getByRole('button', { name: 'Add client' }).click()
    const name = `E2E Onboarding ${Date.now()}`
    await page.getByLabel('Legal name').fill(name)
    // Even last digit: the fixture provider finds it. A fresh TIN each run, so
    // the account is new to the org, as a first 8821 makes it (one a past run
    // left there would be someone else's, and wait for proof: PJ8).
    const ein = `${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}0006`
    await page.getByLabel(/EIN/).fill(ein)
    await page.getByRole('button', { name: 'Create client and 8821' }).click()
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const entityId = await clientEntityId(page)
    try {
      // Catipult fills the 8821: it downloads as a PDF.
      const dl = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download 8821' }).click()
      expect((await dl).suggestedFilename()).toMatch(/_8821\.pdf$/)
      await page.getByRole('button', { name: 'Copy signature link' }).click()
      const link = await page.getByLabel('Signature link').inputValue()
      expect(link).toMatch(/\/sign\/[A-Za-z0-9_-]{20,}$/)
      const signer = await signAsClient(browser, link, name, ein)

      await page.reload()
      // Verified before anyone signs: nothing signed yet, and no button marks the check done.
      await expect(page.getByText(/Identity check in progress/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Mark identity verified' })).toHaveCount(0)
      await expect(page.getByText('Once the signer is verified.')).toBeVisible()
      await signer.finishCheck()
      await page.reload()
      await expect(page.getByText(/Verified: .*SSN ending 6789 confirmed; schedule k-1 names them \(shareholder\) for EIN ending 0006 \(test check\)/)).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(/^Signed by Pat Example, President .*on the signature link/)).toBeVisible()
      // The kept signed copy, as it is sent.
      const signedDl = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download signed 8821' }).click()
      expect((await signedDl).suggestedFilename()).toMatch(/_8821_signed\.pdf$/)
      // The preparer cannot send it: Catipult staff do.
      await expect(page.getByRole('button', { name: 'Mark submitted' })).toHaveCount(0)
      await expect(page.getByText('Catipult sends the signed 8821 for filing. There is nothing for you to do.')).toBeVisible()
      await sendFromFilingDesk(page, name)
      await expect(page.getByText(/^Sent .*Catipult records the confirmation/)).toBeVisible()
      await expect(page.getByText(/Checked 0 times/)).toBeVisible()
      await page.getByRole('button', { name: 'Check now' }).click()
      await expect(page.getByRole('tab', { name: 'IRS account' })).toBeVisible({ timeout: 20_000 })
      // Its first read runs in the background; the client then lists as readable.
      await nav(page).getByRole('link', { name: 'Clients' }).click()
      await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Readable')
    } finally {
      await page.request.delete(`/api/entities/${entityId}`, { headers: authed(await sessionToken(page)) })
    }
  })

  test('PJ8 Onboarding an EIN another firm already holds: verified, signed, sent — still waiting, nothing said why — until the filing is confirmed', async ({ page, browser }) => {
    test.skip(!DIDIT_SANDBOX_KEY, 'DIDIT_SANDBOX_API_KEY not set')
    await signIn(page)
    await toPractice(page)
    await removeLeftoverTestClients(page)
    await nav(page).getByRole('link', { name: 'IRS access' }).click()
    await page.getByRole('button', { name: 'Add client' }).click()
    const name = `E2E Onboarding held elsewhere ${Date.now()}`
    await page.getByLabel('Legal name').fill(name)
    // Ends in the last four of the fixture account no demo client holds:
    // someone else's 8821 already put it in the platform org.
    const ein = '100008824'
    await page.getByLabel(/EIN/).fill(ein)
    await page.getByRole('button', { name: 'Create client and 8821' }).click()
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const entityId = await clientEntityId(page)
    try {
      await page.getByRole('button', { name: 'Copy signature link' }).click()
      const link = await page.getByLabel('Signature link').inputValue()
      const signer = await signAsClient(browser, link, name, ein)
      await signer.finishCheck()
      await page.reload()
      await expect(page.getByText(/Verified: .*EIN ending 8824/)).toBeVisible({ timeout: 20_000 })
      await sendFromFilingDesk(page, name)
      await expect(page.getByText(/Checked 0 times/)).toBeVisible()
      await page.getByRole('button', { name: 'Check now' }).click()
      // The provider finds the TIN, but only through the other firm's 8821: the
      // client reads exactly as one not found yet.
      await expect(page.getByText('Not readable yet. Checked again tomorrow.')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(/Checked 1 time,/)).toBeVisible()
      await expect(page.getByRole('tab', { name: 'IRS account' })).toHaveCount(0)
      await expect(page.getByText(/another (firm|practice)|already (held|read)/i)).toHaveCount(0)
      await nav(page).getByRole('link', { name: 'Clients' }).click()
      await expect(page.getByRole('row', { name: new RegExp(name) })).not.toContainText('Readable')

      // The filing partner confirms they submitted THIS 8821: that is the proof.
      await nav(page).getByRole('link', { name: 'Filing desk' }).click()
      const item = page.getByRole('region', { name: 'Sent, waiting for confirmation' }).getByRole('listitem', { name })
      page.once('dialog', d => d.accept())
      await item.getByRole('button', { name: 'Record filing confirmed' }).click()
      await expect(page.getByText('Filing confirmed.')).toBeVisible()
      await nav(page).getByRole('link', { name: 'Clients' }).click()
      await page.getByRole('link', { name }).click()
      await expect(page.getByText(/filing confirmed/)).toBeVisible()
      await page.getByRole('button', { name: 'Check now' }).click()
      await expect(page.getByRole('tab', { name: 'IRS account' })).toBeVisible({ timeout: 20_000 })
    } finally {
      await page.request.delete(`/api/entities/${entityId}`, { headers: authed(await sessionToken(page)) })
    }
  })

  test('PJ6 IRS requests always pass through the confirmation', async ({ page }) => {
    await signIn(page)
    await toPractice(page)
    await page.getByRole('link', { name: 'Harbor Point Dental PC' }).click()
    await page.getByRole('tab', { name: 'IRS account' }).click()
    await page.getByRole('button', { name: /Request \d+ from IRS/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('real IRS request')
    const send = dialog.getByRole('button', { name: 'Send requests' })
    await expect(send).toBeDisabled()
    await dialog.getByLabel('I understand these are real IRS requests').check()
    await expect(send).toBeEnabled()
    await send.click()
    await expect(page.getByText(/queued/)).toBeVisible()
  })

  test('PJ9 No page names the backend: a preparer sees "IRS records", never the provider', async ({ page }) => {
    // Mansoor, 2026-10-25: "catipult users should not know anything about the
    // backend". Walks every practice page and every tab of a client, read
    // from the DOM (tooltips and labels included), not just the visible text.
    const named = async (where: string) => {
      const html = await page.evaluate(() => { const b = document.body.cloneNode(true) as HTMLElement; b.querySelectorAll('script').forEach(s => s.remove()); return b.innerHTML })
      expect(html, where).not.toMatch(/taxnow/i)
      expect(page.url(), where).not.toMatch(/taxnow/i)
    }
    await signIn(page)
    await toPractice(page)
    await named('Clients')
    for (const [link, heading] of [['Opportunities', 'Opportunities'], ['Deadlines', 'Deadlines'], ['IRS access', 'IRS access'], ['Practice settings', 'Practice settings'], ['Filing desk', 'Filing desk']]) {
      await nav(page).getByRole('link', { name: link }).click()
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await named(link)
    }
    await nav(page).getByRole('link', { name: 'Clients' }).click()
    await page.getByRole('row', { name: /Calloway Imaging Partners/ }).getByRole('link').first().click()
    await expect(page.getByRole('heading', { name: 'Calloway Imaging Partners' })).toBeVisible()
    for (const tab of ['Overview', 'IRS account', 'Returns', 'Authorization']) {
      await page.getByRole('tab', { name: tab }).click()
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
      await named(`Calloway: ${tab}`)
    }
    await page.getByRole('tab', { name: 'IRS account' }).click()
    await expect(page.getByRole('button', { name: 'Refresh IRS records' })).toBeVisible()
    await nav(page).getByRole('link', { name: 'Clients' }).click()
    await page.getByRole('row', { name: /Tallow & Pine Interiors/ }).getByRole('link').first().click()
    await expect(page.getByRole('heading', { name: 'Readable', exact: true })).toBeVisible()
    await named('Tallow & Pine onboarding')
  })

  test('PJ7 Deadlines: what is due across clients, each opening its client', async ({ page }) => {
    await signIn(page)
    await toPractice(page)
    await nav(page).getByRole('link', { name: 'Deadlines' }).click()
    await expect(page.getByRole('heading', { name: 'Deadlines' })).toBeVisible()
    const first = page.locator('table.ds-table tbody tr').first()
    await expect(first).not.toContainText('Loading')
    const link = first.getByRole('link')
    const client = (await link.textContent())?.trim() ?? ''
    expect(client).not.toBe('')
    await link.click()
    await expect(page.getByRole('heading', { name: client })).toBeVisible()
  })
})

/** The signed-in page's own Supabase session token (what the app sends). */
async function sessionToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (/^sb-.*-auth-token$/.test(k)) return JSON.parse(localStorage.getItem(k)!).access_token as string
    }
    return ''
  })
}

async function clientEntityId(page: Page): Promise<string> {
  const clientId = new URL(page.url()).pathname.split('/').pop()!
  const r = await page.request.get(`/api/practice/clients/${clientId}`, { headers: authed(await sessionToken(page)) })
  return (await r.json()).client.entity_id
}

/** A run that died mid-way leaves its client behind; clear them first. */
async function removeLeftoverTestClients(page: Page) {
  const h = { headers: authed(await sessionToken(page)) }
  const { clients } = await (await page.request.get('/api/practice/clients', h)).json()
  for (const c of clients as Array<{ name: string; entity_id: string }>) {
    if (c.name.startsWith('E2E Onboarding')) await page.request.delete(`/api/entities/${c.entity_id}`, h)
  }
}

/** The taxpayer's signer opens the link with no login and starts the
 *  identity check; finishCheck() is the photo ID and selfie, done (sandbox),
 *  then a fictional K-1 naming the signer for this EIN, then the drawn
 *  signature — only possible once verified. */
async function signAsClient(browser: Browser, link: string, taxpayer: string, ein: string) {
  const last4 = ein.slice(-4)
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  await p.goto(link)
  await expect(p.getByRole('heading', { name: /Form 8821/ })).toBeVisible()
  await expect(p.getByText(taxpayer)).toBeVisible()
  await expect(p.getByText(new RegExp(`EIN ending ${last4}`))).toBeVisible()
  // The form itself, behind the same link, with the TIN as its last four.
  const pdf = await p.request.get(await p.getByRole('link', { name: /View the form/ }).getAttribute('href') ?? '')
  expect(pdf.headers()['content-type']).toContain('application/pdf')
  // Nothing to sign until the signer is verified.
  await expect(p.getByText('Once your identity is confirmed, you draw your signature here.')).toBeVisible()
  await expect(p.getByRole('button', { name: 'Sign' })).toHaveCount(0)
  await p.getByLabel(/Your full legal name/).fill('Pat Example')
  await p.getByLabel('Title').fill('President')
  await p.getByLabel('Your Social Security number').fill('123-45-6789') // fictional
  // The page leaves for Didit at once: keep the session id on the way through.
  let session_id = ''
  await p.route('**/api/sign/*/verify', async route => {
    const resp = await route.fetch()
    session_id = (await resp.json()).session_id
    await route.fulfill({ response: resp })
  })
  await p.getByRole('button', { name: 'Start identity check' }).click()
  await p.waitForURL(/didit\.me/)
  expect(session_id).not.toBe('')
  return { finishCheck: async () => {
    // The sandbox stands in for the photo ID and the selfie.
    const sim = await p.request.post(`https://verification.didit.me/v3/session/${session_id}/simulate/`, { headers: { 'x-api-key': DIDIT_SANDBOX_KEY }, data: { new_status: 'Approved', send_webhooks: false } })
    expect(sim.ok()).toBe(true)
    // Didit returns the signer to the link, which pulls the result.
    await p.goto(link)
    // A business: the signer then shows they belong to it (a fictional K-1).
    await expect(p.getByText('Your ID and SSN are confirmed.')).toBeVisible({ timeout: 20_000 })
    await p.getByLabel('Document (PDF or photo)').setInputFiles({ name: 'k1-proof.pdf', mimeType: 'application/pdf', buffer: await fictionalK1(taxpayer, ein) })
    await p.getByRole('button', { name: 'Upload proof' }).click()
    await expect(p.getByText('Your identity is verified.')).toBeVisible({ timeout: 60_000 })
    // Signs under the name read from the ID (the sandbox reads none: the stated one).
    await expect(p.getByLabel('Name (from the verified ID)')).toHaveValue('Pat Example')
    const sign = p.getByRole('button', { name: 'Sign' })
    await p.getByLabel(/I am authorized/).check()
    await expect(sign).toBeDisabled() // nothing drawn yet
    await drawSignature(p)
    await sign.click()
    await expect(p.getByRole('heading', { name: 'Signed. Thank you.' })).toBeVisible({ timeout: 20_000 })
    await ctx.close()
  } }
}

/** Draw a signature on the pad, as a hand would. */
async function drawSignature(p: Page) {
  const box = (await p.getByRole('img', { name: 'Draw your signature' }).boundingBox())!
  await p.mouse.move(box.x + 20, box.y + box.height / 2)
  await p.mouse.down()
  for (let i = 1; i <= 30; i++) await p.mouse.move(box.x + 20 + i * 8, box.y + box.height / 2 + Math.sin(i / 2) * 20)
  await p.mouse.up()
}

/** Catipult staff send the signed copy (the demo practice, on the fictional
 *  back end, is its own staff), then return to the client. */
async function sendFromFilingDesk(page: Page, client: string) {
  const back = page.url()
  await nav(page).getByRole('link', { name: 'Filing desk' }).click()
  const item = page.getByRole('region', { name: 'To send' }).getByRole('listitem', { name: client })
  await expect(item).toContainText('Test check')
  await item.getByLabel('Sent to').fill('filing partner (fictional)')
  await item.getByRole('button', { name: 'Record as sent' }).click()
  await expect(page.getByText(/Recorded as sent/)).toBeVisible()
  await page.goto(back)
}

/** A one-page fictional Schedule K-1 naming Pat Example for this business:
 *  the proof a business signer uploads. Made per run, since each run's EIN
 *  is fresh (the proof's EIN must be the client's). */
async function fictionalK1(business: string, ein: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const lines = [
    'Schedule K-1 (Form 1120-S) 2024 (FICTIONAL TEST DOCUMENT)',
    `Part I  A Corporation's EIN: ${ein.slice(0, 2)}-${ein.slice(2)}`,
    `B Corporation's name: ${business}`,
    "Part II  E Shareholder's name: Pat Example",
    'G Shareholder percentage of stock ownership: 50%',
  ]
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 740 - 24 * i, size: 12, font }))
  return Buffer.from(await doc.save())
}
