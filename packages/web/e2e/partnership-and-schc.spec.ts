import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, createUserWithApiKey } from './helpers'

/**
 * Partnership preparation and single-member LLCs, against the DEPLOYED API.
 *
 * Owner decisions 2026-11-16 (Basecamp thread 10240221273, asked by the
 * practice side): a Form 1065 is prepared — page 1, Schedule K and one K-1 per
 * partner that ties to it — and a single-member LLC with no election is its
 * own entity (form type SchC) whose Schedule C flows into its owner's 1040
 * through a disregarded link. A fresh account walks both, the way a preparer
 * would: create the entities, compute, issue K-1s, link, compute the 1040.
 * Fictional figures throughout.
 */
test.describe('partnership and single-member LLC preparation', () => {
  const email = testEmail('p1065')
  let key = ''
  test.beforeAll(async () => { key = (await createUserWithApiKey(email)).apiKey })
  test.afterAll(() => deleteUserByEmail(email))
  const H = () => ({ 'X-API-Key': key })

  test('a 1065 computes, its K-1s tie to Schedule K, and K-1 PDFs issue', async ({ request, baseURL }) => {
    const ent = await request.post(`${baseURL}/api/entities`, { headers: H(), data: { name: 'Fictional Ridge Partners', form_type: '1065', legal_form: 'partnership' } })
    expect(ent.status()).toBeLessThan(300)
    const entity_id = (await ent.json()).entity.id

    const res = await request.post(`${baseURL}/api/returns/compute`, { headers: H(), data: {
      entity_id, tax_year: 2025, form_type: '1065', inputs: {
        gross_receipts: 912_345, cost_of_goods_sold: 101_010, salaries_wages: 202_020, other_deductions: 40_404,
        schedule_k_interest: 5_051, distributions: 60_606,
        partners: [
          { name: 'Alder Partner', partner_type: 'general', profit_pct: 70, guaranteed_payments_services: 70_707, capital_beginning: 10_000 },
          { name: 'Birch Partner', partner_type: 'limited', profit_pct: 30, capital_beginning: 5_000 },
        ],
      } } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    // 912,345 − 101,010 − (202,020 + 70,707 + 40,404)
    expect(body.computed.ordinary_income_loss).toBe(498_204)
    const k1s = body.k1s as any[]
    expect(k1s.map(k => k.ordinary_income).reduce((a, b) => a + b, 0)).toBe(498_204)
    expect(k1s.map(k => k.interest_income).reduce((a, b) => a + b, 0)).toBe(5_051)
    expect(k1s[0].se_earnings).toBe(k1s[0].ordinary_income + 70_707)   // general partner
    expect(k1s[1].se_earnings).toBe(0)                                  // limited partner
    expect(k1s[0].capital_ending).toBe(10_000 + k1s[0].capital_net_income - k1s[0].capital_withdrawals)

    const issued = await request.post(`${baseURL}/api/returns/${body.return_id}/k1s`, { headers: H() })
    expect(issued.status()).toBe(200)
    const k = await issued.json()
    expect(k.form).toBe('1065')
    expect(k.count).toBe(2)
  })

  test("a single-member LLC's Schedule C flows into its owner's 1040", async ({ request, baseURL }) => {
    const owner = await request.post(`${baseURL}/api/entities`, { headers: H(), data: { name: 'Alder Owner', form_type: '1040' } })
    expect(owner.status()).toBeLessThan(300)
    const owner_id = (await owner.json()).entity.id
    const llc = await request.post(`${baseURL}/api/entities`, { headers: H(), data: { name: 'Fictional Studio LLC', form_type: 'SchC', legal_form: 'llc' } })
    expect(llc.status()).toBeLessThan(300)
    const llc_body = await llc.json()
    expect(llc_body.entity.entity_type).toBe('disregarded_llc')

    const sc = await request.post(`${baseURL}/api/returns/compute`, { headers: H(), data: {
      entity_id: llc_body.entity.id, tax_year: 2025, form_type: 'SchC',
      inputs: { gross_receipts: 212_345, advertising: 4_321, rents: 12_000, meals: 2_000 } } })
    expect(sc.status()).toBe(200)
    expect((await sc.json()).computed.net_profit).toBe(212_345 - 4_321 - 12_000 - 1_000)

    const link = await request.post(`${baseURL}/api/entity-map/links`, { headers: H(), data: {
      kind: 'disregarded', from_entity_id: owner_id, to_entity_id: llc_body.entity.id, subject: 'taxpayer', source: 'owner' } })
    expect(link.status()).toBe(201)

    const r = await request.post(`${baseURL}/api/returns/compute`, { headers: H(), data: {
      entity_id: owner_id, tax_year: 2025, form_type: '1040', inputs: { filing_status: 'single', wages: 50_000, withholding: 5_000, is_sstb: false } } })
    expect(r.status()).toBe(200)
    const one040 = await r.json()
    const exp = await request.get(`${baseURL}/api/returns/${one040.return_id}/export`, { headers: H() })
    expect(exp.status()).toBe(200)
    const lines = new Map(((await exp.json()).lines as any[]).map(l => [l.key, l.value]))
    expect(lines.get('sched1.L3_business_income')).toBe(195_024)
    expect(Number(lines.get('f1040sse.L12_se_tax'))).toBeGreaterThan(0)
    expect(Number(lines.get('sched1.L15_se_tax_deduction'))).toBe(Math.round(Number(lines.get('f1040sse.L12_se_tax')) * 0.5))
  })
})
