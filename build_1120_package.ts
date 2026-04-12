/**
 * Build Complete 1120 Package — 2023 & 2024
 *
 * Textract → Mapper → Engine → Deterministic PDF Fill → Merged Package
 *
 * Forms included:
 *   1. Form 1120 (6 pages: P1 + Sched C + Sched J + Sched K + Sched L/M-1/M-2)
 *   2. Form 1125-A (COGS)
 *   3. Schedule G (Ownership)
 *   4. Form 4562 (Depreciation)
 *   5. Other Deductions Statement (generated page)
 */

import { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { mapToCanonical, type TextractOutput } from './json_model_mapper.js'
import { calc1120 } from './tax_engine.js'
import { PDF_FIELD_MAP_1120 } from './pdf_field_map.js'

const OUT_DIR = 'tax-api/output'

// ─────────────────────────────────────────────────────────────
// DATA FOR EACH YEAR
// ─────────────────────────────────────────────────────────────

interface YearData {
  year: number
  textractPath: string
  // Schedule K answers (Yes=0 index, No=1 index for checkbox pairs)
  schedK: Record<string, 'yes' | 'no'>
  // Schedule G ownership
  owners: Array<{ name: string; ssn: string; country: string; pct: string }>
  // Other deductions detail
  otherDeductions: Array<[string, number]>
  // COGS other costs detail
  cogsOtherCosts: Array<[string, number]>
  // Preparer info
  preparer: { name: string; ptin: string; firmName: string; firmEin: string; firmAddr: string; phone: string }
  // Overrides (values textract might miss or get wrong)
  overrides?: Record<string, string | number>
}

const YEAR_2024: YearData = {
  year: 2024,
  textractPath: 'tax_documents/_textract_output/C-Corp Tax REturns/2024 Tax Return - Edgewater Ventures Inc-2.json',
  schedK: {
    'K1_method': 'accrual', 'K3_subsidiary': 'no',
    'K4a_foreign_own': 'yes', 'K4b_individual_own': 'yes',
    'K5a_own_foreign': 'yes', 'K5b_own_partnership': 'yes',
    'K6_dividends': 'no', 'K7_foreign_25pct': 'no',
    'K13_receipts_250k': 'no', 'K14_utp': 'no', 'K15a_1099': 'no',
    'K16_ownership_change': 'no', 'K17_dispose_65pct': 'no',
    'K18_351_transfer': 'no', 'K19_payments': 'no', 'K20_cooperative': 'no',
    'K21_267a': 'no', 'K22_500m': 'no', 'K23_163j': 'no', 'K24_8990': 'no',
    'K25_qof': 'no', 'K26_foreign_acq': 'no', 'K27_digital_asset': 'no',
    'K28_controlled_group': 'no', 'K29a_59k': 'no', 'K29c_safe_harbor': 'no',
    'K30a_repurchase': 'no', 'K30b_foreign_corp': 'no', 'K31_consolidated': 'no',
  },
  owners: [{ name: 'MANSOOR RAZZAQ', ssn: '***-**-8263', country: 'US', pct: '100%' }],
  otherDeductions: [
    ['Amortization', 39_333], ['Auto expense', 6_785], ['Bank charges', 687],
    ['Dues and subscriptions', 51_148], ['Gifts', 114], ['Insurance', 5_658],
    ['Legal and professional', 938], ['Meals', 3_696], ['Miscellaneous', 11],
    ['Office expense', 20_318], ['Supplies', 285], ['Travel', 15_819],
    ['Utilities', 7_198], ['Conferences', 528], ['Internet service', 11_309],
    ['Payroll service fees', 70], ['Website', 1_923],
  ],
  cogsOtherCosts: [
    ['Data Scraping and Feed', 10_060], ['Email Service Providers', 53_400], ['Merchant Account Fees', 21_810],
  ],
  preparer: {
    name: 'Eldar Aliey Mata', ptin: 'P01636299', firmName: 'Mata & Baker Tax Consultants LLC',
    firmEin: '81-4276656', firmAddr: '80 SW 8th St Miami FL 33130', phone: '(305) 467-9847',
  },
}

const YEAR_2023: YearData = {
  year: 2023,
  textractPath: 'tax_documents/_textract_output/C-Corp Tax REturns/2023 Tax Return - Edgewater Ventures - Signed.json',
  schedK: {
    'K1_method': 'accrual', 'K3_subsidiary': 'no',
    'K4a_foreign_own': 'yes', 'K4b_individual_own': 'yes',
    'K5a_own_foreign': 'yes', 'K5b_own_partnership': 'yes',
    'K6_dividends': 'no', 'K7_foreign_25pct': 'no',
    'K13_receipts_250k': 'no', 'K14_utp': 'no', 'K15a_1099': 'no',
    'K16_ownership_change': 'no', 'K17_dispose_65pct': 'no',
    'K18_351_transfer': 'no', 'K19_payments': 'no', 'K20_cooperative': 'no',
    'K21_267a': 'no', 'K22_500m': 'no', 'K23_163j': 'no', 'K24_8990': 'no',
    'K25_qof': 'no', 'K26_foreign_acq': 'no', 'K27_digital_asset': 'no',
    'K28_controlled_group': 'no', 'K29a_59k': 'no', 'K29c_safe_harbor': 'no',
    'K30a_repurchase': 'no', 'K30b_foreign_corp': 'no', 'K31_consolidated': 'no',
  },
  owners: [{ name: 'MANSOOR RAZZAQ', ssn: '***-**-8263', country: 'US', pct: '100%' }],
  otherDeductions: [
    ['Amortization', 39_333], ['Auto expense', 6_137], ['Bank charges', 685],
    ['Dues and subscriptions', 77_704], ['Insurance', 7_021],
    ['Legal and professional', 14_730], ['Meals', 5_686], ['Miscellaneous', 39],
    ['Office expense', 56_143], ['Supplies', 293], ['Travel', 30_756],
    ['Utilities', 5_638], ['Recruiting expense', 5_760], ['Website', 1_539],
    ['Payroll service fees', 1_383],
  ],
  cogsOtherCosts: [
    ['Email Service Providers', 136_420], ['Data Scraping', 22_911], ['Merchant Account Fees', 28_569],
  ],
  preparer: {
    name: 'Eldar Aliey Mata', ptin: 'P01636299', firmName: 'Mata & Baker Tax Consultants LLC',
    firmEin: '81-4276656', firmAddr: '80 SW 8th St Miami FL 33130', phone: '(305) 467-9847',
  },
  overrides: {
    // 2023 has NOL deduction
    'tax.L29a_nol': 37_329,
  },
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function findField(form: any, shortId: string): PDFTextField | null {
  for (const f of form.getFields())
    if (f.getName().includes(shortId + '[') && f instanceof PDFTextField) return f
  return null
}

function setField(form: any, shortId: string, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return
  const field = findField(form, shortId)
  if (!field) return
  const str = typeof value === 'number'
    ? (value === 0 ? '' : value.toLocaleString()) : String(value)
  if (!str) return
  const maxLen = field.getMaxLength()
  if (maxLen !== undefined && str.length > maxLen) field.setMaxLength(str.length)
  field.setText(str)
}

function parseBSVal(s: string): number {
  if (!s) return 0
  const n = parseFloat(s.replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1').replace(/\.$/, ''))
  return isNaN(n) ? 0 : Math.round(Math.abs(n))
}

// ─────────────────────────────────────────────────────────────
// BUILD PACKAGE FOR A GIVEN YEAR
// ─────────────────────────────────────────────────────────────

async function buildPackage(yd: YearData) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Building ${yd.year} Form 1120 Package — Edgewater Ventures Inc`)
  console.log(`${'═'.repeat(60)}`)

  // 1. INTAKE
  const raw = JSON.parse(readFileSync(yd.textractPath, 'utf-8'))
  const mapped = mapToCanonical({
    source: 'textract', form_type: '1120', tax_year: yd.year,
    key_value_pairs: raw.key_value_pairs,
  })
  console.log(`  Mapper: ${mapped.stats.mapped} fields from ${raw.key_value_pairs.length} KV pairs`)

  // 2. BUILD MODEL
  const model: Record<string, string | number> = {}
  for (const f of mapped.fields) {
    if (f.value !== null && f.value !== undefined) model[f.canonical_key] = f.value
  }

  // Apply overrides
  if (yd.overrides) {
    for (const [k, v] of Object.entries(yd.overrides)) model[k] = v
  }

  // Schedule L from tables
  const schedLTable = raw.tables.find((t: any[]) => t[0] && String(t[0]).includes('Schedule L Balance Sheets'))
  if (schedLTable) {
    const lineMap: Record<string, string[]> = {
      '1': ['schedL.L1_cash_boy_b', 'schedL.L1_cash_eoy_d'],
      '6': ['schedL.L6_othercurr_boy_b', 'schedL.L6_othercurr_eoy_d'],
      '7': ['schedL.L7_loans_boy_b', 'schedL.L7_loans_eoy_d'],
      '14': ['schedL.L14_other_boy_b', 'schedL.L14_other_eoy_d'],
      '15': ['schedL.L15_total_boy_b', 'schedL.L15_total_eoy_d'],
      '17': ['schedL.L17_mortshort_boy_b', 'schedL.L17_mortshort_eoy_d'],
      '20': ['schedL.L20_mortlong_boy_b', 'schedL.L20_mortlong_eoy_d'],
      '23': ['schedL.L23_paidin_boy_b', 'schedL.L23_paidin_eoy_d'],
      '25': ['schedL.L25_retained_boy_b', 'schedL.L25_retained_eoy_d'],
      '28': ['schedL.L28_total_boy_b', 'schedL.L28_total_eoy_d'],
    }
    for (const row of schedLTable) {
      if (!Array.isArray(row) || row.length < 6) continue
      const line = String(row[0]).trim()
      const label = String(row[1]).toLowerCase()
      const [a, b, c, d] = [parseBSVal(row[2]), parseBSVal(row[3]), parseBSVal(row[4]), parseBSVal(row[5])]
      if (line === 'b' && label.includes('accumulated depreciation')) {
        if (a) model['schedL.L10b_dep_boy_a'] = a; if (b) model['schedL.L10b_dep_boy_b'] = b
        if (c) model['schedL.L10b_dep_eoy_c'] = c; if (d) model['schedL.L10b_dep_eoy_d'] = d
      } else if (line === 'b' && label.includes('accumulated amortization')) {
        if (a) model['schedL.L13b_amort_boy_a'] = a; if (b) model['schedL.L13b_amort_boy_b'] = b
        if (c) model['schedL.L13b_amort_eoy_c'] = c; if (d) model['schedL.L13b_amort_eoy_d'] = d
      } else if (line === '10a') {
        if (a) model['schedL.L10a_bldg_boy_a'] = a; if (c) model['schedL.L10a_bldg_eoy_c'] = c
      } else if (line === '13a') {
        if (a) model['schedL.L13a_intang_boy_a'] = a; if (c) model['schedL.L13a_intang_eoy_c'] = c
      } else if (lineMap[line]) {
        const keys = lineMap[line]
        if (b) model[keys[0]] = b; if (d) model[keys[1]] = d
      }
    }
  }

  model['meta.title'] = 'PRESIDENT'
  const getNum = (key: string): number => { const v = model[key]; return typeof v === 'number' ? v : 0 }

  // 3. VALIDATE
  const er = calc1120({
    gross_receipts: getNum('income.L1a_gross_receipts'), returns_allowances: getNum('income.L1b_returns'),
    cost_of_goods_sold: getNum('income.L2_cogs'), dividends: getNum('income.L4_dividends'),
    interest_income: getNum('income.L5_interest'), gross_rents: getNum('income.L6_gross_rents'),
    gross_royalties: getNum('income.L7_gross_royalties'), capital_gains: getNum('income.L8_capital_gains'),
    net_gain_4797: getNum('income.L9_net_gain_4797'), other_income: getNum('income.L10_other_income'),
    officer_compensation: getNum('deductions.L12_officer_comp'), salaries_wages: getNum('deductions.L13_salaries'),
    repairs_maintenance: getNum('deductions.L14_repairs'), bad_debts: getNum('deductions.L15_bad_debts'),
    rents: getNum('deductions.L16_rents'), taxes_licenses: getNum('deductions.L17_taxes_licenses'),
    interest_expense: getNum('deductions.L18_interest'), charitable_contrib: getNum('deductions.L19_charitable'),
    depreciation: getNum('deductions.L20_depreciation'), depletion: getNum('deductions.L21_depletion'),
    advertising: getNum('deductions.L22_advertising'), pension_plans: getNum('deductions.L23_pension'),
    employee_benefits: getNum('deductions.L24_employee_benefits'), other_deductions: getNum('deductions.L26_other_deductions'),
    nol_deduction: getNum('tax.L29a_nol'), special_deductions: getNum('tax.L29b_special_ded'),
    estimated_tax_paid: getNum('schedJ.J13_prior_overpayment') + getNum('schedJ.J14_estimated_payments'),
    tax_year: yd.year,
  })
  const taxMatch = er.computed.income_tax === getNum('schedJ.J1a_income_tax')
  console.log(`  Engine: tax=${er.computed.income_tax.toLocaleString()} ${taxMatch ? '✓' : '✗'} overpayment=${er.computed.overpayment.toLocaleString()}`)

  // 4. FILL MAIN 1120
  const mainPdf = await PDFDocument.load(readFileSync('tax-api/irs_forms/f1120_2024.pdf'))
  const mainForm = mainPdf.getForm()
  let filled = 0
  for (const [key, value] of Object.entries(model)) {
    const fieldId = PDF_FIELD_MAP_1120[key]
    if (fieldId) { setField(mainForm, fieldId, value); filled++ }
  }

  // Schedule K checkboxes
  for (const f of mainForm.getFields()) {
    const name = f.getName()
    if (!(f instanceof PDFCheckBox)) continue
    // Page 4 checkboxes
    if (name.includes('c4_1[1]')) f.check() // Accrual
    if (name.includes('c4_2[1]')) f.check() // K3 No
    if (name.includes('c4_3[0]')) f.check() // K4a Yes
    if (name.includes('c4_4[0]')) f.check() // K4b Yes
    if (name.includes('c4_5[0]')) f.check() // K5a Yes
    if (name.includes('c4_6[0]')) f.check() // K5b Yes
    if (name.includes('c4_7[1]')) f.check() // K6 No
    if (name.includes('c4_8[1]')) f.check() // K7 No
    // Page 5 checkboxes — all No
    for (let i = 1; i <= 24; i++) {
      if (name.includes(`c5_${i}[1]`)) f.check()
    }
  }

  // Preparer
  setField(mainForm, 'f1_53', yd.preparer.name)
  setField(mainForm, 'f1_55', yd.preparer.ptin)
  setField(mainForm, 'f1_56', yd.preparer.firmName)
  setField(mainForm, 'f1_57', yd.preparer.firmEin)
  setField(mainForm, 'f1_58', yd.preparer.firmAddr)

  console.log(`  1120: ${filled} fields + Sched K checkboxes + preparer`)

  // 5. FILL 1125-A
  const cogsPdf = await PDFDocument.load(readFileSync('tax-api/irs_forms/f1125a_2024.pdf'))
  const cogsForm = cogsPdf.getForm()
  setField(cogsForm, 'f1_1', 'EDGEWATER VENTURES INC')
  setField(cogsForm, 'f1_2', '83-1889553')
  setField(cogsForm, 'f1_7', getNum('cogs.L3_labor'))
  setField(cogsForm, 'f1_11', getNum('cogs.L5_other'))
  setField(cogsForm, 'f1_13', getNum('cogs.L6_total'))
  setField(cogsForm, 'f1_17', getNum('cogs.L8_cogs'))
  console.log(`  1125-A: filled`)

  // 6. FILL SCHEDULE G
  const sgPdf = await PDFDocument.load(readFileSync('tax-api/irs_forms/f1120sg_2024.pdf'))
  const sgForm = sgPdf.getForm()
  setField(sgForm, 'f1_1_0_', 'EDGEWATER VENTURES INC')
  setField(sgForm, 'f1_3_0_', '83-1889553')
  // Row 1: Owner
  const owner = yd.owners[0]
  setField(sgForm, 'f1_4_0_', owner.name)
  setField(sgForm, 'f1_5_0_', owner.ssn)
  setField(sgForm, 'f1_6_0_', owner.country)
  setField(sgForm, 'f1_7_0_', owner.pct)
  console.log(`  Schedule G: filled`)

  // 7. FILL 4562
  const depPdf = await PDFDocument.load(readFileSync('tax-api/irs_forms/f4562_2024.pdf'))
  const depForm = depPdf.getForm()
  setField(depForm, 'f1_1', 'EDGEWATER VENTURES INC')
  setField(depForm, 'f1_2', `Form 1120 COMPUTER OR IT RELAT`)
  setField(depForm, 'f1_3', '83-1889553')
  setField(depForm, 'f1_4', 1_220_000)
  setField(depForm, 'f1_6', 3_050_000)
  setField(depForm, 'f1_21', 0)
  setField(depForm, 'f1_22', getNum('dep.L17_macrs_prior'))
  setField(depForm, 'f1_25', getNum('dep.L22_total'))
  setField(depForm, 'f2_57', getNum('dep.L43_amortization'))
  setField(depForm, 'f2_58', getNum('dep.L44_total_amort'))
  console.log(`  4562: filled`)

  // 8. GENERATE OTHER DEDUCTIONS STATEMENT
  const stmtPdf = await PDFDocument.create()
  const font = await stmtPdf.embedFont(StandardFonts.Courier)
  const boldFont = await stmtPdf.embedFont(StandardFonts.CourierBold)

  function addStatementPage(title: string, items: Array<[string, number]>, totalLabel: string): PDFPage {
    const page = stmtPdf.addPage([612, 792])
    let y = 740
    const draw = (text: string, x: number, yy: number, f: PDFFont = font, size = 10) =>
      page.drawText(text, { x, y: yy, font: f, size, color: rgb(0, 0, 0) })

    draw('EDGEWATER VENTURES INC', 50, y, boldFont, 12); y -= 15
    draw('EIN: 83-1889553', 50, y); y -= 15
    draw(`Tax Year ${yd.year}`, 50, y); y -= 25
    draw(title, 50, y, boldFont, 11); y -= 20
    draw('-'.repeat(65), 50, y); y -= 15

    let total = 0
    for (const [desc, amt] of items) {
      draw(desc, 60, y)
      draw(amt.toLocaleString().padStart(12), 430, y)
      total += amt
      y -= 14
    }
    y -= 5
    draw('-'.repeat(65), 50, y); y -= 15
    draw(totalLabel, 60, y, boldFont)
    draw(total.toLocaleString().padStart(12), 430, y, boldFont)
    return page
  }

  addStatementPage(
    'Form 1120, Line 26 — Other Deductions',
    yd.otherDeductions,
    'Total Other Deductions'
  )

  addStatementPage(
    'Form 1125-A, Line 5 — Other Costs (COGS)',
    yd.cogsOtherCosts,
    'Total Other Costs'
  )

  console.log(`  Statements: 2 pages generated`)

  // 9. MERGE INTO PACKAGE
  const merged = await PDFDocument.create()

  async function appendFrom(src: PDFDocument) {
    const pages = await merged.copyPages(src, src.getPageIndices())
    pages.forEach(p => merged.addPage(p))
  }

  await appendFrom(mainPdf)      // 1120 (6 pages)
  await appendFrom(cogsPdf)      // 1125-A (1 page)
  await appendFrom(sgPdf)        // Schedule G (2 pages)
  await appendFrom(depPdf)       // 4562 (2 pages)
  await appendFrom(stmtPdf)      // Statements (2 pages)

  const outPath = `${OUT_DIR}/1120_${yd.year}_EV_package.pdf`
  writeFileSync(outPath, await merged.save())

  console.log(`\n  ✓ Package saved: ${outPath} (${merged.getPageCount()} pages)`)
  console.log(`    ├ Form 1120      (6 pages)`)
  console.log(`    ├ Form 1125-A    (1 page)`)
  console.log(`    ├ Schedule G     (2 pages)`)
  console.log(`    ├ Form 4562      (2 pages)`)
  console.log(`    └ Statements     (2 pages)`)

  return outPath
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const path2024 = await buildPackage(YEAR_2024)
  const path2023 = await buildPackage(YEAR_2023)

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  DONE — Both packages built`)
  console.log(`  2024: ${path2024}`)
  console.log(`  2023: ${path2023}`)
  console.log(`${'═'.repeat(60)}`)
}

main()
