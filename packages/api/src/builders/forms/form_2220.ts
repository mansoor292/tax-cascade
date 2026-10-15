/**
 * Form 2220 (2025) — attached to a Form 1120 whose inputs carry `form2220`.
 *
 * The penalty on page 1 line 34 is computed by the engine from the same
 * inputs (engine/form2220.ts); this prints the form that shows the working,
 * from the same function, so the attachment can never disagree with line 34.
 *
 * All four pages are attached: Schedule A (pages 3-4) is blank unless the
 * annualized or seasonal method is used, which is not modeled, but it is part
 * of the form as filed.
 *
 * Field IDs verified against the 2025 blank (data/irs_forms/f2220_2025.pdf)
 * by widget position; any other year is refused.
 */
import type { AttachmentBuilder } from './types.js'
import { loadVerifiedBlank, put, num } from './acroform.js'
import { calc2220 } from '../../engine/form2220.js'

const COLS = 4
/** Page 1, Part III: first field number of each line (columns a-d follow). */
const P1_ROWS: Record<string, number> = { L9: 11, L10: 15, L11: 19, L12: 23, L13: 27, L14: 31, L15: 35, L16: 39, L17: 43, L18: 47 }

export const buildForm2220: AttachmentBuilder = async (ctx) => {
  if (ctx.formType !== '1120') return null
  const f2220 = ctx.inputData?.form2220
  if (!f2220 || typeof f2220 !== 'object') return null
  const totalTax = num(ctx.model['tax.L31_total_tax'] ?? ctx.model['schedJ.J12_total_tax'])
  const r = calc2220({ ...f2220, tax_year: ctx.taxYear, total_tax: totalTax })
  if (!r.required) return null

  const pdf = await loadVerifiedBlank('f2220', ctx.taxYear, 2025)
  if (!pdf) return null
  const form = pdf.getForm()
  let n = 0
  const w = (id: string, v: string | number | null | undefined) => { if (put(form, id, v)) n++ }

  // Part I
  w('f1_1', ctx.entity.name)
  w('f1_2', ctx.entity.ein)
  w('f1_3', r.L1)
  w('f1_4', r.L2a)
  w('f1_5', r.L2b || null)
  w('f1_6', r.L2c)
  w('f1_7', r.L2d)
  w('f1_8', r.L3)
  w('f1_9', r.L4)
  w('f1_10', r.L5)

  // Part III. Shaded cells (12-14 and 16 in column (a), 16 and 18 in (d)) stay
  // empty; line 11 and line 15(a) print only when something was paid.
  const paid = r.L11.some(v => v > 0)
  const row = (line: string, vals: Array<number | string | null>, skip: (i: number) => boolean = () => false) => {
    for (let i = 0; i < COLS; i++) {
      if (skip(i)) continue
      const v = vals[i]
      if (v === null || v === undefined) continue
      w(`f1_${P1_ROWS[line] + i}`, v)
    }
  }
  row('L9', r.L9)
  row('L10', r.L10)
  if (paid) row('L11', r.L11)
  row('L12', r.L12, i => i === 0)
  row('L13', r.L13, i => i === 0)
  row('L14', r.L14, i => i === 0)
  row('L15', r.L15, i => i === 0 && !paid)
  row('L16', r.L16, i => i === 0 || i === 3)
  row('L17', r.L17)
  row('L18', r.L18, i => i === 3)

  // Part IV: line 19 f2_1-4, line 20 f2_5-8, then each period as a pair of
  // rows (days, penalty) of four, f2_9 onward; line 37 f2_73-76, line 38 f2_77.
  for (let i = 0; i < COLS; i++) {
    w(`f2_${1 + i}`, r.L19[i])
    w(`f2_${5 + i}`, String(r.L20[i]))
  }
  let id = 9
  for (const p of r.periods) {
    for (let i = 0; i < COLS; i++) w(`f2_${id + i}`, String(p.days[i]))
    id += COLS
    for (let i = 0; i < COLS; i++) w(`f2_${id + i}`, p.penalty[i])
    id += COLS
  }
  for (let i = 0; i < COLS; i++) w(`f2_${73 + i}`, r.L37[i])
  w('f2_77', r.L38)

  // Schedule A, Part III (page 4) belongs to the annualized / seasonal
  // methods, which are not modeled, so nothing here is computed. Some filing
  // software fills it in anyway; a return mirrored from such a filing carries
  // those figures as stated (form2220.schedule_a_part3, lines 32-38, four
  // columns each) and they print exactly as given — strings verbatim, so a
  // filed "7,229.75" keeps its cents. Lines 31 and 32 share one field.
  const part3 = f2220.schedule_a_part3
  if (part3 && typeof part3 === 'object') {
    const first: Record<string, number> = { L32: 53, L33: 57, L34: 61, L35: 65, L36: 69, L37: 73, L38: 77 }
    for (const [line, base] of Object.entries(first)) {
      const vals = Array.isArray(part3[line]) ? part3[line] : []
      for (let i = 0; i < COLS; i++) {
        const v = vals[i]
        if (v === null || v === undefined || v === '') continue
        w(`f4_${base + i}`, typeof v === 'number' ? v : String(v))
      }
    }
  }

  return { seq: 2220, label: 'Form 2220', pdf, filled: n }
}
