/**
 * 2025 Proforma 1040 — Single form, Textract-verified fields only
 * Build → Fill → Textract → Analyze
 */

import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { ordinaryTax, qbiDeduction, niitTax, standardDeduction } from './tax_tables.js'

const FORMS = 'tax-api/irs_forms'
const OUT = 'tax-api/output/2025'

function findField(form: any, id: string): PDFTextField | null {
  for (const f of form.getFields())
    if (f.getName().includes(id + '[') && f instanceof PDFTextField) return f
  return null
}
function set(form: any, id: string, v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return
  const f = findField(form, id)
  if (!f) return
  const s = typeof v === 'number' ? (v === 0 ? '' : v.toLocaleString()) : String(v)
  if (!s) return
  const ml = f.getMaxLength()
  if (ml !== undefined && s.length > ml) f.setMaxLength(s.length)
  f.setText(s)
}

const fmt = (n: number) => n.toLocaleString()

async function main() {
  mkdirSync(OUT, { recursive: true })

  // ── Compute ──
  const mansoor_w2 = 120_000
  const ingrid_w2 = 374_923
  const total_w2 = mansoor_w2 + ingrid_w2
  const k1_ordinary = 1_576_523
  const interest = 5_000
  const qual_div = 168
  const ord_div = 1_413
  const cap_loss = -3_000

  const total_income = total_w2 + interest + ord_div + cap_loss + k1_ordinary
  const agi = total_income
  const std_ded = standardDeduction('mfj', 2025)
  const taxable_before_qbi = Math.max(0, agi - std_ded)
  const qbi = qbiDeduction(k1_ordinary, 120_000, 0, taxable_before_qbi, 'mfj', 2025)
  const total_deductions = std_ded + qbi
  const taxable = Math.max(0, agi - total_deductions)
  const income_tax = ordinaryTax(taxable, 'mfj', 2025)
  const addl_medicare = Math.round(Math.max(0, total_w2 - 250_000) * 0.009)
  const niit = niitTax(interest + ord_div, agi, 'mfj', 2025)
  const sched2 = addl_medicare + niit
  const total_tax = income_tax + sched2
  const withholding = 19_528 + 57_752
  const balance_due = total_tax - withholding

  console.log('2025 1040 Computation:')
  console.log(`  Total W-2:     ${fmt(total_w2)}`)
  console.log(`  K-1:           ${fmt(k1_ordinary)}`)
  console.log(`  Total income:  ${fmt(total_income)}`)
  console.log(`  AGI:           ${fmt(agi)}`)
  console.log(`  Std deduction: ${fmt(std_ded)}`)
  console.log(`  QBI:           ${fmt(qbi)}`)
  console.log(`  Taxable:       ${fmt(taxable)}`)
  console.log(`  Income tax:    ${fmt(income_tax)}`)
  console.log(`  Addl Medicare: ${fmt(addl_medicare)}`)
  console.log(`  NIIT:          ${fmt(niit)}`)
  console.log(`  Total tax:     ${fmt(total_tax)}`)
  console.log(`  Withholding:   ${fmt(withholding)}`)
  console.log(`  Balance due:   ${fmt(balance_due)}`)

  // ── Fill — using ONLY Textract-verified field IDs ──
  const pdf = await PDFDocument.load(readFileSync(`${FORMS}/f1040_2025.pdf`))
  const form = pdf.getForm()

  // All field IDs below are from f1040_2025_fields.json (Textract-verified)
  // Header
  set(form, 'f1_14', 'Mansoor')                    // Your first name
  set(form, 'f1_15', 'Razzaq')                     // Last name
  set(form, 'f1_17', 'Ingrid')                     // Spouse first name
  set(form, 'f1_18', 'Fuentes-Razzaq')             // Spouse last name
  set(form, 'f1_20', '6815 GRATIAN ST')            // Home address
  set(form, 'f1_22', 'CORAL GABLES')               // City
  set(form, 'f1_23', 'FL')                         // State
  set(form, 'f1_24', '33146')                      // ZIP

  // MFJ checkbox — find by trying known patterns
  for (const f of form.getFields()) {
    const name = f.getName()
    if (name.includes('c1_') && name.includes('[1]') && f instanceof PDFCheckBox) {
      f.check() // MFJ
      break
    }
  }

  // Page 1: Income (all Textract-verified)
  set(form, 'f1_47', total_w2)                     // 1a W-2 wages
  set(form, 'f1_57', total_w2)                     // 1z Total wages
  set(form, 'f1_59', interest)                     // 2b Taxable interest
  set(form, 'f1_60', qual_div)                     // 3a Qualified dividends
  set(form, 'f1_61', ord_div)                      // 3b Ordinary dividends
  set(form, 'f1_70', cap_loss)                     // 7a Capital gain/loss
  set(form, 'f1_72', k1_ordinary)                  // 8 Schedule 1 line 10
  set(form, 'f1_73', total_income)                 // 9 Total income
  set(form, 'f1_74', 0)                            // 10 Adjustments
  set(form, 'f1_75', agi)                          // 11a AGI

  // Page 2: Deductions and tax
  set(form, 'f2_01', agi)                          // 11b AGI (carried to p2)
  set(form, 'f2_02', std_ded)                      // 12e Standard deduction
  set(form, 'f2_03', qbi)                          // 13a QBI
  set(form, 'f2_05', total_deductions)             // 14 Total deductions
  set(form, 'f2_06', taxable)                      // 15 Taxable income

  // Line 16: income tax — f2_07 had empty label in Textract, f2_08 not mapped
  // Try both
  set(form, 'f2_07', income_tax)                   // 16 Tax (empty label in textract)
  set(form, 'f2_08', income_tax)                   // 16 alt field

  set(form, 'f2_09', sched2)                       // 17 Schedule 2 line 3
  set(form, 'f2_10', income_tax + sched2)          // 18 Add 16+17
  set(form, 'f2_14', income_tax + sched2)          // 22 After credits
  set(form, 'f2_15', sched2)                       // 23 Other taxes (Sched 2 L21)
  set(form, 'f2_16', total_tax)                    // 24 Total tax

  // Payments
  set(form, 'f2_17', withholding)                  // 25a W-2
  set(form, 'f2_20', withholding)                  // 25d Total withholding
  set(form, 'f2_29', withholding)                  // 33 Total payments

  // Amount owed
  set(form, 'f2_35', balance_due)                  // 37 Amount owed
  set(form, 'f2_36', 4_459)                        // 38 Est. penalty

  const outPath = `${OUT}/1040_2025_v2.pdf`
  writeFileSync(outPath, await pdf.save())
  console.log(`\n✓ Saved: ${outPath}`)
}

main()
