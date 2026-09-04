// Pins the K-1 issuer-side allocators: 1120-S per-shareholder splits
// (including the §199A Statement A additions) and the 1065 partner
// allocator (which is NOT a 1065 engine — it splits caller-supplied
// Schedule K totals pro-rata).
import { describe, it, expect } from 'vitest'
import { calc1120S, calc1065K1s } from './tax_engine.js'

describe('calc1120S k1s — §199A additions', () => {
  const base = {
    gross_receipts: 500000, cost_of_goods_sold: 100000,
    salaries_wages: 120000, officer_compensation: 80000,
    schedule_k_ubia: 40000,
    shareholders: [
      { name: 'A', pct: 60 },
      { name: 'B', pct: 40 },
    ],
  } as any

  it('allocates qbi_income and ubia pro-rata', () => {
    const { computed } = calc1120S(base)
    const [a, b] = computed.k1s
    expect(a.qbi_income).toBe(a.ordinary_income)
    expect(a.ubia).toBe(24000)
    expect(b.ubia).toBe(16000)
    expect(a.qbi_income + b.qbi_income).toBe(computed.ordinary_income_loss)
  })

  it('defaults ubia to 0 when not provided', () => {
    const { computed } = calc1120S({ ...base, schedule_k_ubia: undefined })
    expect(computed.k1s[0].ubia).toBe(0)
  })
})

describe('calc1065K1s', () => {
  const totals = {
    ordinary_business_income: 200000,
    rental_real_estate: 50000,
    interest_income: 1000,
    section_179: 10000,
    distributions: 80000,
    w2_wages: 60000,
    ubia: 40000,
  }
  const partners = [
    { name: 'GP', tin: '00-0000000', is_general: true, profit_pct: 70, capital_pct: 50, guaranteed_payments_services: 24000 },
    { name: 'LP', profit_pct: 30, capital_pct: 50 },
  ]

  it('splits income by profit_pct, distributions by capital_pct', () => {
    const [gp, lp] = calc1065K1s(totals, partners)
    expect(gp.ordinary_income).toBe(140000)
    expect(lp.ordinary_income).toBe(60000)
    expect(gp.rental_real_estate).toBe(35000)
    expect(gp.distributions).toBe(40000)
    expect(lp.distributions).toBe(40000)
  })

  it('guaranteed payments are per-partner facts, never allocated', () => {
    const [gp, lp] = calc1065K1s(totals, partners)
    expect(gp.guaranteed_payments_services).toBe(24000)
    expect(lp.guaranteed_payments_services).toBe(0)
  })

  it('SE earnings only for general partners: ordinary share + own guaranteed payments', () => {
    const [gp, lp] = calc1065K1s(totals, partners)
    expect(gp.se_earnings).toBe(140000 + 24000)
    expect(lp.se_earnings).toBe(0)
  })

  it('rejects profit percentages that do not sum to 100', () => {
    expect(() => calc1065K1s(totals, [{ name: 'X', profit_pct: 60 }])).toThrow(/sum to 100/)
  })

  it('loss and capital percentages default to profit_pct', () => {
    const [only] = calc1065K1s(totals, [{ name: 'Solo', profit_pct: 100 }])
    expect(only.loss_pct).toBe(100)
    expect(only.capital_pct).toBe(100)
    expect(only.qbi_income).toBe(200000)
    expect(only.ubia).toBe(40000)
  })
})
