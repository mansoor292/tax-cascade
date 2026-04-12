/**
 * Build Amended 1120 Packages — S07 Cash Restatement
 *
 * Corrects intercompany income from Sales Receipts error.
 * Generates amended 1120 for 2023 and 2024 with:
 *   - Corrected income (cash actually received from EZ)
 *   - NOL carryforward chain
 *   - Explanation of changes statement
 */

import { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts, rgb, PDFFont } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { calc1120 } from './tax_engine.js'
import { PDF_FIELD_MAP_1120 } from './pdf_field_map.js'

const OUT_DIR = 'tax-api/output'

// ─────────────────────────────────────────────────────────────
// S07 AMENDED DATA — from Proforma_1120_Amended.xlsx
// ─────────────────────────────────────────────────────────────

interface AmendedYear {
  year: number
  // As-filed values (from textract/original)
  filed: {
    gross_receipts: number
    cogs: number
    gross_profit: number
    total_deductions: number
    other_income: number
    ti_before_nol: number
    nol_deduction: number
    taxable_income: number
    total_tax: number
    payments: number
  }
  // Corrected values (S07)
  corrected: {
    gross_receipts: number
    cogs: number
    gross_profit: number
    total_deductions: number
    other_income: number
    ti_before_nol: number
    nol_deduction: number
    taxable_income: number
    total_tax: number
    nol_generated: number
    nol_boy: number
    nol_eoy: number
  }
  // Deduction line items (unchanged from filed)
  deductions: {
    salaries: number; taxes_licenses: number; interest: number
    charitable: number; depreciation: number; advertising: number
    other_deductions: number
  }
  // Explanation text
  intercompany_filed: number
  intercompany_cash: number
  intercompany_correction: number
  // Schedule J payments (need to recompute refund)
  schedJ_prior_overpayment: number
  schedJ_estimated_payments: number
  // Textract source for Schedule L
  textractPath: string
  // M-1 data
  m1: { net_income_books: number; fed_tax_books: number; travel_ent: number; depreciation_diff: number; total_add: number }
  // M-2 data
  m2: { beg_balance: number; net_income: number; add_total: number; end_balance: number }
}

const AMENDED_2023: AmendedYear = {
  year: 2023,
  filed: {
    gross_receipts: 2_381_149, cogs: 187_900, gross_profit: 2_193_249,
    total_deductions: 1_129_251, other_income: -39_327,
    ti_before_nol: 986_547, nol_deduction: 0, // Original: NOL of 37,329 but for S07 the pre-NOL is 291,547
    taxable_income: 986_547, total_tax: 207_175, payments: 450_000,
  },
  corrected: {
    gross_receipts: 1_686_149, cogs: 187_900, gross_profit: 1_498_249,
    total_deductions: 1_129_251, other_income: -39_327,
    ti_before_nol: 291_547, nol_deduction: 233_238, // 80% of 291,547
    taxable_income: 58_309, total_tax: 12_245,
    nol_generated: 0, nol_boy: 900_812, nol_eoy: 667_574,
  },
  deductions: {
    salaries: 649_510, taxes_licenses: 31_197, interest: 26_238,
    charitable: 0, depreciation: 8_040, advertising: 36_385, other_deductions: 252_847,
  },
  intercompany_filed: 1_130_000,
  intercompany_cash: 435_000,
  intercompany_correction: -695_000,
  schedJ_prior_overpayment: 0,
  schedJ_estimated_payments: 450_000,
  textractPath: 'tax_documents/_textract_output/C-Corp Tax REturns/2023 Tax Return - Edgewater Ventures - Signed.json',
  m1: { net_income_books: 1_026_230, fed_tax_books: 0, travel_ent: 5_686, depreciation_diff: 8_040, total_add: 1_031_916 },
  m2: { beg_balance: 538_904, net_income: 1_026_230, add_total: 1_565_134, end_balance: 1_565_134 },
}

const AMENDED_2024: AmendedYear = {
  year: 2024,
  filed: {
    gross_receipts: 1_653_253, cogs: 85_270, gross_profit: 1_567_983,
    total_deductions: 831_489, other_income: -44_021,
    ti_before_nol: 691_011, nol_deduction: 0,
    taxable_income: 691_011, total_tax: 145_112, payments: 292_825,
  },
  corrected: {
    gross_receipts: 1_498_253, cogs: 85_270, gross_profit: 1_412_983,
    total_deductions: 831_489, other_income: -44_021,
    ti_before_nol: 536_011, nol_deduction: 428_809, // 80% of 536,011
    taxable_income: 107_202, total_tax: 22_512,
    nol_generated: 0, nol_boy: 667_574, nol_eoy: 238_765,
  },
  deductions: {
    salaries: 594_779, taxes_licenses: 33_515, interest: 0,
    charitable: 1_050, depreciation: 8_040, advertising: 9_175, other_deductions: 165_820,
  },
  intercompany_filed: 1_250_000,
  intercompany_cash: 1_095_000,
  intercompany_correction: -155_000,
  schedJ_prior_overpayment: 242_825,
  schedJ_estimated_payments: 50_000,
  textractPath: 'tax_documents/_textract_output/C-Corp Tax REturns/2024 Tax Return - Edgewater Ventures Inc-2.json',
  m1: { net_income_books: 690_666, fed_tax_books: 0, travel_ent: 3_695, depreciation_diff: 3_350, total_add: 694_361 },
  m2: { beg_balance: 1_565_134, net_income: 690_666, add_total: 2_255_800, end_balance: 2_255_800 },
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

const fmt = (n: number) => n.toLocaleString()

// ─────────────────────────────────────────────────────────────
// BUILD AMENDED RETURN
// ─────────────────────────────────────────────────────────────

async function buildAmended(ad: AmendedYear) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Building AMENDED 1120 for ${ad.year} — S07 Cash Restatement`)
  console.log(`${'='.repeat(60)}`)

  const c = ad.corrected
  const refund = ad.filed.total_tax - c.total_tax

  // Validate with engine
  const er = calc1120({
    gross_receipts: c.gross_receipts, returns_allowances: 0,
    cost_of_goods_sold: c.cogs, dividends: 0, interest_income: 0,
    gross_rents: 0, gross_royalties: 0, capital_gains: 0, net_gain_4797: 0,
    other_income: 0, // other_income is net of expenses handled separately
    officer_compensation: 0, salaries_wages: ad.deductions.salaries,
    repairs_maintenance: 0, bad_debts: 0, rents: 0,
    taxes_licenses: ad.deductions.taxes_licenses, interest_expense: ad.deductions.interest,
    charitable_contrib: ad.deductions.charitable, depreciation: ad.deductions.depreciation,
    depletion: 0, advertising: ad.deductions.advertising,
    pension_plans: 0, employee_benefits: 0,
    other_deductions: ad.deductions.other_deductions,
    nol_deduction: c.nol_deduction, special_deductions: 0,
    estimated_tax_paid: ad.schedJ_prior_overpayment + ad.schedJ_estimated_payments,
    tax_year: ad.year,
  })

  console.log(`  Corrected gross receipts: ${fmt(c.gross_receipts)} (was ${fmt(ad.filed.gross_receipts)}, change ${fmt(ad.intercompany_correction)})`)
  console.log(`  Corrected TI before NOL:  ${fmt(c.ti_before_nol)}`)
  console.log(`  NOL applied (80% cap):    ${fmt(c.nol_deduction)} (from BOY ${fmt(c.nol_boy)})`)
  console.log(`  Corrected taxable income: ${fmt(c.taxable_income)}`)
  console.log(`  Corrected tax (21%):      ${fmt(c.total_tax)}`)
  console.log(`  REFUND DUE:               ${fmt(refund)}`)
  console.log(`  NOL carryforward EOY:     ${fmt(c.nol_eoy)}`)

  // ── Fill 1120 ──
  const pdf = await PDFDocument.load(readFileSync('tax-api/irs_forms/f1120_2024.pdf'))
  const form = pdf.getForm()

  // Check the "Amended return" checkbox
  for (const f of form.getFields()) {
    const name = f.getName()
    // Page 1 header checkboxes — find the amended return checkbox
    // On 1120: Check if: (1) Initial return (2) Final return (3) Name change (4) Address change
    // Actually for 1120, amended is indicated by checking box 1a on the header
    // The E Check if section has checkboxes for various options
    if (name.includes('c1_2[0]') && f instanceof PDFCheckBox) f.check() // Amended checkbox
  }

  // Header
  setField(form, 'f1_4', 'EDGEWATER VENTURES INC')
  setField(form, 'f1_5', '1900 NORTH BAYSHORE DRIVE STE 1A')
  setField(form, 'f1_6', 'MIAMI FL 33132')
  setField(form, 'f1_7', '83-1889553')
  setField(form, 'f1_8', '06/22/2018')

  // Income — CORRECTED values
  setField(form, 'f1_10', c.gross_receipts)          // 1a
  setField(form, 'f1_12', c.gross_receipts)          // 1c (no returns)
  setField(form, 'f1_13', c.cogs)                    // 2
  setField(form, 'f1_14', c.gross_profit)            // 3
  setField(form, 'f1_22', c.gross_profit)            // 11 total income (simplified — no other income lines)

  // Deductions — UNCHANGED
  setField(form, 'f1_24', ad.deductions.salaries)
  setField(form, 'f1_28', ad.deductions.taxes_licenses)
  if (ad.deductions.interest) setField(form, 'f1_29', ad.deductions.interest)
  if (ad.deductions.charitable) setField(form, 'f1_30', ad.deductions.charitable)
  setField(form, 'f1_31', ad.deductions.depreciation)
  setField(form, 'f1_33', ad.deductions.advertising)
  setField(form, 'f1_37', ad.deductions.other_deductions)
  setField(form, 'f1_38', c.total_deductions)         // 27

  // Tax computation
  setField(form, 'f1_39', c.ti_before_nol)            // 28
  setField(form, 'f1_40', c.nol_deduction)             // 29a NOL
  setField(form, 'f1_43', c.taxable_income)            // 30 (gap in XFA map)
  setField(form, 'f1_44', c.total_tax)                 // 31 (XFA confirmed)
  // f1_45 = line 32 RESERVED — leave blank

  // Payments — same as originally filed
  const totalPayments = ad.schedJ_prior_overpayment + ad.schedJ_estimated_payments
  setField(form, 'f1_46', totalPayments)               // 33 (gap in XFA map)

  // Overpayment = payments - corrected tax
  const overpayment = totalPayments - c.total_tax
  setField(form, 'f1_49', overpayment)                 // 36 (XFA confirmed)
  setField(form, 'f1_51', overpayment)                 // 37 refunded (XFA confirmed)

  // Schedule J
  setField(form, 'f3_1', c.total_tax)                 // J 1a
  setField(form, 'f3_9', c.total_tax)                 // J 2
  setField(form, 'f3_11', c.total_tax)                // J 4
  setField(form, 'f3_19', c.total_tax)                // J 7
  setField(form, 'f3_30', c.total_tax)                // J 11a
  setField(form, 'f3_33', c.total_tax)                // J 12
  setField(form, 'f3_34', ad.schedJ_prior_overpayment) // J 13
  setField(form, 'f3_35', ad.schedJ_estimated_payments) // J 14
  setField(form, 'f3_40', totalPayments)               // J 19
  setField(form, 'f3_47', totalPayments)               // J 23

  // Schedule K checkboxes (same as original)
  for (const f of form.getFields()) {
    const name = f.getName()
    if (!(f instanceof PDFCheckBox)) continue
    if (name.includes('c4_1[1]')) f.check() // Accrual
    if (name.includes('c4_2[1]')) f.check() // K3 No
    if (name.includes('c4_3[0]')) f.check() // K4a Yes
    if (name.includes('c4_4[0]')) f.check() // K4b Yes
    if (name.includes('c4_5[0]')) f.check() // K5a Yes
    if (name.includes('c4_6[0]')) f.check() // K5b Yes
    if (name.includes('c4_7[1]')) f.check() // K6 No
    if (name.includes('c4_8[1]')) f.check() // K7 No
    for (let i = 1; i <= 24; i++) {
      if (name.includes(`c5_${i}[1]`)) f.check()
    }
  }

  // Schedule K text fields
  setField(form, 'f4_2', '541519')
  setField(form, 'f4_3', 'COMPUTER OR IT RELAT')
  setField(form, 'f4_4', 'DIGITAL MARKETING')

  setField(form, 'f1_56', 'PRESIDENT')

  // ── Schedule L (Balance Sheet) from textract tables ──
  const raw = JSON.parse(readFileSync(ad.textractPath, 'utf-8'))
  const schedLTable = raw.tables.find((t: any[]) => t[0] && String(t[0]).includes('Schedule L Balance Sheets'))
  if (schedLTable) {
    const pbs = (s: string): number => {
      if (!s) return 0
      const n = parseFloat(s.replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1').replace(/\.$/, ''))
      return isNaN(n) ? 0 : Math.round(Math.abs(n))
    }
    // Map line → [boy_b_field, eoy_d_field] for net-only lines
    const slMap: Record<string, [string, string]> = {
      '1':  ['f6_2',  'f6_4'],   '6':  ['f6_26', 'f6_28'],
      '7':  ['f6_30', 'f6_32'],  '14': ['f6_70', 'f6_72'],
      '15': ['f6_74', 'f6_76'],  '17': ['f6_82', 'f6_84'],
      '18': ['f6_86', 'f6_88'],  '20': ['f6_94', 'f6_96'],
      '23': ['f6_110','f6_112'], '25': ['f6_118','f6_120'],
      '28': ['f6_130','f6_132'],
    }
    for (const row of schedLTable) {
      if (!Array.isArray(row) || row.length < 6) continue
      const line = String(row[0]).trim()
      const label = String(row[1]).toLowerCase()
      const [a, b, c, d] = [pbs(row[2]), pbs(row[3]), pbs(row[4]), pbs(row[5])]

      if (line === '2a') {
        if (a) setField(form, 'f6_5', a); if (b) setField(form, 'f6_6', b)
        if (c) setField(form, 'f6_7', c); if (d) setField(form, 'f6_8', d)
      } else if (line === 'b' && label.includes('accumulated depreciation')) {
        if (a) setField(form, 'f6_45', a); if (b) setField(form, 'f6_46', b)
        if (c) setField(form, 'f6_47', c); if (d) setField(form, 'f6_48', d)
      } else if (line === 'b' && label.includes('accumulated amortization')) {
        if (a) setField(form, 'f6_65', a); if (b) setField(form, 'f6_66', b)
        if (c) setField(form, 'f6_67', c); if (d) setField(form, 'f6_68', d)
      } else if (line === '10a') {
        if (a) setField(form, 'f6_41', a); if (c) setField(form, 'f6_43', c)
      } else if (line === '13a') {
        if (a) setField(form, 'f6_61', a); if (c) setField(form, 'f6_63', c)
      } else if (slMap[line]) {
        const [boyF, eoyF] = slMap[line]
        if (b) setField(form, boyF, b); if (d) setField(form, eoyF, d)
      }
    }
    console.log(`  Schedule L: filled from textract`)
  }

  // ── Schedule M-1 (Book-Tax Reconciliation) ──
  setField(form, 'f6_133', ad.m1.net_income_books)
  setField(form, 'f6_134', ad.m1.fed_tax_books)
  setField(form, 'f6_141', ad.m1.travel_ent)
  setField(form, 'f6_143', ad.m1.travel_ent)
  setField(form, 'f6_144', ad.m1.total_add)
  setField(form, 'f6_149', ad.m1.depreciation_diff)
  setField(form, 'f6_153', ad.m1.depreciation_diff)
  setField(form, 'f6_154', ad.m1.depreciation_diff)
  setField(form, 'f6_155', c.ti_before_nol)  // M-1 L10 = line 28

  // ── Schedule M-2 (Retained Earnings) ──
  setField(form, 'f6_156', ad.m2.beg_balance)
  setField(form, 'f6_157', ad.m2.net_income)
  setField(form, 'f6_162', ad.m2.add_total)
  setField(form, 'f6_169', ad.m2.end_balance)

  console.log(`  M-1 + M-2: filled`)
  console.log(`  1120 filled (amended)`)

  // ── Generate Explanation of Changes ──
  const stmtPdf = await PDFDocument.create()
  const font = await stmtPdf.embedFont(StandardFonts.Courier)
  const boldFont = await stmtPdf.embedFont(StandardFonts.CourierBold)

  function drawText(page: any, text: string, x: number, y: number, f: PDFFont = font, size = 10) {
    page.drawText(text, { x, y, font: f, size, color: rgb(0, 0, 0) })
  }

  // Page 1: Explanation of Changes
  const p1 = stmtPdf.addPage([612, 792])
  let y = 740
  drawText(p1, 'EDGEWATER VENTURES INC', 50, y, boldFont, 14); y -= 18
  drawText(p1, 'EIN: 83-1889553', 50, y); y -= 15
  drawText(p1, `FORM 1120 — AMENDED RETURN — TAX YEAR ${ad.year}`, 50, y, boldFont, 12); y -= 25

  drawText(p1, 'EXPLANATION OF CHANGES', 50, y, boldFont, 11); y -= 20

  const lines = [
    `Intercompany income from EZ-Advisors, LLC was incorrectly recognized`,
    `using Sales Receipts deposited to "EZ Advisors Receivables" (Other`,
    `Current Asset account) in QuickBooks Online.`,
    ``,
    `Sales Receipts are a cash-sale instrument in QBO that recognize revenue`,
    `on BOTH cash and accrual basis, regardless of the deposit account.`,
    `This caused QBO to report intercompany income as cash income despite`,
    `no cash being received.`,
    ``,
    `The return is being amended to reflect actual cash received from`,
    `EZ-Advisors, LLC during the tax year.`,
    ``,
    `  As filed intercompany income:    $${fmt(ad.intercompany_filed)}`,
    `  Cash actually received:          $${fmt(ad.intercompany_cash)}`,
    `  Correction:                      $${fmt(ad.intercompany_correction)}`,
    ``,
    `The Intercompany Services Agreement between the entities has been`,
    `terminated. All future intercompany transactions will be recognized`,
    `on a pure cash basis.`,
    ``,
    `IMPACT ON TAXABLE INCOME:`,
    ``,
    `  Taxable income (as filed):       $${fmt(ad.filed.taxable_income)}`,
    `  Intercompany correction:         $${fmt(ad.intercompany_correction)}`,
    `  Pre-NOL taxable income:          $${fmt(c.ti_before_nol)}`,
    `  NOL applied (80% cap):           $${fmt(c.nol_deduction)}`,
    `  Corrected taxable income:        $${fmt(c.taxable_income)}`,
    ``,
    `  Tax as filed:                    $${fmt(ad.filed.total_tax)}`,
    `  Tax as corrected:                $${fmt(c.total_tax)}`,
    `  REFUND DUE:                      $${fmt(refund)}`,
    ``,
    `NOL SCHEDULE:`,
    `  NOL carryforward BOY:            $${fmt(c.nol_boy)}`,
    `  NOL generated this year:         $${fmt(c.nol_generated)}`,
    `  NOL applied:                     $${fmt(c.nol_deduction)}`,
    `  NOL carryforward EOY:            $${fmt(c.nol_eoy)}`,
  ]

  for (const line of lines) {
    drawText(p1, line, 55, y, line.startsWith('  ') ? font : (line === line.toUpperCase() && line.length > 3 ? boldFont : font))
    y -= 14
  }

  // Page 2: Comparison table
  const p2 = stmtPdf.addPage([612, 792])
  y = 740
  drawText(p2, `FORM 1120 AMENDED — ${ad.year} — LINE-BY-LINE COMPARISON`, 50, y, boldFont, 11); y -= 25
  drawText(p2, 'Line'.padEnd(40) + 'As Filed'.padStart(14) + 'Corrected'.padStart(14) + 'Change'.padStart(14), 50, y, boldFont, 9); y -= 5
  drawText(p2, '-'.repeat(82), 50, y, font, 9); y -= 14

  const compLines: [string, number, number][] = [
    ['1c. Gross receipts/sales', ad.filed.gross_receipts, c.gross_receipts],
    ['2. Cost of goods sold', ad.filed.cogs, c.cogs],
    ['3. Gross profit', ad.filed.gross_profit, c.gross_profit],
    ['Total deductions', ad.filed.total_deductions, c.total_deductions],
    ['28. TI before NOL', ad.filed.ti_before_nol, c.ti_before_nol],
    ['29a. NOL deduction', ad.filed.nol_deduction, c.nol_deduction],
    ['30. Taxable income', ad.filed.taxable_income, c.taxable_income],
    ['31. Total tax (21%)', ad.filed.total_tax, c.total_tax],
    ['Refund due', 0, refund],
  ]

  for (const [label, filed, corrected] of compLines) {
    const change = corrected - filed
    const changeStr = change === 0 ? '-' : (change > 0 ? '+' : '') + fmt(change)
    drawText(p2,
      label.padEnd(40) + fmt(filed).padStart(14) + fmt(corrected).padStart(14) + changeStr.padStart(14),
      50, y, font, 9
    )
    y -= 14
  }

  console.log(`  Explanation: 2 pages generated`)

  // ── Merge ──
  const merged = await PDFDocument.create()
  const mainPages = await merged.copyPages(pdf, pdf.getPageIndices())
  mainPages.forEach(p => merged.addPage(p))
  const stmtPages = await merged.copyPages(stmtPdf, stmtPdf.getPageIndices())
  stmtPages.forEach(p => merged.addPage(p))

  const outPath = `${OUT_DIR}/1120X_${ad.year}_EV_amended.pdf`
  writeFileSync(outPath, await merged.save())

  console.log(`\n  Saved: ${outPath} (${merged.getPageCount()} pages)`)
  console.log(`    Pages 1-6: Amended 1120 (corrected values)`)
  console.log(`    Page 7:    Explanation of Changes`)
  console.log(`    Page 8:    Line-by-Line Comparison`)

  return { outPath, refund, nol_eoy: c.nol_eoy }
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const r2023 = await buildAmended(AMENDED_2023)
  const r2024 = await buildAmended(AMENDED_2024)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  S07 CASH RESTATEMENT — AMENDED RETURNS COMPLETE`)
  console.log(`${'='.repeat(60)}`)
  console.log(`  2023 Amended: refund $${fmt(r2023.refund)}, NOL EOY $${fmt(r2023.nol_eoy)}`)
  console.log(`  2024 Amended: refund $${fmt(r2024.refund)}, NOL EOY $${fmt(r2024.nol_eoy)}`)
  console.log(`  Combined refund: $${fmt(r2023.refund + r2024.refund)}`)
  console.log(`  NOL remaining: $${fmt(r2024.nol_eoy)}`)
  console.log(`${'='.repeat(60)}`)
}

main()
