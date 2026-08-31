import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, authed, createEntityViaApi } from './helpers'

/**
 * Scenario lifecycle: create → compute → PDF → promote.
 *
 * The scenario PDF broke silently once (52cf5f4) and nothing noticed,
 * because no test ever asked for the bytes. This one does.
 * (/:id/analyze and /compare's AI analysis call Gemini Pro — slow and
 * non-deterministic — so the lifecycle stops at the deterministic edges.)
 */

test.describe('scenarios lifecycle', () => {
  const email = testEmail('scen')
  let token = ''
  let entityId = ''
  let scenarioId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'Scenario Corp', form_type: '1120S', ein: '98-7654321',
    })).id
  })

  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  test('create a scenario with adjustments', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/scenarios`, {
      headers: authed(token),
      data: {
        name: 'More officer comp', entity_id: entityId, tax_year: 2025,
        adjustments: {
          gross_receipts: 1_000_000, cost_of_goods_sold: 400_000,
          officer_compensation: 200_000, salaries_wages: 200_000,
          shareholders: [{ name: 'Owner', pct: 100 }],
        },
      },
    })
    expect(res.status(), await res.text()).toBe(200)
    scenarioId = (await res.json()).scenario?.id
    expect(scenarioId).toBeTruthy()
  })

  test('compute the scenario', async ({ request, baseURL }) => {
    expect(scenarioId, 'depends on create').toBeTruthy()
    const res = await request.post(`${baseURL}/api/scenarios/${scenarioId}/compute`, {
      headers: authed(token), data: {},
    })
    expect(res.status(), await res.text()).toBe(200)
    const body = JSON.stringify(await res.json())
    // 1,000,000 − 400,000 − (200,000 + 200,000) = 200,000 ordinary income.
    expect(body).toContain('200000')
  })

  test('the scenario PDF is a real PDF', async ({ request, baseURL }) => {
    expect(scenarioId, 'depends on create').toBeTruthy()
    const pdf = await request.get(`${baseURL}/api/scenarios/${scenarioId}/pdf`, { headers: authed(token) })
    expect(pdf.status(), await pdf.text().catch(() => '(binary)')).toBe(200)
    const { url } = await pdf.json()
    expect(url, 'response must carry a download url').toBeTruthy()
    const file = await request.get(url)
    expect(file.status()).toBe(200)
    const bytes = await file.body()
    expect(bytes.subarray(0, 5).toString(), 'the link must serve an actual PDF').toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(10_000)
  })

  test('promote turns the scenario into a return', async ({ request, baseURL }) => {
    expect(scenarioId, 'depends on create').toBeTruthy()
    const res = await request.post(`${baseURL}/api/scenarios/${scenarioId}/promote`, {
      headers: authed(token), data: {},
    })
    expect(res.status(), await res.text()).toBe(200)

    const list = await request.get(`${baseURL}/api/returns`, { headers: authed(token) })
    const rows = JSON.stringify(await list.json())
    expect(rows, 'the promoted return must be listed').toContain('1120S')
  })

  test('an uncomputed scenario refuses to promote, cleanly', async ({ request, baseURL }) => {
    const fresh = await request.post(`${baseURL}/api/scenarios`, {
      headers: authed(token),
      data: { name: 'never computed', entity_id: entityId, tax_year: 2025, adjustments: {} },
    })
    const freshId = (await fresh.json()).scenario?.id
    const res = await request.post(`${baseURL}/api/scenarios/${freshId}/promote`, {
      headers: authed(token), data: {},
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/computed/i)
  })
})
