import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, createUserWithApiKey } from './helpers'

/**
 * Golden-number checks against the DEPLOYED engine.
 *
 * Every case here is lifted verbatim from
 * packages/api/src/engine/tax_engine.test.ts, where the expected values are
 * derived by hand from published IRS rules — so these goldens can never
 * disagree with the unit goldens. What this adds over the unit tests is the
 * deployment: a prod box serving a stale build, a tax-table file that didn't
 * ship, or an engine-dispatch regression shows up here and nowhere else.
 */

test.describe('deployed engine golden numbers', () => {
  const email = testEmail('golden')
  let key = ''

  test.beforeAll(async () => {
    key = (await createUserWithApiKey(email)).apiKey
  })
  test.afterAll(() => deleteUserByEmail(email))

  const H = () => ({ 'X-API-Key': key })

  test('1120: 21% flat tax on 300,000 taxable income', async ({ request, baseURL }) => {
    // tax_engine.test.ts: 1,000,000 receipts − 400,000 COGS − 300,000
    // deductions → 300,000 TI; 300,000 × 0.21 = 63,000.
    const res = await request.post(`${baseURL}/api/compute/1120`, {
      headers: H(),
      data: {
        tax_year: 2025, gross_receipts: 1_000_000, cost_of_goods_sold: 400_000,
        officer_compensation: 100_000, salaries_wages: 200_000,
      },
    })
    expect(res.status()).toBe(200)
    const r = (await res.json()).result
    expect(r.computed.taxable_income).toBe(300_000)
    expect(r.computed.income_tax).toBe(63_000)
  })

  test('1120-S: pass-through — K-1 allocation is exhaustive and entity tax is zero', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/compute/1120s`, {
      headers: H(),
      data: {
        tax_year: 2025, gross_receipts: 1_000_000, cost_of_goods_sold: 400_000,
        officer_compensation: 100_000, salaries_wages: 200_000,
        shareholders: [{ name: 'A', pct: 60 }, { name: 'B', pct: 40 }],
      },
    })
    expect(res.status()).toBe(200)
    const r = (await res.json()).result
    expect(r.computed.ordinary_income_loss).toBe(300_000)
    expect(r.computed.k1s.map((k: any) => k.ordinary_income)).toEqual([180_000, 120_000])
    expect(r.liabilities.tax_due).toBe(0)
  })

  test('1040: TY2025 MFJ standard deduction and 12% bracket', async ({ request, baseURL }) => {
    // 100,000 wages − 30,000 std deduction = 70,000 TI;
    // 2,385 + 0.12 × (70,000 − 23,850) = 7,923.
    const res = await request.post(`${baseURL}/api/compute/1040`, {
      headers: H(),
      data: { tax_year: 2025, filing_status: 'mfj', wages: 100_000 },
    })
    expect(res.status()).toBe(200)
    const r = (await res.json()).result
    expect(r.computed.agi).toBe(100_000)
    expect(r.computed.taxable_income).toBe(70_000)
    expect(r.computed.income_tax).toBe(7_923)
  })

  test('cascade: S-corp income lands on the shareholder 1040', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/compute/cascade`, {
      headers: H(),
      data: {
        s_corp_inputs: {
          tax_year: 2025, gross_receipts: 1_000_000, cost_of_goods_sold: 400_000,
          officer_compensation: 100_000, salaries_wages: 200_000,
          shareholders: [{ name: 'Owner', pct: 100 }],
        },
        individual_base: { filing_status: 'mfj', tax_year: 2025, wages: 100_000 },
      },
    })
    expect(res.status()).toBe(200)
    const r = (await res.json()).result
    const text = JSON.stringify(r)
    // The K-1's 300,000 ordinary income must appear downstream — a cascade
    // that drops the pass-through is the failure worth catching.
    expect(text).toContain('300000')
  })

  test('a flat cascade body is refused with guidance, not a TypeError', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/compute/cascade`, {
      headers: H(),
      data: { tax_year: 2025, gross_receipts: 1_000_000 },
    })
    expect(res.status()).toBe(400)
    const err = (await res.json()).error || ''
    expect(err).toMatch(/s_corp_inputs/)
    expect(err).not.toMatch(/Cannot read propert|undefined/)
  })

  test('tax tables for 2025 are served and sane', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/tax-tables/2025`, { headers: H() })
    expect(res.status()).toBe(200)
    const t = await res.json()
    const body = JSON.stringify(t)
    // TY2025 MFJ standard deduction (Rev. Proc. 2024-40) and the 37% top rate.
    expect(body).toContain('30000')
    expect(body).toMatch(/0\.37|37/)
  })

  test('a tax year with no tables is refused, not silently zeroed', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/compute/1120`, {
      headers: H(),
      data: { tax_year: 1999, gross_receipts: 100 },
    })
    expect(res.status(), 'unknown year must not compute').toBeGreaterThanOrEqual(400)
    expect(res.status()).toBeLessThan(500)
  })
})
