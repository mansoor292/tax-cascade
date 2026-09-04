import { test, expect } from '@playwright/test'
import {
  testEmail, deleteUserByEmail, signUpViaApi, createEntityViaApi, authed,
} from './helpers'

/**
 * Schedule K-1 generation — the ISSUER side (SOP-04: "as managing partner
 * I had to send out the K-1s"). Two paths, both API-level:
 *
 *   1120-S: compute a return with shareholders, then POST /:id/k1s — one
 *   real PDF per shareholder from the engine's pro-rata allocation.
 *
 *   1065: POST /k1s/1065 with explicit Schedule K totals + partners (Cati
 *   has no 1065 engine — the allocator splits caller-supplied numbers).
 *
 * Each URL must serve an actual PDF — the silently-broken-PDF class has
 * shipped before, so %PDF magic bytes are asserted, not just a 200.
 */

const BASE = process.env.BASE_URL || 'https://fin.catipult.ai'

test.describe('K-1 generation (issuer side)', () => {
  const email = testEmail('k1gen')
  let token = ''
  let entityId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'K1 Issuer Corp', form_type: '1120S' })).id
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('an 1120S return with shareholders yields one real K-1 PDF per shareholder', async () => {
    const compute = await fetch(`${BASE}/api/returns/compute`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: entityId, tax_year: 2024, form_type: '1120S',
        inputs: {
          gross_receipts: 500000, cost_of_goods_sold: 100000,
          salaries_wages: 120000, officer_compensation: 80000,
          schedule_k_ubia: 40000,
          shareholders: [{ name: 'Alice Majority', pct: 60 }, { name: 'Bob Minority', pct: 40 }],
        },
      }),
    })
    expect(compute.ok, await compute.clone().text()).toBe(true)
    const returnId = (await compute.json() as any).return_id
    expect(returnId).toBeTruthy()

    const res = await fetch(`${BASE}/api/returns/${returnId}/k1s`, {
      method: 'POST', headers: authed(token),
    })
    expect(res.ok, await res.clone().text()).toBe(true)
    const body: any = await res.json()
    expect(body.count).toBe(2)
    expect(body.k1s.map((k: any) => k.recipient).sort()).toEqual(['Alice Majority', 'Bob Minority'])
    for (const k1 of body.k1s) {
      expect(k1.filled).toBeGreaterThanOrEqual(5)
      const pdf = await fetch(k1.url)
      expect(pdf.ok).toBe(true)
      const head = Buffer.from(await pdf.arrayBuffer())
      expect(head.subarray(0, 5).toString()).toBe('%PDF-')
      expect(head.length).toBeGreaterThan(20_000)
    }
  })

  test('1065 partner K-1s from explicit totals — allocations and PDFs', async () => {
    const res = await fetch(`${BASE}/api/returns/k1s/1065`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tax_year: 2024,
        partnership: { name: 'E2E Partners LLC', ein: '00-0000000', address: '1 Test Way', city: 'Miami', state: 'FL', zip: '33101' },
        totals: { ordinary_business_income: 200000, distributions: 80000, w2_wages: 60000, ubia: 40000 },
        partners: [
          { name: 'General Partner', is_general: true, profit_pct: 70, guaranteed_payments_services: 24000 },
          { name: 'Limited Partner', profit_pct: 30 },
        ],
      }),
    })
    expect(res.ok, await res.clone().text()).toBe(true)
    const body: any = await res.json()
    expect(body.count).toBe(2)
    for (const k1 of body.k1s) {
      const pdf = await fetch(k1.url)
      const head = Buffer.from(await pdf.arrayBuffer())
      expect(head.subarray(0, 5).toString()).toBe('%PDF-')
    }
  })

  test('percentages that do not sum to 100 are refused, not silently normalized', async () => {
    const res = await fetch(`${BASE}/api/returns/k1s/1065`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tax_year: 2024,
        partnership: { name: 'Bad Pct LLC' },
        totals: { ordinary_business_income: 1000 },
        partners: [{ name: 'Only', profit_pct: 60 }],
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await res.json()) as any).error).toMatch(/sum to 100/)
  })
})
