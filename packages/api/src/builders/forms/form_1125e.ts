/**
 * Form 1125-E (Rev. October 2016) — Compensation of Officers. Shared by the
 * 1120 and 1120-S packages (registered in registry_shared.ts).
 *
 * Line 12 of the 1120 and line 7 of the 1120-S say "attach Form 1125-E" once
 * total receipts reach $500,000, and the officer detail was already stored
 * (input_data.officer_compensation_detail) but no form was ever printed.
 *
 * Rows: { label|name, ssn?, time_pct, common_pct, preferred_pct, amount }.
 * The officer's SSN prints only when a full identifier is stored — a masked
 * one ("***-**-1234") must never reach a return, so it is left blank and the
 * gap shows on review rather than as a plausible-looking wrong number.
 *
 * Amounts are added with cents and rounded once (line 2), per the
 * instructions; each row prints rounded.
 *
 * Field IDs verified against data/irs_forms/f1125e_2025.pdf: header f1_1/f1_2,
 * officer rows of six fields from f1_3 (20 rows), line 2 f1_123, line 3
 * f1_124, line 4 f1_125.
 */
import type { AttachmentBuilder } from './types.js'
import { loadVerifiedBlank, put, num, printableId } from './acroform.js'

const ROWS = 20

export const buildForm1125E: AttachmentBuilder = async (ctx) => {
  if (ctx.formType !== '1120' && ctx.formType !== '1120S') return null
  const rows: any[] = Array.isArray(ctx.inputData?.officer_compensation_detail)
    ? ctx.inputData.officer_compensation_detail : []
  const officers = rows.filter(r => r && (r.label || r.name) && num(r.amount ?? r.compensation) !== 0)
  if (!officers.length) return null

  const pdf = await loadVerifiedBlank('f1125e', ctx.taxYear, 2025)
  if (!pdf) return null
  const form = pdf.getForm()
  let n = 0
  const w = (id: string, v: string | number | null | undefined) => { if (put(form, id, v)) n++ }

  w('f1_1', ctx.entity.name)
  w('f1_2', ctx.entity.ein)
  let total = 0
  officers.slice(0, ROWS).forEach((o, i) => {
    const base = 3 + i * 6
    const amount = num(o.amount ?? o.compensation)
    total += amount
    w(`f1_${base}`, String(o.name ?? o.label))
    w(`f1_${base + 1}`, printableId(o.ssn))
    w(`f1_${base + 2}`, o.time_pct ?? null)
    w(`f1_${base + 3}`, o.common_pct ?? null)
    w(`f1_${base + 4}`, o.preferred_pct ?? null)
    w(`f1_${base + 5}`, amount)
  })
  const claimedElsewhere = num(ctx.inputData?.officer_compensation_in_cogs)
  w('f1_123', total)
  if (claimedElsewhere) w('f1_124', claimedElsewhere)
  w('f1_125', total - claimedElsewhere)
  return { seq: 12, label: 'Form 1125-E', pdf, filled: n }
}
