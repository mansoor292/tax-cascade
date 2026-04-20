/**
 * Verification tests for Schedule E (Form 1040) — rental, royalty, K-1 income
 *
 * Run: npx tsx packages/api/scripts/test_schedule_e.ts
 */
import { calcScheduleE, calc1040 } from '../src/engine/tax_engine.js'
import { buildScheduleEPdf } from '../src/builders/build_schedule_e.js'
import { writeFileSync, mkdirSync } from 'fs'

let pass = 0, fail = 0

function check(label: string, actual: any, expected: any, tol = 1) {
  const ok = typeof actual === 'number' && typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected
  if (ok) { console.log(`  PASS: ${label} = ${actual}`); pass++ }
  else { console.log(`  FAIL: ${label} = ${actual}, expected ${expected}`); fail++ }
}

async function main() {
  // ═══ Case 1: Single rental property, net positive ═══
  console.log('=== Schedule E — single rental, net positive ===')
  const r1 = calcScheduleE({
    tax_year: 2025,
    rental_properties: [{
      address: '123 Main St, Miami FL', rents: 24000,
      mortgage_interest: 8000, depreciation: 3000, insurance: 1200,
      repairs: 500, taxes: 2500, utilities: 1800,
    }],
  })
  check('L23a rents',              r1.computed.L23a_total_rents, 24000)
  check('L23c mortgage interest',  r1.computed.L23c_total_mortgage_int, 8000)
  check('L23d depreciation',       r1.computed.L23d_total_depreciation, 3000)
  check('L23e total expenses',     r1.computed.L23e_total_expenses, 17000)
  check('L24 income (positive)',   r1.computed.L24_income, 7000)
  check('L25 losses (none)',       r1.computed.L25_losses, 0)
  check('L26 rental net',          r1.computed.L26_rental_royalty_net, 7000)
  check('L41 grand total',         r1.computed.L41_total_income_loss, 7000)

  // ═══ Case 2: Mixed gain + loss across two properties ═══
  console.log('\n=== Schedule E — 2 properties, one profits one loses ===')
  const r2 = calcScheduleE({
    tax_year: 2025,
    rental_properties: [
      { address: 'Prop A', rents: 30000, mortgage_interest: 10000, depreciation: 4000, repairs: 1000, taxes: 3000 },  // net +12000
      { address: 'Prop B', rents: 18000, mortgage_interest: 15000, depreciation: 5000, repairs: 2000, taxes: 2500, insurance: 1500 },  // net -8000
    ],
  })
  check('L23a total rents (A+B)',  r2.computed.L23a_total_rents, 48000)
  check('L24 income (pos only)',   r2.computed.L24_income, 12000)
  check('L25 losses (abs)',        r2.computed.L25_losses, 8000)
  check('L26 net = L24 - L25',     r2.computed.L26_rental_royalty_net, 4000)
  check('per-property count',      r2.computed.per_property.length, 2)
  check('property A net',          r2.computed.per_property[0].net_income_loss, 12000)
  check('property B net',          r2.computed.per_property[1].net_income_loss, -8000)

  // ═══ Case 3: Royalty property ═══
  console.log('\n=== Schedule E — royalty income ===')
  const r3 = calcScheduleE({
    tax_year: 2025,
    rental_properties: [{ property_type: '6', rents: 0, royalties: 15000, taxes: 500 }],
  })
  check('L23b royalties',          r3.computed.L23b_total_royalties, 15000)
  check('L26 net',                 r3.computed.L26_rental_royalty_net, 14500)

  // ═══ Case 4: Partnerships + S-corps (Part II) ═══
  console.log('\n=== Schedule E — partnerships/S-corps ===')
  const r4 = calcScheduleE({
    tax_year: 2025,
    partnerships: [
      { name: 'Acme LP', type: 'P', ordinary_income: 25000 },
      { name: 'Widget S-Corp', type: 'S', ordinary_income: -5000 },
    ],
  })
  check('L32 partnership total',   r4.computed.L32_partnership_total, 20000)
  check('L41 grand total',         r4.computed.L41_total_income_loss, 20000)

  // ═══ Case 5: Combined Part I + II + III + IV + V ═══
  console.log('\n=== Schedule E — combined L41 ===')
  const r5 = calcScheduleE({
    tax_year: 2025,
    rental_properties: [{ rents: 12000, taxes: 2000 }],  // +10000
    partnerships: [{ name: 'LP', type: 'P', ordinary_income: 15000 }],
    estate_trust_income: 3000,
    remic_income: 500,
    farm_rental: 2000,
  })
  check('L26 rental net',          r5.computed.L26_rental_royalty_net, 10000)
  check('L32 partnerships',        r5.computed.L32_partnership_total, 15000)
  check('L37 estate/trust',        r5.computed.L37_estate_trust_total, 3000)
  check('L39 REMIC',               r5.computed.L39_remic_total, 500)
  check('L40 farm rental',         r5.computed.L40_farm_rental, 2000)
  check('L41 grand total',         r5.computed.L41_total_income_loss, 30500)

  // ═══ Case 6: Schedule E flows into 1040 AGI ═══
  console.log('\n=== 1040 integration — Schedule E folds into Sch 1 L5 ===')
  const sch = calcScheduleE({
    tax_year: 2025,
    rental_properties: [{ rents: 24000, taxes: 2000, depreciation: 3000, mortgage_interest: 8000, insurance: 1200, repairs: 500, utilities: 1800 }],
    partnerships: [{ name: 'LP', type: 'P', ordinary_income: 15000 }],
  })
  const ret = calc1040({
    filing_status: 'single', tax_year: 2025,
    wages: 100000, taxable_interest: 0, ordinary_dividends: 0,
    qualified_dividends: 0, ira_distributions: 0, pensions_annuities: 0,
    social_security: 0, capital_gains: 0,
    schedule1_income: sch.computed.L41_total_income_loss,
    student_loan_interest: 0, educator_expenses: 0,
    itemized_deductions: 0, use_itemized: false,
    qbi_from_k1: 0, k1_ordinary_income: 0, k1_w2_wages: 0, k1_ubia: 0,
    withholding: 0, estimated_payments: 0,
  } as any).computed
  // L41 = $7,500 rental net + $15,000 partnership = $22,500
  check('L41 total flowing in',    sch.computed.L41_total_income_loss, 22500)
  // AGI = $100K + $22,500
  check('1040 AGI',                ret.agi, 122500)

  // ═══ Case 7: PDF fill ═══
  console.log('\n=== Schedule E PDF filler ===')
  try {
    const built = await buildScheduleEPdf(
      { tax_year: 2025, taxpayer_name: 'Test Taxpayer', taxpayer_id: '123-45-6789',
        rental_properties: r2.inputs.rental_properties, partnerships: [] },
      r2,
      2025,
    )
    mkdirSync('packages/api/test_output', { recursive: true })
    const bytes = await built.pdf.save()
    writeFileSync('packages/api/test_output/schedule_e_test.pdf', bytes)
    check('PDF generated',           built.pdf.getPageCount() > 0 ? 'ok' : 'empty', 'ok')
    check('summary fields filled',   built.filled >= 6 ? 'ok' : `only ${built.filled}`, 'ok')
    console.log(`  → packages/api/test_output/schedule_e_test.pdf (${built.filled} fields, ${built.pdf.getPageCount()} pages)`)
  } catch (e: any) {
    console.log(`  FAIL: PDF build threw — ${e.message}`)
    fail++
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
