/**
 * Verification tests for Schedule E (Form 1040) — rental, royalty, K-1 income
 *
 * Run: npx tsx packages/api/scripts/test_schedule_e.ts
 */
import { calcScheduleE, calc1040, calcForm8582 } from '../src/engine/tax_engine.js'
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
    // Per-property grid: 2 props × ~10 numeric cells ≈ 20+ per-prop fields on top of summaries
    check('per-property grid filled', built.filled >= 25 ? 'ok' : `only ${built.filled}`, 'ok')
    console.log(`  → packages/api/test_output/schedule_e_test.pdf (${built.filled} fields, ${built.pdf.getPageCount()} pages)`)
  } catch (e: any) {
    console.log(`  FAIL: PDF build threw — ${e.message}`)
    fail++
  }

  // ═══ §469 PAL cases via calcForm8582 + calcScheduleE integration ═══

  console.log('\n=== Form 8582 — below phaseout, full $25K allowance ===')
  const pal1 = calcForm8582({
    tax_year: 2025, filing_status: 'mfj', magi: 80000, active_participation: true,
    rental_re_current_income: 0, rental_re_current_loss: 20000, rental_re_prior_unallowed: 0,
    other_current_income: 0, other_current_loss: 0, other_prior_unallowed: 0,
  })
  check('L7 phaseout excess',      pal1.computed.L7, 70000)      // 150K - 80K
  check('L8 allowance',            pal1.computed.L8, 25000)      // capped at 25K
  check('L9 special allowance',    pal1.computed.L9, 20000)      // min(|L4|, L8) = min(20K, 25K)
  check('RE allowed loss',         pal1.computed.rental_re_allowed_loss, 20000)
  check('RE suspended',            pal1.computed.rental_re_suspended, 0)

  console.log('\n=== Form 8582 — mid phaseout, partial allowance ===')
  const pal2 = calcForm8582({
    tax_year: 2025, filing_status: 'mfj', magi: 130000, active_participation: true,
    rental_re_current_income: 0, rental_re_current_loss: 20000, rental_re_prior_unallowed: 0,
    other_current_income: 0, other_current_loss: 0, other_prior_unallowed: 0,
  })
  check('L7 excess (150K - 130K)', pal2.computed.L7, 20000)
  check('L8 allowance (L7 * 0.5)', pal2.computed.L8, 10000)
  check('L9 = min(20K, 10K)',      pal2.computed.L9, 10000)
  check('RE allowed loss',         pal2.computed.rental_re_allowed_loss, 10000)
  check('RE suspended',            pal2.computed.rental_re_suspended, 10000)

  console.log('\n=== Form 8582 — MAGI ≥ $150K, allowance fully phased out ===')
  const pal3 = calcForm8582({
    tax_year: 2025, filing_status: 'mfj', magi: 160000, active_participation: true,
    rental_re_current_income: 0, rental_re_current_loss: 15000, rental_re_prior_unallowed: 0,
    other_current_income: 0, other_current_loss: 0, other_prior_unallowed: 0,
  })
  check('L7 clamped to 0',         pal3.computed.L7, 0)
  check('L9 no allowance',         pal3.computed.L9, 0)
  check('all $15K suspended',      pal3.computed.rental_re_suspended, 15000)
  check('nothing allowed',         pal3.computed.rental_re_allowed_loss, 0)

  console.log('\n=== Form 8582 — passive income absorbs losses, no allowance used ===')
  const pal4 = calcForm8582({
    tax_year: 2025, filing_status: 'single', magi: 120000, active_participation: true,
    rental_re_current_income: 12000, rental_re_current_loss: 8000, rental_re_prior_unallowed: 0,
    other_current_income: 0, other_current_loss: 0, other_prior_unallowed: 0,
  })
  check('L1d net positive',        pal4.computed.L1d, 4000)
  check('no special allowance',    pal4.computed.L9, 0)  // L3 >= 0 so no Part II
  check('all loss allowed',        pal4.computed.rental_re_allowed_loss, 8000)
  check('nothing suspended',       pal4.computed.rental_re_suspended, 0)

  console.log('\n=== Form 8582 — MFS thresholds ($75K/$12.5K) ===')
  const pal5 = calcForm8582({
    tax_year: 2025, filing_status: 'mfs', magi: 60000, active_participation: true,
    rental_re_current_income: 0, rental_re_current_loss: 10000, rental_re_prior_unallowed: 0,
    other_current_income: 0, other_current_loss: 0, other_prior_unallowed: 0,
  })
  check('MFS threshold L5',        pal5.computed.L5, 75000)
  check('MFS L8 capped at 12.5K',  pal5.computed.L8, Math.min(Math.round((75000-60000)*0.5), 12500))
  check('MFS L9',                  pal5.computed.L9, 7500)  // min(|L4|=10K, L8=7.5K)

  console.log('\n=== Form 8582 — not active participant, no allowance ===')
  const pal6 = calcForm8582({
    tax_year: 2025, filing_status: 'mfj', magi: 80000, active_participation: false,
    rental_re_current_income: 0, rental_re_current_loss: 20000, rental_re_prior_unallowed: 0,
    other_current_income: 0, other_current_loss: 0, other_prior_unallowed: 0,
  })
  check('non-AP allowance zeroed', pal6.computed.L9, 0)
  check('non-AP all suspended',    pal6.computed.rental_re_suspended, 20000)

  console.log('\n=== calcScheduleE + PAL — pro-rate allowance across loss props ===')
  const schPal = calcScheduleE({
    tax_year: 2025,
    rental_properties: [
      { address: 'A',  rents: 30000, mortgage_interest: 10000, depreciation: 4000, repairs: 1000, taxes: 3000 },  // +12K
      { address: 'B',  rents: 10000, mortgage_interest: 12000, depreciation: 5000, taxes: 2500, insurance: 1500 }, // -11K
      { address: 'C',  rents: 8000,  mortgage_interest: 9000,  depreciation: 3000, taxes: 2000 },                  // -6K
    ],
    pal_limitation: { filing_status: 'mfj', magi: 130000, active_participation: true },
  })
  // Gross loss B+C = 17K, gross income A = 12K, net = -5K
  // MAGI 130K → L8 = 10K allowance → L9 = min(5K, 10K) = 5K
  // RE allowed loss = income (12K) + allowance (5K) = 17K — all loss deductible
  check('no suspension (full absorb)', schPal.computed.pal?.suspended_rental, 0)
  check('L24 income (prop A)',         schPal.computed.L24_income, 12000)
  check('L25 losses (B+C all allowed)', schPal.computed.L25_losses, 17000)
  check('L26 net',                      schPal.computed.L26_rental_royalty_net, -5000)

  console.log('\n=== calcScheduleE + PAL — loss exceeds allowance, pro-rate by magnitude ===')
  const schPal2 = calcScheduleE({
    tax_year: 2025,
    rental_properties: [
      { address: 'Lossmaker A', rents: 5000, mortgage_interest: 15000 },   // -10K
      { address: 'Lossmaker B', rents: 2000, mortgage_interest: 12000 },   // -10K
    ],
    pal_limitation: { filing_status: 'mfj', magi: 140000, active_participation: true },
  })
  // Gross loss 20K, MAGI 140K → L7=10K, L8=5K, L9=5K. Allowed loss = 5K total.
  // Pro-rated 50/50 → each property gets -$2,500 deductible
  const propA = schPal2.computed.per_property[0]
  const propB = schPal2.computed.per_property[1]
  check('propA deductible pro-rated',   propA.deductible_loss, -2500)
  check('propB deductible pro-rated',   propB.deductible_loss, -2500)
  check('suspended = gross - allowed',  schPal2.computed.pal?.suspended_rental, 15000)
  check('L26 reflects allowed only',    schPal2.computed.L26_rental_royalty_net, -5000)

  // ═══ Case 8: PDF round-trip — fill then read back via form API ═══
  console.log('\n=== Schedule E PDF — round-trip property values ===')
  try {
    const { PDFDocument } = await import('pdf-lib')
    const built = await buildScheduleEPdf(
      {
        tax_year: 2025, taxpayer_name: 'Round Trip Test', taxpayer_id: '111-22-3333',
        rental_properties: [
          { address: '456 Beach Rd', rents: 36000, mortgage_interest: 14000, depreciation: 5000, taxes: 4000 },
        ],
      },
      calcScheduleE({
        tax_year: 2025,
        rental_properties: [
          { address: '456 Beach Rd', rents: 36000, mortgage_interest: 14000, depreciation: 5000, taxes: 4000 },
        ],
      }),
      2025,
    )
    const bytes = await built.pdf.save()
    const rt = await PDFDocument.load(bytes)
    const rtForm = rt.getForm()
    const addr = rtForm.getTextField('topmostSubform[0].Page1[0].Table_Line1a[0].RowA[0].f1_3[0]').getText()
    const rents = rtForm.getTextField('topmostSubform[0].Page1[0].Table_Income[0].Line3[0].f1_16[0]').getText()
    const mort  = rtForm.getTextField('topmostSubform[0].Page1[0].Table_Expenses[0].Line12[0].f1_43[0]').getText()
    check('L1a address persisted',   addr, '456 Beach Rd')
    check('L3 rents persisted',      rents, '36,000')
    check('L12 mortgage persisted',  mort,  '14,000')
  } catch (e: any) {
    console.log(`  FAIL: round-trip threw — ${e.message}`)
    fail++
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
