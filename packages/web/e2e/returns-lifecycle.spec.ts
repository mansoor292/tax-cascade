import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, authed, createEntityViaApi } from './helpers'

/**
 * The core product, end to end at the API level: record facts → compute →
 * saved return → validate → review → PDF → delete.
 *
 * This surface had almost no e2e coverage while being the reason the product
 * exists. The PDF step matters specifically: a "silently broken PDF" shipped
 * once already (52cf5f4) — a PDF endpoint can 200 with garbage, so the
 * assertions check the bytes, not just the status.
 */

test.describe('returns lifecycle', () => {
  const email = testEmail('retlife')
  let token = ''
  let entityId = ''
  let returnId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'Lifecycle Corp', form_type: '1120S', ein: '12-3456789',
    })).id
  })

  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  test('a recorded fact is stored and attributed', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/documents/fact`, {
      headers: authed(token),
      data: {
        entity_id: entityId, tax_year: 2025, category: 'w2',
        values: { box_1: 100_000, box_2: 12_000 },
        source_note: 'e2e recorded fact',
      },
    })
    expect(res.status(), await res.text()).toBeLessThan(300)
  })

  test('compute saves a proforma return with the golden totals', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/returns/compute`, {
      headers: authed(token),
      data: {
        entity_id: entityId, tax_year: 2025, form_type: '1120S',
        inputs: {
          gross_receipts: 1_000_000, cost_of_goods_sold: 400_000,
          officer_compensation: 100_000, salaries_wages: 200_000,
          shareholders: [{ name: 'Owner', pct: 100 }],
        },
      },
    })
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.saved, 'compute with an entity must persist').toBe(true)
    expect(body.return_id).toBeTruthy()
    returnId = body.return_id
    // Same arithmetic as the engine unit goldens: 600k gross profit − 300k
    // deductions = 300k ordinary income, no entity-level tax.
    expect(body.computed.ordinary_income_loss).toBe(300_000)
  })

  test('the saved return is listed and readable', async ({ request, baseURL }) => {
    expect(returnId, 'depends on the compute test').toBeTruthy()
    const list = await request.get(`${baseURL}/api/returns`, { headers: authed(token) })
    expect(list.status()).toBe(200)
    const rows = JSON.stringify(await list.json())
    expect(rows).toContain(returnId)

    const one = await request.get(`${baseURL}/api/returns/${returnId}`, { headers: authed(token) })
    expect(one.status()).toBe(200)
  })

  test('validate answers on the same inputs', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/returns/validate`, {
      headers: authed(token),
      data: {
        form_type: '1120S', tax_year: 2025,
        inputs: {
          gross_receipts: 1_000_000, cost_of_goods_sold: 400_000,
          officer_compensation: 100_000, salaries_wages: 200_000,
          shareholders: [{ name: 'Owner', pct: 100 }],
        },
      },
    })
    expect(res.status(), await res.text()).toBe(200)
  })

  test('review marks the return, and the PDF is a real PDF', async ({ request, baseURL }) => {
    expect(returnId, 'depends on the compute test').toBeTruthy()
    const rev = await request.post(`${baseURL}/api/returns/${returnId}/review`, {
      headers: authed(token), data: {},
    })
    expect(rev.status(), await rev.text()).toBe(200)

    const pdf = await request.get(`${baseURL}/api/returns/${returnId}/pdf`, { headers: authed(token) })
    expect(pdf.status(), await pdf.text().catch(() => '(binary)')).toBe(200)
    // The endpoint answers a presigned S3 URL, not bytes — so the assertion
    // that matters is that the URL serves an actual PDF. A 200 carrying a
    // link to garbage is exactly the "silently broken PDF" failure mode.
    const { url } = await pdf.json()
    expect(url, 'response must carry a download url').toBeTruthy()
    const file = await request.get(url)
    expect(file.status()).toBe(200)
    const bytes = await file.body()
    expect(bytes.subarray(0, 5).toString(), 'the link must serve an actual PDF').toBe('%PDF-')
    expect(bytes.length, 'a filled 1120-S is tens of KB, not an empty shell').toBeGreaterThan(10_000)
  })

  test('use-prior-year answers from the saved return', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/returns/use-prior-year`, {
      headers: authed(token),
      data: { entity_id: entityId, tax_year: 2026, form_type: '1120S', save: false },
    })
    // Contract: answered, never crashed — with a saved 2025 return this
    // should succeed; if the endpoint decides prior data is insufficient it
    // must say so cleanly.
    expect(res.status(), await res.text()).toBeLessThan(500)
  })

  test('an extension validates and files', async ({ request, baseURL }) => {
    const inputs = {
      taxpayer_name: 'Lifecycle Corp', estimated_tax_liability: 63_000,
      total_payments: 50_000, amount_paying: 13_000, form_code: '25',
    }
    const val = await request.post(`${baseURL}/api/returns/extension/validate`, {
      headers: authed(token),
      data: { extension_type: '7004', tax_year: 2025, inputs, entity_id: entityId },
    })
    expect(val.status(), await val.text()).toBe(200)

    const file = await request.post(`${baseURL}/api/returns/extension`, {
      headers: authed(token),
      data: { extension_type: '7004', tax_year: 2025, inputs, entity_id: entityId, save: true },
    })
    expect(file.status(), await file.text()).toBe(200)
  })

  test('delete removes the return', async ({ request, baseURL }) => {
    expect(returnId, 'depends on the compute test').toBeTruthy()
    const del = await request.delete(`${baseURL}/api/returns/${returnId}`, { headers: authed(token) })
    expect(del.status()).toBeLessThan(300)
    const gone = await request.get(`${baseURL}/api/returns/${returnId}`, { headers: authed(token) })
    expect(gone.status()).toBe(404)
  })
})
