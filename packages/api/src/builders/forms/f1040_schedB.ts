/**
 * Schedule B (Form 1040), 2025 — interest and ordinary dividends by payer,
 * and the Part III foreign-account questions.
 *
 * Rows come from input_data.schedB_detail when the caller states them
 * ({interest: [{payer, amount}], dividends: [...]}) — the way to reproduce a
 * filed Schedule B row for row, payer wording and order included. Otherwise
 * they are derived: the 1099 itemizations, then the K-1 (k1_portfolio) as one
 * more payer. A row flagged `subtotal` prints like a payer row but is not one.
 *
 * Part II's first payer box shares its line with the "List name of payer"
 * caption and is a third the width of the others, so Part II starts on its
 * second line, as the filed 2025 return does.
 */
import { PDFDocument } from 'pdf-lib'
import { readFileSync } from 'fs'
import type { AttachmentBuilder } from './types.js'
import { blankPath, setText, check, headerName, headerSsn, num, any } from './f1040_common.js'

interface Row { payer: string; amount: number; subtotal?: boolean }

const PART1 = Array.from({ length: 14 }, (_, i) => [`f1_${String(3 + i * 2).padStart(2, '0')}`, `f1_${String(4 + i * 2).padStart(2, '0')}`])
const PART2 = Array.from({ length: 14 }, (_, i) => [`f1_${36 + i * 2}`, `f1_${37 + i * 2}`])

function derive(items: any[] | undefined, k1: any, k1Amount: number, k1First: boolean): Row[] {
  const rows: Row[] = (items || []).map(x => ({ payer: String(x.label ?? x.payer ?? ''), amount: num(x.amount) }))
  if (k1Amount) {
    const r = { payer: String(k1?.entity_name ?? k1?.name ?? 'K-1'), amount: k1Amount }
    if (k1First) rows.unshift(r); else rows.push(r)
  }
  return rows
}

export const buildScheduleB: AttachmentBuilder = async c => {
  if (c.formType !== '1040') return null
  const path = blankPath('f1040sb', c.taxYear)
  if (!path || !any(c, 'schedB.L2_total_interest', 'schedB.L6_total_dividends')) return null
  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()
  let filled = 0
  const put = (id: string, v: string | number | undefined) => { if (setText(form, id, v)) filled++ }
  put('f1_01', headerName(c, 'f1040sb'))
  put('f1_02', headerSsn(c))

  const stated = c.inputData.schedB_detail
  const k1 = c.inputData.k1_portfolio
  const interest: Row[] = stated?.interest ?? derive(c.inputData.taxable_interest_detail, k1, num(k1?.interest), false)
  const dividends: Row[] = stated?.dividends ?? derive(c.inputData.ordinary_dividends_detail, k1, num(k1?.ordinary_dividends), true)

  interest.slice(0, PART1.length).forEach((r, i) => { put(PART1[i][0], r.payer); put(PART1[i][1], num(r.amount)) })
  if (num(c.model['schedB.L2_total_interest'])) {
    put('f1_31', num(c.model['schedB.L2_total_interest']))
    put('f1_33', num(c.model['schedB.L4_taxable_interest']))
  }
  dividends.slice(0, PART2.length).forEach((r, i) => { put(PART2[i][0], r.payer); put(PART2[i][1], num(r.amount)) })
  if (num(c.model['schedB.L6_total_dividends'])) put('f1_64', num(c.model['schedB.L6_total_dividends']))

  // Part III: 7a foreign account, 8 foreign trust. The engine records 7a;
  // a foreign trust is not modelled, so 8 is answered only with 7a's "No".
  const foreign = String(c.model['schedB.L7a_foreign_account'] ?? '').toLowerCase()
  if (foreign === 'yes') { if (check(form, 'c1_1[0]')) filled++ }
  else if (foreign === 'no') {
    if (check(form, 'c1_1[1]')) filled++
    if (!c.inputData.foreign_trust && check(form, 'c1_3[1]')) filled++
  }
  return { seq: 8, label: 'Schedule B', pdf, filled }
}
