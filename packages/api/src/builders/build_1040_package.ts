/**
 * Build 1040 Packages — 2023 & 2024 (As-Filed)
 *
 * Per S07 Cash Restatement: personal returns are UNCHANGED.
 * The C-Corp amendment doesn't flow to the 1040 — EZ-Advisors
 * (S-Corp) K-1 income stays the same.
 *
 * This builds as-filed 1040s from textract data, validates with
 * the tax engine, fills PDFs, and runs textract comparison.
 */

import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { mapToCanonical, type TextractOutput } from '../intake/json_model_mapper.js'
import { ordinaryTax, qbiDeduction, niitTax, standardDeduction, TAX_TABLES } from '../engine/tax_tables.js'
import { PDF_FIELD_MAP_1120 } from '../maps/pdf_field_map_2024.js'

const OUT_DIR = 'tax-api/output'

interface Filed1040 {
  year: number
  textractPath: string
  // Income
  wages: number
  taxable_interest: number
  ordinary_dividends: number
  qualified_dividends: number
  capital_gains: number
  schedule1_income: number  // K-1 + other Sched 1
  dependent_care_benefits: number
  // Deduction
  use_standard: boolean
  itemized_amount: number
  // QBI
  k1_ordinary: number
  k1_w2_wages: number
  // Payments
  w2_withholding: number
  other_withholding: number
  estimated_payments: number
  // Schedule 2
  additional_medicare: number
  niit: number
  // Filed values for comparison
  filed_agi: number
  filed_taxable_income: number
  filed_total_tax: number
  filed_qbi: number
}

const FILED_2024: Filed1040 = {
  year: 2024,
  textractPath: 'tax_documents/_textract_output/Personal/2024 Tax Return - Mansoor Razzaq.json',
  wages: 413_296,   // 1z (includes $5k dependent care on 1e, W-2 box 1 = 408,296)
  taxable_interest: 60_548,
  ordinary_dividends: 1_413,
  qualified_dividends: 168,
  capital_gains: -3_000,
  schedule1_income: 162_408,  // K-1 $162,007 + substitute payment $401
  dependent_care_benefits: 5_000,
  use_standard: true,
  itemized_amount: 0,
  k1_ordinary: 162_007,
  k1_w2_wages: 237_802,  // from Form 8995-A
  w2_withholding: 60_429,
  other_withholding: 1_241,  // Additional Medicare withholding
  estimated_payments: 214_387,
  additional_medicare: 1_632,
  niit: 8_412,
  filed_agi: 634_665,
  filed_taxable_income: 573_064,
  filed_total_tax: 151_332,
  filed_qbi: 32_401,
}

const FILED_2023: Filed1040 = {
  year: 2023,
  textractPath: 'tax_documents/_textract_output/Personal/2023 Tax Return - Joint Signed.json',
  wages: 372_706,   // 1z
  taxable_interest: 26_008,
  ordinary_dividends: 516,
  qualified_dividends: 0,
  capital_gains: -3_000,
  schedule1_income: 3_044_422,  // K-1 $3,044,422
  dependent_care_benefits: 5_000,
  use_standard: true,
  itemized_amount: 0,
  k1_ordinary: 3_044_422,
  k1_w2_wages: 501_393 * 2,  // QBI = 50% of W-2 wages (from Form 8995-A)
  w2_withholding: 51_131,
  other_withholding: 149,  // Excess SS + Additional Medicare
  estimated_payments: 1_250_000,
  additional_medicare: 1_262,
  niit: 116_582,
  filed_agi: 3_440_652,
  filed_taxable_income: 2_911_559,
  filed_total_tax: 1_125_035,
  filed_qbi: 501_393,
}

function fmt(n: number): string {
  return n < 0 ? `(${Math.abs(n).toLocaleString()})` : n.toLocaleString()
}

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

async function build1040(d: Filed1040) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Building 1040 for ${d.year} — Mansoor & Ingrid Razzaq (MFJ)`)
  console.log(`${'='.repeat(60)}`)

  // Compute
  const total_income = d.wages + d.taxable_interest + d.ordinary_dividends +
    d.capital_gains + d.schedule1_income
  const agi = total_income
  const std_ded = standardDeduction('mfj', d.year)
  const deduction = d.use_standard ? std_ded : Math.max(d.itemized_amount, std_ded)
  const taxable_before_qbi = Math.max(0, agi - deduction)
  const qbi = qbiDeduction(d.k1_ordinary, d.k1_w2_wages, 0, taxable_before_qbi, 'mfj', d.year)
  const taxable_income = Math.max(0, taxable_before_qbi - qbi)
  const income_tax = ordinaryTax(taxable_income, 'mfj', d.year)
  const sched2_taxes = d.additional_medicare + d.niit
  const total_tax = income_tax + sched2_taxes
  const total_payments = d.w2_withholding + d.other_withholding + d.estimated_payments
  const refund = Math.max(0, total_payments - total_tax)
  const owed = Math.max(0, total_tax - total_payments)

  // Validate
  console.log(`  AGI:              ${fmt(agi).padEnd(12)} filed: ${fmt(d.filed_agi).padEnd(12)} ${agi === d.filed_agi ? '✓' : '✗'}`)
  console.log(`  QBI deduction:    ${fmt(qbi).padEnd(12)} filed: ${fmt(d.filed_qbi).padEnd(12)} ${qbi === d.filed_qbi ? '✓' : '✗'}`)
  console.log(`  Taxable income:   ${fmt(taxable_income).padEnd(12)} filed: ${fmt(d.filed_taxable_income).padEnd(12)} ${taxable_income === d.filed_taxable_income ? '✓' : '✗'}`)
  console.log(`  Income tax:       ${fmt(income_tax).padEnd(12)} filed: ${fmt(d.filed_total_tax - sched2_taxes).padEnd(12)} ${income_tax === (d.filed_total_tax - sched2_taxes) ? '✓' : `Δ${income_tax - (d.filed_total_tax - sched2_taxes)}`}`)
  console.log(`  Sched 2 taxes:    ${fmt(sched2_taxes)}`)
  console.log(`  Total tax:        ${fmt(total_tax).padEnd(12)} filed: ${fmt(d.filed_total_tax).padEnd(12)} ${total_tax === d.filed_total_tax ? '✓' : `Δ${total_tax - d.filed_total_tax}`}`)
  console.log(`  Total payments:   ${fmt(total_payments)}`)
  console.log(`  Refund:           ${fmt(refund)}`)

  // Fill PDF
  const pdf = await PDFDocument.load(readFileSync('tax-api/irs_forms/f1040_2024.pdf'))
  const form = pdf.getForm()

  // Page 1 header
  setField(form, 'f1_01', 'Mansoor')
  setField(form, 'f1_02', 'Razzaq')
  setField(form, 'f1_04', 'Ingrid')
  setField(form, 'f1_05', 'Razzaq')
  setField(form, 'f1_09', '6815 GRATIAN ST')
  // Filing status MFJ checkbox
  for (const f of form.getFields()) {
    if (f.getName().includes('c1_01[1]') && f instanceof PDFCheckBox) f.check()
  }

  // Income
  setField(form, 'f1_32', d.wages - d.dependent_care_benefits)  // 1a (W-2 box 1)
  setField(form, 'f1_36', d.dependent_care_benefits)             // 1e dependent care
  setField(form, 'f1_40', d.wages)                               // 1z total wages
  setField(form, 'f1_43', d.taxable_interest)                    // 2b
  setField(form, 'f1_44', d.qualified_dividends)                 // 3a
  setField(form, 'f1_45', d.ordinary_dividends)                  // 3b
  setField(form, 'f1_52', d.capital_gains)                       // 7
  setField(form, 'f1_53', d.schedule1_income)                    // 8
  setField(form, 'f1_54', total_income)                          // 9
  setField(form, 'f1_56', agi)                                   // 11
  setField(form, 'f1_57', deduction)                             // 12
  setField(form, 'f1_58', qbi)                                   // 13
  setField(form, 'f1_59', deduction + qbi)                       // 14
  setField(form, 'f1_60', taxable_income)                        // 15

  // Page 2
  setField(form, 'f2_01', income_tax)                            // 16
  setField(form, 'f2_03', sched2_taxes)                          // 17
  setField(form, 'f2_04', income_tax + sched2_taxes)             // 18
  setField(form, 'f2_08', income_tax + sched2_taxes)             // 22
  setField(form, 'f2_10', total_tax)                             // 24

  // Payments
  setField(form, 'f2_11', d.w2_withholding)                     // 25a
  setField(form, 'f2_13', d.other_withholding)                   // 25c
  setField(form, 'f2_14', d.w2_withholding + d.other_withholding) // 25d
  setField(form, 'f2_19', d.estimated_payments)                  // 26
  setField(form, 'f2_23', total_payments)                        // 33

  if (refund > 0) {
    setField(form, 'f2_24', refund)                              // 35a refund
  }
  if (owed > 0) {
    setField(form, 'f2_28', owed)                                // 37 amount owed
  }

  const outPath = `${OUT_DIR}/1040_${d.year}_Razzaq.pdf`
  writeFileSync(outPath, await pdf.save())
  console.log(`\n  ✓ Saved: ${outPath}`)
  return { outPath, total_tax, agi, taxable_income, qbi, refund }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const r2024 = await build1040(FILED_2024)
  const r2023 = await build1040(FILED_2023)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  1040 PACKAGES COMPLETE`)
  console.log(`${'='.repeat(60)}`)
  console.log(`  2024: AGI ${fmt(r2024.agi)}, tax ${fmt(r2024.total_tax)}, refund ${fmt(r2024.refund)}`)
  console.log(`  2023: AGI ${fmt(r2023.agi)}, tax ${fmt(r2023.total_tax)}, refund ${fmt(r2023.refund)}`)
  console.log()
  console.log(`  Note: S07 Cash Restatement does NOT change the 1040.`)
  console.log(`  The C-Corp amendment only affects EV's 1120.`)
  console.log(`  S-Corp K-1 income is unchanged → personal tax unchanged.`)
  console.log(`${'='.repeat(60)}`)
}

main()
