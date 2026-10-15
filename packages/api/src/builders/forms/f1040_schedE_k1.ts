/**
 * Schedule E (Form 1040), 2025 — Part II for an S corporation K-1 reported as
 * scalars (k1_ordinary_income + k1_portfolio), the shape the 1040 engine
 * takes for a shareholder's own corporation.
 *
 * build_schedule_e.ts renders Schedule E from a structured `schedule_e`
 * computation (rentals, partnerships); a return carrying only K-1 scalars
 * had no Schedule E at all, although its income reached Schedule 1 line 5
 * and Form 1040 line 8 "from Schedule E". This builder steps aside whenever
 * the structured computation exists, so the two never both print.
 *
 * Page 1 is included with its header only: Part II sits on page 2, and the
 * form is filed whole.
 */
import { PDFDocument } from 'pdf-lib'
import { readFileSync } from 'fs'
import type { AttachmentBuilder } from './types.js'
import { blankPath, setText, check, headerName, headerSsn, num, digits } from './f1040_common.js'

export const buildScheduleEK1: AttachmentBuilder = async c => {
  if (c.formType !== '1040') return null
  if (c.computedData?.schedule_e?.computed) return null
  const income = num(c.inputData.k1_ordinary_income)
  const path = blankPath('f1040se', c.taxYear)
  if (!path || !income) return null
  const k1 = c.inputData.k1_portfolio || {}
  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()
  let filled = 0
  const put = (id: string, v: string | number | undefined) => { if (setText(form, id, v)) filled++ }
  const name = headerName(c, 'f1040se'), ssn = headerSsn(c)
  put('f1_1', name); put('f1_2', ssn)
  put('f2_1', name); put('f2_2', ssn)

  // Row A: name, (b) P or S, (d) EIN, (e) basis computation required (Form 7203 attached).
  put('f2_3', k1.entity_name ?? k1.name)
  put('f2_4', k1.entity_type ?? 'S')
  put('f2_5', digits(k1.ein) || undefined)
  if (k1.basis_computation_required ?? !!c.inputData.form7203) { if (check(form, 'c2_3[0]')) filled++ }

  // Nonpassive: (k) income / (i) loss, then the 29a/29b totals and 30-32, 41.
  if (income > 0) {
    put('f2_19', income); put('f2_39', income); put('f2_45', income)
  } else {
    const loss = Math.abs(income)
    put('f2_17', loss); put('f2_42', loss); put('f2_46', loss)
  }
  put('f2_47', income)
  put('f2_78', income)
  return { seq: 13, label: 'Schedule E', pdf, filled }
}
