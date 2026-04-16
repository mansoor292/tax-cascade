/**
 * Verification tests for Form 4562 and Form 8594
 */
import { calc4562, calc8594 } from '../src/engine/tax_engine.js'
import { build4562Pdf } from '../src/builders/build_4562.js'
import { build8594Pdf } from '../src/builders/build_8594.js'
import { writeFileSync, mkdirSync } from 'fs'

let pass = 0, fail = 0

function check(label: string, actual: any, expected: any) {
  if (actual === expected) { console.log(`  PASS: ${label} = ${actual}`); pass++ }
  else { console.log(`  FAIL: ${label} = ${actual}, expected ${expected}`); fail++ }
}

async function main() {
  // ═══ Form 4562 Tests ═══
  console.log('=== Form 4562 — Depreciation ===')

  const depr = calc4562({
    taxpayer_name: 'Edgewater Ventures Inc',
    business_activity: 'Software Development',
    taxpayer_id: '861234567',
    tax_year: 2025,
    section_179_total_cost: 150000,
    section_179_carryover: 0,
    business_income_limit: 500000,
    special_depreciation: 0,
    other_depreciation: 0,
    macrs_prior_years: 45000,
    assets: [
      {
        description: 'Office Furniture',
        date_placed: '03/2025',
        cost_basis: 50000,
        business_pct: 100,
        recovery_period: 7,
        method: 'MACRS',
        convention: 'HY',
        year_number: 1,
        section_179_elected: 0,
      },
      {
        description: 'Computer Equipment',
        date_placed: '01/2025',
        cost_basis: 80000,
        business_pct: 100,
        recovery_period: 5,
        method: 'MACRS',
        convention: 'HY',
        year_number: 1,
        section_179_elected: 80000,
      },
      {
        description: 'Delivery Vehicle',
        date_placed: '06/2025',
        cost_basis: 45000,
        business_pct: 90,
        recovery_period: 5,
        method: 'MACRS',
        convention: 'HY',
        year_number: 1,
        section_179_elected: 0,
      },
    ],
  })

  console.log('  Computed:', JSON.stringify(depr.computed, null, 2))
  // 179: elected 80000, limitation 1250000, deduction = min(80000, 500000) = 80000
  check('section_179_deduction', depr.computed.section_179_deduction, 80000)
  check('section_179_carryforward', depr.computed.section_179_carryforward, 0)
  // Furniture: 50000 * 0.1429 (7yr year 1) = 7145
  check('7yr depreciation', depr.computed.depreciation_by_class['7yr'], 7145)
  // Computer: 80000 basis - 80000 s179 = 0 depreciable basis, so 0 MACRS
  // Vehicle: 45000 * 90% = 40500 basis, * 0.2000 (5yr year 1) = 8100
  check('5yr depreciation', depr.computed.depreciation_by_class['5yr'], 8100)
  // Total = 80000 (179) + 0 (special) + 0 (other) + 45000 (prior) + 7145 + 8100 = 140245
  check('total_depreciation', depr.computed.total_depreciation, 140245)

  // ═══ Form 8594 Tests ═══
  console.log('\n=== Form 8594 — Asset Acquisition ===')

  const acq = calc8594({
    taxpayer_name: 'Edgewater Ventures Inc',
    taxpayer_id: '861234567',
    is_purchaser: true,
    other_party_name: 'ABC Target Corp',
    other_party_id: '123456789',
    other_party_address: '100 Seller St',
    other_party_city: 'Dallas, TX 75201',
    date_of_sale: '03/15/2025',
    total_sales_price: 2000000,
    class_i_fmv: 50000,      class_i_alloc: 50000,
    class_ii_fmv: 100000,    class_ii_alloc: 100000,
    class_iii_fmv: 200000,   class_iii_alloc: 200000,
    class_iv_fmv: 300000,    class_iv_alloc: 300000,
    class_v_fmv: 500000,     class_v_alloc: 500000,
    class_vi_vii_fmv: 350000, class_vi_vii_alloc: 850000,
    has_allocation_agreement: true,
    fmv_amounts_agreed: true,
    has_covenant: false,
  })

  console.log('  Computed:', JSON.stringify(acq.computed, null, 2))
  check('total_fmv', acq.computed.total_fmv, 1500000)
  check('total_allocation', acq.computed.total_allocation, 2000000)
  check('allocation_matches_price', acq.computed.allocation_matches_price, true)
  check('goodwill', acq.computed.goodwill, 500000)  // 850000 alloc - 350000 FMV

  // ═══ PDF Builder Tests ═══
  console.log('\n=== PDF Fill Tests ===')
  mkdirSync('output', { recursive: true })

  try {
    const { pdf: pdf4562, filled: f1, missed: m1 } = await build4562Pdf(depr.inputs, depr, 2025)
    const bytes1 = await pdf4562.save()
    writeFileSync('output/test_4562_2025.pdf', Buffer.from(bytes1))
    console.log(`  4562: filled ${f1} fields, missed ${m1.length} [${m1.join(', ')}]`)
    console.log('  -> saved to output/test_4562_2025.pdf')
  } catch (e: any) {
    console.log(`  4562: ERROR — ${e.message}`)
    fail++
  }

  try {
    const { pdf: pdf8594, filled: f2, missed: m2 } = await build8594Pdf(acq.inputs, acq, 2025)
    const bytes2 = await pdf8594.save()
    writeFileSync('output/test_8594_2025.pdf', Buffer.from(bytes2))
    console.log(`  8594: filled ${f2} fields, missed ${m2.length} [${m2.join(', ')}]`)
    console.log('  -> saved to output/test_8594_2025.pdf')
  } catch (e: any) {
    console.log(`  8594: ERROR — ${e.message}`)
    fail++
  }

  console.log(`\n${'='.repeat(40)}`)
  console.log(`Results: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
