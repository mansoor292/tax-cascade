import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi } from './helpers'

/**
 * One account must never be able to read another's tax data.
 *
 * Found by walking /app/compare/:id, which no test had visited. The page
 * white-screened, and tracing why led to the endpoint behind it: every route
 * module talks to Supabase with the SERVICE ROLE key, which bypasses
 * row-level security, so a query that filters only on the record id returns
 * that record to whoever asks. Authentication was checked; ownership was not.
 *
 * Two endpoints returned a stranger's entity name, wages and full input_data
 * to any signed-up account. RLS is not a backstop here — the service-role
 * client is precisely the thing that disables it — so ownership has to be
 * explicit in the query, and that is what these tests hold in place.
 */
test.describe('cross-tenant isolation', () => {
  const victimEmail = testEmail('tenant-victim')
  const attackerEmail = testEmail('tenant-attacker')
  const MARKER = 'ZZTENANTMARKER'
  const WAGES = 987654

  let victimToken = '', attackerToken = ''
  let entityId = '', returnId = ''

  test.beforeAll(async ({ request, baseURL }) => {
    victimToken = await signUpViaApi(victimEmail)
    attackerToken = await signUpViaApi(attackerEmail)

    const ent = await request.post(`${baseURL}/api/entities`, {
      headers: { Authorization: `Bearer ${victimToken}` },
      data: { name: `${MARKER} Family Trust`, form_type: '1040' },
    })
    entityId = (await ent.json())?.entity?.id
    expect(entityId, 'setup: victim entity').toBeTruthy()

    const comp = await request.post(`${baseURL}/api/returns/compute`, {
      headers: { Authorization: `Bearer ${victimToken}` },
      data: {
        entity_id: entityId, tax_year: 2024, form_type: '1040', save: true,
        inputs: { wages: WAGES, filing_status: 'single' },
      },
    })
    returnId = (await comp.json())?.return_id
    expect(returnId, 'setup: victim return').toBeTruthy()
  })

  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) {
      await request.delete(`${baseURL}/api/entities/${entityId}`, {
        headers: { Authorization: `Bearer ${victimToken}` },
      })
    }
    await deleteUserByEmail(victimEmail)
    await deleteUserByEmail(attackerEmail)
  })

  test('the owner can still read their own comparison', async ({ request, baseURL }) => {
    // The fix must not lock the legitimate user out of their own data.
    const res = await request.get(`${baseURL}/api/returns/compare/${entityId}`, {
      headers: { Authorization: `Bearer ${victimToken}` },
    })
    expect(res.status()).toBe(200)
    expect(await res.text()).toContain(MARKER)
  })

  test('the owner can still read their own return', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/returns/${returnId}`, {
      headers: { Authorization: `Bearer ${victimToken}` },
    })
    expect(res.status()).toBe(200)
    expect(await res.text()).toContain(String(WAGES))
  })

  test('another account cannot read the comparison', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/returns/compare/${entityId}`, {
      headers: { Authorization: `Bearer ${attackerToken}` },
    })
    const body = await res.text()
    expect(body, 'entity name leaked to a stranger').not.toContain(MARKER)
    expect(body, 'wages leaked to a stranger').not.toContain(String(WAGES))
    expect([403, 404]).toContain(res.status())
  })

  test('another account cannot read the return', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/returns/${returnId}`, {
      headers: { Authorization: `Bearer ${attackerToken}` },
    })
    const body = await res.text()
    expect(body, 'return contents leaked to a stranger').not.toContain(String(WAGES))
    expect(body).not.toContain(MARKER)
    expect([403, 404]).toContain(res.status())
  })

  test('an unauthenticated caller gets nothing', async ({ request, baseURL }) => {
    for (const path of [`/api/returns/compare/${entityId}`, `/api/returns/${returnId}`]) {
      const res = await request.get(baseURL + path)
      expect(res.status(), `${path} must require auth`).toBe(401)
    }
  })
})
