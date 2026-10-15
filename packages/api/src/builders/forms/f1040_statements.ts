/**
 * Statements attached to a 1040: today, Schedule 1 line 8z "other income",
 * itemized from input_data.other_income_detail. Schedule 1 says "See
 * Statement" in the 8z description box (f1040_sched1.ts); this is the
 * statement it points to, with the return's name and SSN at the top as the
 * IRS asks of every attachment.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { AttachmentBuilder } from './types.js'
import { SPEC_YEAR, headerName, headerSsn, money, num } from './f1040_common.js'

export const buildSchedule1Statement: AttachmentBuilder = async c => {
  if (c.formType !== '1040' || c.taxYear !== SPEC_YEAR) return null
  const items = (c.inputData.other_income_detail || []) as Array<{ label?: string; amount?: number }>
  const total = num(c.model['sched1.L8z_other_income'])
  if (!items.length || !total) return null
  const sum = items.reduce((t, x) => t + num(x.amount), 0)
  // A statement that does not tie to the line it supports is worse than none.
  if (Math.abs(sum - total) > 1) return null

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Courier)
  const bold = await pdf.embedFont(StandardFonts.CourierBold)
  const page = pdf.addPage([612, 792])
  let y = 740
  const draw = (t: string, x: number, f = font, size = 10) => page.drawText(t, { x, y, font: f, size, color: rgb(0, 0, 0) })
  // A statement is not a comb field: the SSN prints in its usual ###-##-#### form.
  const ssn = headerSsn(c).replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3')
  draw(headerName(c, 'statement'), 50, bold, 11); draw(ssn, 470, bold, 11); y -= 20
  draw(`Statement - Sch 1 (1040) - 8z - Other Income, Tax Year ${c.taxYear}`, 50, bold); y -= 20
  draw('Other income type', 60); draw('Amount', 470); y -= 6
  draw('-'.repeat(78), 50); y -= 14
  for (const it of items) {
    draw(String(it.label ?? '').slice(0, 60), 60)
    draw(money(num(it.amount)).padStart(12), 430)
    y -= 14
  }
  draw('-'.repeat(78), 50); y -= 14
  draw('Total:', 60, bold); draw(money(sum).padStart(12), 430, bold)
  return { seq: 1.5, label: 'Statement - Schedule 1 line 8z', pdf, filled: items.length + 1 }
}
