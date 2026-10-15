/**
 * Schedule O (Form 1120), Rev. December 2018 — controlled group consent plan
 * and apportionment.
 *
 * A corporation that answers "Yes" to Schedule K question 28 (member of a
 * controlled group) attaches Schedule O. We never produced it, so the K-28
 * "Yes" pointed at a schedule that was not in the package.
 *
 * Data: input_data.schedO =
 *   { group_type: 'parent_subsidiary'|'brother_sister'|'combined'|'life_insurance',
 *     entire_year?: boolean,
 *     plan: 'none'|'in_effect' (line 5a / 5b),
 *     members: [{ name, ein?, year_end: 'MM/YYYY', ae_credit?, est_tax_penalty?, other? }] }
 * Part II lists the members exactly as given; the caller decides whether this
 * corporation appears on its own schedule.
 *
 * Field IDs verified against the 2025 copy of the blank (the form is a
 * December 2018 revision; data/irs_forms/f1120so_2025.pdf) by widget position.
 * Page 2 is landscape: seven fields per member row, f2_1.. in steps of 7.
 */
import type { AttachmentBuilder } from './types.js'
import { loadVerifiedBlank, put, tick, num, printableId } from './acroform.js'

const GROUP_BOX: Record<string, string> = {
  parent_subsidiary: 'c1_1[0]', brother_sister: 'c1_1[1]', combined: 'c1_1[2]', life_insurance: 'c1_1[3]',
}

export const buildScheduleO: AttachmentBuilder = async (ctx) => {
  if (ctx.formType !== '1120') return null
  const o = ctx.inputData?.schedO
  if (!o || typeof o !== 'object') return null
  const pdf = await loadVerifiedBlank('f1120so', ctx.taxYear, 2025)
  if (!pdf) return null
  const form = pdf.getForm()
  let n = 0
  const w = (id: string, v: string | number | null | undefined) => { if (put(form, id, v)) n++ }
  const t = (name: string) => { if (tick(form, name)) n++ }

  w('f1_1', ctx.entity.name)
  w('f1_2', ctx.entity.ein)
  const g = String(o.group_type || '').toLowerCase().replace(/[^a-z]+/g, '_')
  if (GROUP_BOX[g]) t(GROUP_BOX[g])
  if (o.entire_year !== false) t('c1_2[0]')
  if (o.plan === 'none') t('c1_5[0]')
  else if (o.plan === 'in_effect') t('c1_5[1]')

  const members: any[] = Array.isArray(o.members) ? o.members.slice(0, 10) : []
  let c = 0, d = 0, e = 0
  members.forEach((m, i) => {
    const base = 1 + i * 7
    // (a) is two stacked lines; the name sits on the second, beside the EIN.
    w(`f2_${base + 1}`, m.name)
    w(`f2_${base + 2}`, printableId(m.ein))
    w(`f2_${base + 3}`, m.year_end)
    w(`f2_${base + 4}`, m.ae_credit ?? null)
    w(`f2_${base + 5}`, m.est_tax_penalty ?? null)
    w(`f2_${base + 6}`, m.other ?? null)
    c += num(m.ae_credit); d += num(m.est_tax_penalty); e += num(m.other)
  })
  if (members.length) {
    w('f2_71', c)
    w('f2_72', d)
    w('f2_73', e)
  }
  return { seq: 11, label: 'Schedule O', pdf, filled: n }
}
