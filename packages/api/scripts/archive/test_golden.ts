/**
 * Golden-output regression tests
 *
 * Feeds known inputs through calc1040/calc1120/calc1120S + PDF field mapping
 * and compares against checked-in expected values. Fails loudly if any
 * output drifts unexpectedly — catches bugs where a later fix silently
 * breaks an earlier one (e.g. gray cells, meta routing, stale preparer).
 *
 * Run: npx tsx packages/api/scripts/test_golden.ts
 */
import { calc1040, calc1120, calc1120S, calcScheduleE } from '../src/engine/tax_engine.js'

type Golden = {
  name: string
  run: () => { [key: string]: any }
  expected: Record<string, number | string | boolean>
}

const cases: Golden[] = [
  {
    name: '1040 MFJ — high income, Additional Medicare + NIIT',
    run: () => calc1040({
      filing_status: 'mfj', tax_year: 2024,
      wages: 500000, taxable_interest: 10000, ordinary_dividends: 5000,
      qualified_dividends: 5000, ira_distributions: 0, pensions_annuities: 0,
      social_security: 0, capital_gains: 0, schedule1_income: 0,
      student_loan_interest: 0, educator_expenses: 0,
      itemized_deductions: 0, use_itemized: false,
      qbi_from_k1: 0, k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
      withholding: 100000, estimated_payments: 0,
    } as any).computed,
    expected: {
      total_income: 515000,
      // AGI: 515,000 (no adjustments)
      agi: 515000,
      // Additional Medicare: (500,000 - 250,000) × 0.9% = 2,250
      additional_medicare: 2250,
      // NIIT: (10,000 + 5,000) × 3.8% = 570
      niit: 570,
    },
  },
  {
    // MFJ 2024: QBI phaseout ends at $483,900 taxable income. Fully above → SSTB gets $0.
    name: '1040 SSTB fully above phaseout — QBI = 0',
    run: () => calc1040({
      filing_status: 'mfj', tax_year: 2024,
      wages: 800000, taxable_interest: 0, ordinary_dividends: 0,
      qualified_dividends: 0, ira_distributions: 0, pensions_annuities: 0,
      social_security: 0, capital_gains: 0, schedule1_income: 0,
      student_loan_interest: 0, educator_expenses: 0,
      itemized_deductions: 0, use_itemized: false,
      qbi_from_k1: 150000, is_sstb: true,
      k1_ordinary_income: 0, k1_w2_wages: 80000, k1_ubia: 0,
      withholding: 200000, estimated_payments: 0,
    } as any).computed,
    expected: { qbi_deduction: 0 },
  },
  {
    // Same income but NON-SSTB — gets wage-limited QBI
    name: '1040 non-SSTB above phaseout — wage-limited QBI',
    run: () => calc1040({
      filing_status: 'mfj', tax_year: 2024,
      wages: 800000, taxable_interest: 0, ordinary_dividends: 0,
      qualified_dividends: 0, ira_distributions: 0, pensions_annuities: 0,
      social_security: 0, capital_gains: 0, schedule1_income: 0,
      student_loan_interest: 0, educator_expenses: 0,
      itemized_deductions: 0, use_itemized: false,
      qbi_from_k1: 150000, is_sstb: false,
      k1_ordinary_income: 0, k1_w2_wages: 80000, k1_ubia: 0,
      withholding: 200000, estimated_payments: 0,
    } as any).computed,
    // 20% of QBI = 30k; 50% of wages = 40k; wage-UBIA = 20k → take MAX = 40k; cap at 20% QBI = 30k
    expected: { qbi_deduction: 30000 },
  },
  {
    // Below threshold — SSTB flag irrelevant, get full 20%
    name: '1040 SSTB below threshold — full 20% QBI',
    run: () => calc1040({
      filing_status: 'mfj', tax_year: 2024,
      wages: 100000, taxable_interest: 0, ordinary_dividends: 0,
      qualified_dividends: 0, ira_distributions: 0, pensions_annuities: 0,
      social_security: 0, capital_gains: 0, schedule1_income: 0,
      student_loan_interest: 0, educator_expenses: 0,
      itemized_deductions: 0, use_itemized: false,
      qbi_from_k1: 50000, is_sstb: true,
      k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
      withholding: 15000, estimated_payments: 0,
    } as any).computed,
    expected: { qbi_deduction: 10000 },  // 20% × 50k
  },
  {
    name: '1120 C-Corp — 21% tax, DRD 50%',
    run: () => calc1120({
      tax_year: 2024,
      gross_receipts: 1000000, returns_allowances: 0, cost_of_goods_sold: 200000,
      dividends: 10000, interest_income: 0, gross_rents: 0, gross_royalties: 0,
      capital_gains: 0, net_gain_4797: 0, other_income: 0,
      officer_compensation: 100000, salaries_wages: 200000, repairs_maintenance: 0,
      bad_debts: 0, rents: 24000, taxes_licenses: 10000, interest_expense: 0,
      charitable_contrib: 0, depreciation: 5000, depletion: 0, advertising: 0,
      pension_plans: 0, employee_benefits: 0, other_deductions: 0,
      nol_deduction: 0, special_deductions: 0,
      dividends_less_20pct_owned: 10000,
      estimated_tax_paid: 0,
    } as any).computed,
    expected: {
      gross_profit: 800000,   // 1M - 200k COGS
      total_income: 810000,   // +10k dividends
      total_deductions: 339000,  // 100+200+24+10+5
      taxable_income_before_nol: 471000,
      special_deductions: 5000,    // 10k dividends × 50% DRD
      taxable_income: 466000,      // 471k - 5k special
      income_tax: 97860,           // 466k × 21%
      total_tax: 97860,
    },
  },
  {
    name: '1120-S — pass-through, no entity-level tax',
    run: () => calc1120S({
      gross_receipts: 2000000, returns_allowances: 0, cost_of_goods_sold: 500000,
      net_gain_4797: 0, other_income: 0,
      officer_compensation: 100000, salaries_wages: 300000, repairs_maintenance: 0,
      bad_debts: 0, rents: 20000, taxes_licenses: 10000, interest: 0,
      depreciation: 0, depletion: 0, advertising: 0,
      pension_plans: 0, employee_benefits: 0, other_deductions: 70000,
      charitable_contrib: 0, section_179: 0,
      shareholders: [{ name: 'Owner', pct: 100 }],
    } as any).computed,
    expected: {
      gross_profit: 1500000,
      total_income: 1500000,
      total_deductions: 500000,
      ordinary_income_loss: 1000000,
    },
  },
  {
    name: 'Schedule E — two rentals (gain + loss) + partnership K-1',
    run: () => calcScheduleE({
      tax_year: 2025,
      rental_properties: [
        { address: 'A', rents: 30000, mortgage_interest: 10000, depreciation: 4000, repairs: 1000, taxes: 3000 },
        { address: 'B', rents: 18000, mortgage_interest: 15000, depreciation: 5000, repairs: 2000, taxes: 2500, insurance: 1500 },
      ],
      partnerships: [{ name: 'LP', type: 'P', ordinary_income: 25000 }],
    }).computed,
    expected: {
      L23a_total_rents: 48000,
      L24_income: 12000,
      L25_losses: 8000,
      L26_rental_royalty_net: 4000,
      L32_partnership_total: 25000,
      L41_total_income_loss: 29000,
    },
  },
]

function compare(actual: any, expected: any, path: string = ''): string[] {
  const errors: string[] = []
  for (const [k, ev] of Object.entries(expected)) {
    const av = actual?.[k]
    const p = path ? `${path}.${k}` : k
    if (typeof ev === 'number') {
      if (typeof av !== 'number') { errors.push(`${p}: expected ${ev}, got ${av}`); continue }
      // Tolerance: ±1 for rounding (IRS forms round cents)
      if (Math.abs(av - ev) > 1) errors.push(`${p}: expected ${ev.toLocaleString()}, got ${av.toLocaleString()}  (Δ ${(av-ev).toLocaleString()})`)
    } else if (av !== ev) {
      errors.push(`${p}: expected ${JSON.stringify(ev)}, got ${JSON.stringify(av)}`)
    }
  }
  return errors
}

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    const actual = c.run()
    const errors = compare(actual, c.expected)
    if (errors.length === 0) {
      console.log(`  PASS  ${c.name}`)
      pass++
    } else {
      console.log(`  FAIL  ${c.name}`)
      for (const e of errors) console.log(`        ${e}`)
      fail++
    }
  }
  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
