/**
 * Form 4562 (2025) for a Form 1120 package.
 *
 * Replaces the inline fill4562, whose field IDs were from another layout:
 * line 17 (MACRS on prior-year assets) printed in line 14's box (special
 * depreciation allowance), the line 22 total printed on line 17, and
 * amortization printed on Part V lines 28/29 (listed property) instead of
 * Part VI lines 43/44. The 2025 form is three pages; Part VI is on page 3.
 *
 * Canonical keys read (all `dep.` — they pass through compute unchanged):
 *   L1_179_limit, L2_179_cost, L3_threshold, L4_179_reduction, L5_179_dollar_limit,
 *   L8_listed_179, L9_tentative, L10_carryover, L11_income_limit, L12_179_expense,
 *   L13_carryover_next, L14_special_allowance, L15_168f1, L16_other,
 *   L17_macrs_prior, L21_listed, L22_total, L23_263a, L43_amortization, L44_total_amort.
 * Line 19 rows come from input_data.macrs_19_detail
 *   [{ row: 'a'..'g', placed?, basis?, period?, convention?, method?, deduction? }].
 * The "business or activity" box defaults to the return's form number, as
 * filed returns print it; input_data.form4562_activity overrides.
 *
 * Field IDs verified against data/irs_forms/f4562_2025.pdf by widget position.
 */
import type { AttachmentBuilder } from './types.js'
import { loadVerifiedBlank, put } from './acroform.js'

const LINE_IDS: Array<[string, string]> = [
  ['dep.L1_179_limit', 'f1_4'], ['dep.L2_179_cost', 'f1_5'], ['dep.L3_threshold', 'f1_6'],
  ['dep.L4_179_reduction', 'f1_7'], ['dep.L5_179_dollar_limit', 'f1_8'],
  ['dep.L8_listed_179', 'f1_16'], ['dep.L9_tentative', 'f1_17'], ['dep.L10_carryover', 'f1_18'],
  ['dep.L11_income_limit', 'f1_19'], ['dep.L12_179_expense', 'f1_20'], ['dep.L13_carryover_next', 'f1_21'],
  ['dep.L14_special_allowance', 'f1_22'], ['dep.L15_168f1', 'f1_23'], ['dep.L16_other', 'f1_24'],
  ['dep.L17_macrs_prior', 'f1_25'],
  ['dep.L21_listed', 'f2_1'], ['dep.L22_total', 'f2_2'], ['dep.L23_263a', 'f2_3'],
  ['dep.L43_amortization', 'f3_13'], ['dep.L44_total_amort', 'f3_14'],
]
// Line 19 rows a-g: six columns (b)-(g) each, from f1_26 in steps of 6.
const ROW19 = 'abcdefg'

export const buildForm4562: AttachmentBuilder = async (ctx) => {
  if (ctx.formType !== '1120') return null
  const m = ctx.model
  if (!m['dep.L22_total'] && !m['deductions.L20_depreciation'] && !m['dep.L44_total_amort']) return null
  const pdf = await loadVerifiedBlank('f4562', ctx.taxYear, 2025)
  if (!pdf) return null
  const form = pdf.getForm()
  let n = 0
  const w = (id: string, v: string | number | null | undefined) => { if (put(form, id, v)) n++ }

  w('f1_1', ctx.entity.name)
  w('f1_2', String(ctx.inputData?.form4562_activity ?? ctx.formType))
  w('f1_3', ctx.entity.ein)
  for (const [key, id] of LINE_IDS) {
    const v = m[key]
    if (v === undefined || v === null || v === '') continue
    w(id, typeof v === 'number' ? v : String(v))
  }
  const rows: any[] = Array.isArray(ctx.inputData?.macrs_19_detail) ? ctx.inputData.macrs_19_detail : []
  for (const r of rows) {
    const idx = ROW19.indexOf(String(r.row ?? '').toLowerCase().replace(/^19/, ''))
    if (idx < 0) continue
    const base = 26 + idx * 6
    const cols = [r.placed, r.basis, r.period, r.convention, r.method, r.deduction]
    cols.forEach((v, j) => {
      if (v === undefined || v === null || v === '') return
      // basis (c) and deduction (g) are money; the rest print as written
      w(`f1_${base + j}`, (j === 1 || j === 5) ? Number(v) : String(v))
    })
  }
  return { seq: 179, label: 'Form 4562', pdf, filled: n }
}
