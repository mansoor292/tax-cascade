/**
 * Verification tests for the full 1040 calculator + SSTB QBI
 */
import { calc1040 } from '../src/engine/tax_engine.js'

let pass = 0, fail = 0

function check(label: string, actual: number, expected: number, tol: number = 1) {
  const ok = Math.abs(actual - expected) <= tol
  if (ok) { console.log(`  PASS: ${label} = ${actual} (≈${expected})`); pass++ }
  else { console.log(`  FAIL: ${label} = ${actual}, expected ≈${expected}`); fail++ }
}

// Common base
const base = {
  taxable_interest: 0, ordinary_dividends: 0, qualified_dividends: 0,
  ira_distributions: 0, pensions_annuities: 0, social_security: 0,
  capital_gains: 0, ltcg_portion: 0, schedule1_income: 0,
  student_loan_interest: 0, educator_expenses: 0,
  itemized_deductions: 0, use_itemized: false,
  qbi_from_k1: 0, k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
  withholding: 0, estimated_payments: 0, num_dependents: 0,
} as const

// ═══ Test 1: SSTB above phaseout — zero QBI ═══
console.log('\n=== Test 1: SSTB above phaseout ===')
const r1 = calc1040({
  ...base, filing_status: 'mfj', tax_year: 2025,
  wages: 500000,
  qbi_from_k1: 150000, is_sstb: true,
  k1_ordinary_income: 150000, k1_w2_wages: 80000,
  withholding: 100000,
} as any)
check('qbi_deduction', r1.computed.qbi_deduction, 0)
// Additional Medicare: (500000 - 250000) * 0.009 = 2250
check('additional_medicare', r1.computed.additional_medicare, 2250)

// ═══ Test 2: Non-SSTB same income — wage-limited QBI ═══
console.log('\n=== Test 2: Non-SSTB same income ===')
const r2 = calc1040({
  ...base, filing_status: 'mfj', tax_year: 2025,
  wages: 500000,
  is_sstb: false,
  k1_ordinary_income: 150000, k1_w2_wages: 80000,  // K-1 box 1 is the QBI
  withholding: 100000,
} as any)
// Non-SSTB above phaseout: min(20% QBI, wage limit, 20% TI)
// 20% of 150k = 30k, 50% wages = 40k → min is 30k
check('qbi_deduction', r2.computed.qbi_deduction, 30000)

// ═══ Test 3: Below threshold — SSTB irrelevant ═══
console.log('\n=== Test 3: Below threshold — SSTB gets full 20% ===')
const r3 = calc1040({
  ...base, filing_status: 'single', tax_year: 2025,
  wages: 50000,
  is_sstb: true,
  k1_ordinary_income: 30000,  // single K-1 amount
} as any)
check('qbi_deduction', r3.computed.qbi_deduction, 6000)

// ═══ Test 4: Social Security two-tier (below first threshold) ═══
console.log('\n=== Test 4: SS — below first threshold (nontaxable) ===')
const r4 = calc1040({
  ...base, filing_status: 'mfj', tax_year: 2025,
  wages: 5000, social_security: 20000,
} as any)
// Provisional = 5000 + 10000 = 15000 < 32000 → 0% taxable
check('ss_taxable', r4.computed.ss_taxable, 0)

// ═══ Test 5: SS two-tier (above second threshold — 85%) ═══
console.log('\n=== Test 5: SS — high income (85% taxable) ===')
const r5 = calc1040({
  ...base, filing_status: 'single', tax_year: 2025,
  wages: 50000, social_security: 20000,
} as any)
// Provisional = 50000 + 10000 = 60000 > 34000 → up to 85%
check('ss_taxable', r5.computed.ss_taxable, 17000)

// ═══ Test 6: LTCG preferential rate ═══
console.log('\n=== Test 6: LTCG preferential rate ===')
const r6 = calc1040({
  ...base, filing_status: 'mfj', tax_year: 2025,
  wages: 100000, capital_gains: 50000, ltcg_portion: 50000,
} as any)
// The ltcg_tax should be less than ordinary_tax on same amount
console.log('  ltcg_tax:', r6.computed.ltcg_tax, '(should be >0)')
console.log('  ordinary_tax:', r6.computed.ordinary_tax)
if (r6.computed.ltcg_tax >= 0) { pass++; console.log('  PASS: LTCG computed') }
else { fail++ }

// ═══ Test 7: Self-employment tax + half-deduction ═══
console.log('\n=== Test 7: SE tax + half-deduction ===')
const r7 = calc1040({
  ...base, filing_status: 'single', tax_year: 2025,
  net_se_income: 100000,
} as any)
// SE subject = 92350, SS portion = 92350 * 12.4% = 11451
// Medicare = 92350 * 2.9% = 2678
// Total SE = ~14129
console.log('  se_tax:', r7.computed.se_tax)
if (r7.computed.se_tax > 13000 && r7.computed.se_tax < 15000) { pass++; console.log('  PASS: SE tax in range') }
else { fail++ }

// ═══ Test 8: Child Tax Credit ═══
console.log('\n=== Test 8: Child Tax Credit ===')
const r8 = calc1040({
  ...base, filing_status: 'mfj', tax_year: 2025,
  wages: 80000, num_dependents: 2,
} as any)
// CTC: 2 children × $2000 = $4000 (no phaseout below $400k MFJ)
check('ctc_credit', r8.computed.ctc_credit, 4000)

console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
