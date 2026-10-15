/**
 * Schedule G (Form 1120) — owners of 20%+ / 50%+ of the voting stock.
 *
 * Part I lists ENTITIES (Schedule K question 4a), Part II lists INDIVIDUALS
 * and estates (question 4b). The old filler wrote every owner into Part I, so
 * a 100% individual shareholder appeared as a corporate owner — contradicting
 * the "No" to 4a and the "Yes" to 4b on the same return.
 *
 * Source, in order: the return's input_data.schedG_detail
 *   [{ label|name, kind?: 'individual'|'entity', entity_type?, ein|ssn|identifier?, country, pct_voting_stock }]
 * then the entity's standing meta.owners [{ name, ssn, country, pct }].
 * An owner is an individual unless marked `kind: 'entity'` (or it carries an
 * EIN and no SSN). Identifiers print only when complete — a masked SSN is left
 * blank (see acroform.printableId). Percentages print as stated, without a
 * trailing "%", which the column heading already carries.
 *
 * Field IDs verified against data/irs_forms/f1120sg_2025.pdf by widget
 * position. The IDs are not sequential row to row, hence the tables.
 */
import type { AttachmentBuilder } from './types.js'
import { loadVerifiedBlank, put, printableId, dropInstructionPages } from './acroform.js'

// Part I rows: name, EIN, type of entity, country, percentage.
const PART1 = [4, 10, 16, 22, 80, 91, 102, 114, 125, 136].map(b => [b, b + 1, b + 2, b + 3, b + 4])
// Part II rows: name, identifying number, country of citizenship, percentage.
const PART2 = [[32, 33, 34, 38], [39, 40, 41, 45], [46, 47, 48, 52], [53, 54, 55, 59], [85, 86, 87, 90],
  [96, 97, 98, 101], [107, 109, 110, 113], [119, 120, 121, 124], [130, 131, 132, 135], [141, 142, 143, 146]]

const id = (n: number) => `f1_${n}_0_`

function pctText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v).replace(/\s*%\s*$/, '')
}

export const buildScheduleG: AttachmentBuilder = async (ctx) => {
  if (ctx.formType !== '1120') return null
  const detail: any[] = Array.isArray(ctx.inputData?.schedG_detail) ? ctx.inputData.schedG_detail : []
  const owners: any[] = detail.length ? detail : (Array.isArray(ctx.entity.meta?.owners) ? ctx.entity.meta!.owners : [])
  if (!owners.length) return null
  const pdf = await loadVerifiedBlank('f1120sg', ctx.taxYear, 2025)
  if (!pdf) return null
  const form = pdf.getForm()
  let n = 0
  const w = (fid: string, v: string | number | null | undefined) => { if (put(form, fid, v)) n++ }

  w(id(1), ctx.entity.name)
  w(id(3), ctx.entity.ein)
  let i1 = 0, i2 = 0
  for (const o of owners) {
    const name = o.name ?? o.label
    const isEntity = o.kind === 'entity' || (!o.kind && o.ein && !o.ssn)
    if (isEntity && i1 < PART1.length) {
      const [a, b, c, d, e] = PART1[i1++]
      w(id(a), name); w(id(b), printableId(o.ein ?? o.identifier)); w(id(c), o.entity_type ?? null)
      w(id(d), o.country ?? null); w(id(e), pctText(o.pct_voting_stock ?? o.pct))
    } else if (!isEntity && i2 < PART2.length) {
      const [a, b, c, d] = PART2[i2++]
      w(id(a), name); w(id(b), printableId(o.ssn ?? o.identifier)); w(id(c), o.country ?? null)
      w(id(d), pctText(o.pct_voting_stock ?? o.pct))
    }
  }
  // page 2 of the blank is instructions
  return { seq: 10, label: 'Schedule G', pdf: dropInstructionPages(pdf), filled: n }
}
