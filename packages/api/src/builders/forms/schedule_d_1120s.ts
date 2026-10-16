/**
 * Schedule D (Form 1120-S) 2025 — Capital Gains and Losses and Built-in Gains.
 *
 * Why this exists (2026-10-15 parity sprint): Schedule K lines 7 and 8a say
 * "attach Schedule D (Form 1120-S)", and the S corporation's 2025 return
 * reported a short-term gain on brokerage sales — but no 1120-S package this
 * system built ever carried a Schedule D. The filed return did, so the
 * package we would have produced was missing a required attachment.
 *
 * Data: `input_data.schedule_d_1120s`, the schedule as filed:
 *   {
 *     qof_disposed?: 'yes' | 'no',
 *     rows?: { L1a?, L1b?, L2?, L3?, L8a?, L8b?, L9?, L10?: {proceeds?, cost?, adjustments?, gain?} },
 *     L4?, L5?, L6?, L7?, L11?, L12?, L13?, L14?, L15?,      // amounts; L7/L15 derived when absent
 *     part3?: { L16?, L17?, L18?, L19?, L20?, L21?, L22?, L23? },
 *   }
 * A row's gain (h) is derived as proceeds − cost + adjustments, in whole
 * dollars, when not given; lines 7 and 15 come from the same helper the
 * engine uses for Schedule K lines 7 and 8a (engine/schedule_d_1120s.ts),
 * so the schedule and the line that says "attach Schedule D" cannot differ.
 * Nothing is printed for a return without the object: an empty Schedule D is
 * not an attachment, it is noise.
 *
 * Field ids were read off the 2025 blank (four columns per row: (d) proceeds,
 * (e) cost, (g) adjustments, (h) gain). 2025 only.
 */
import { PDFDocument, PDFCheckBox } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import type { Attachment, AttachmentContext } from './types.js'
import { scheduleD1120STotals, scheduleDRowGain as rowGain } from '../../engine/schedule_d_1120s.js'

type Row = { proceeds?: number; cost?: number; adjustments?: number; gain?: number }

export interface ScheduleD1120S {
  qof_disposed?: 'yes' | 'no' | string
  rows?: Partial<Record<'L1a' | 'L1b' | 'L2' | 'L3' | 'L8a' | 'L8b' | 'L9' | 'L10', Row>>
  L4?: number; L5?: number; L6?: number; L7?: number
  L11?: number; L12?: number; L13?: number; L14?: number; L15?: number
  part3?: Partial<Record<'L16' | 'L17' | 'L18' | 'L19' | 'L20' | 'L21' | 'L22' | 'L23', number>>
}

/** [proceeds, cost, adjustments, gain] field ids per row. L1a has no (g) entry on the form but keeps the slot. */
export const SCHED_D_1120S_ROWS_2025: Record<string, [string, string, string, string]> = {
  L1a: ['f1_3', 'f1_4', 'f1_5', 'f1_6'],
  L1b: ['f1_7', 'f1_8', 'f1_9', 'f1_10'],
  L2:  ['f1_11', 'f1_12', 'f1_13', 'f1_14'],
  L3:  ['f1_15', 'f1_16', 'f1_17', 'f1_18'],
  L8a: ['f1_23', 'f1_24', 'f1_25', 'f1_26'],
  L8b: ['f1_27', 'f1_28', 'f1_29', 'f1_30'],
  L9:  ['f1_31', 'f1_32', 'f1_33', 'f1_34'],
  L10: ['f1_35', 'f1_36', 'f1_37', 'f1_38'],
}

export const SCHED_D_1120S_LINES_2025: Record<string, string> = {
  name: 'f1_1', ein: 'f1_2',
  L4: 'f1_19', L5: 'f1_20', L6: 'f1_21', L7: 'f1_22',
  L11: 'f1_39', L12: 'f1_40', L13: 'f1_41', L14: 'f1_42', L15: 'f1_43',
  L16: 'f2_1', L17: 'f2_2', L18: 'f2_3', L19: 'f2_4', L20: 'f2_5', L21: 'f2_6', L22: 'f2_7', L23: 'f2_8',
}

const money = (v: number) => (Object.is(Math.round(v), -0) ? 0 : Math.round(v)).toLocaleString('en-US')
const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)

export async function buildScheduleD1120S(ctx: AttachmentContext): Promise<Attachment | null> {
  const d = ctx.inputData?.schedule_d_1120s as ScheduleD1120S | undefined
  if (!d || typeof d !== 'object' || ctx.taxYear !== 2025) return null
  const path = 'data/irs_forms/f1120ssd_2025.pdf'
  if (!existsSync(path)) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()
  let filled = 0
  const put = (id: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return
    for (const f of form.getFields()) {
      if (f.getName().endsWith('.' + id + '[0]')) {
        form.getTextField(f.getName()).setText(typeof value === 'number' ? money(value) : value)
        filled++
        return
      }
    }
  }

  put(SCHED_D_1120S_LINES_2025.name, ctx.entity.name)
  put(SCHED_D_1120S_LINES_2025.ein, ctx.entity.ein)

  const qof = String(d.qof_disposed || '').toLowerCase()
  if (qof === 'yes' || qof === 'no') {
    const target = qof === 'yes' ? 'c1_1[0]' : 'c1_1[1]'
    for (const f of form.getFields()) {
      if (f instanceof PDFCheckBox && f.getName().endsWith('.' + target)) { f.check(); filled++ }
    }
  }

  const rows = d.rows || {}
  for (const [key, ids] of Object.entries(SCHED_D_1120S_ROWS_2025)) {
    const r = rows[key as keyof typeof rows]
    if (!r) continue
    put(ids[0], num(r.proceeds))
    put(ids[1], num(r.cost))
    if (key !== 'L1a') put(ids[2], num(r.adjustments))
    put(ids[3], rowGain(r))
  }

  const totals = scheduleD1120STotals(d)
  const l7 = totals?.L7
  const l15 = totals?.L15
  for (const k of ['L4', 'L5', 'L6', 'L11', 'L12', 'L13', 'L14'] as const) put(SCHED_D_1120S_LINES_2025[k], num(d[k]))
  put(SCHED_D_1120S_LINES_2025.L7, l7)
  put(SCHED_D_1120S_LINES_2025.L15, l15)

  for (const [k, v] of Object.entries(d.part3 || {})) put(SCHED_D_1120S_LINES_2025[k], num(v))

  return { seq: 10, label: 'Schedule D (Form 1120-S)', pdf, filled }
}
