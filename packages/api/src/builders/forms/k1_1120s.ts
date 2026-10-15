/**
 * Schedule K-1 (Form 1120-S) in the 1120-S return package — one per shareholder.
 *
 * Why this exists (2026-10-15 parity sprint): a filed 1120-S carries a copy
 * of every shareholder's K-1. Ours never did; K-1s came only from the
 * separate POST /returns/:id/k1s route, so the package we would hand over
 * for filing was missing the schedule that tells the IRS who reports the
 * income. The filed EZ-Advisors package also carried items and codes our
 * K-1 never printed (16C, 16D, 17A, item I, the SSTB flag on the 199A
 * statement).
 *
 * Amounts: the engine's pro-rata allocation (calc1120S, as the K-1 route
 * uses), then the return's `k1_supplemental_detail` rows layered on top.
 * Those rows are `{label, amount|answer, shareholder?}` keyed by the label's
 * leading token: "Box 16C …", "Box 17A …", "Box 17V … QBI", "Box 17V … W-2
 * wages", "Box 17V SSTB", "Item C …", "Item I … beginning/end", "Item D/H …".
 * The order of the rows is the order the codes print in.
 *
 * Identifying numbers come from `input_data.shareholders[].tin` (encrypted at
 * rest with the return) or the entity's `meta.owners`; they are written, never
 * logged.
 */
import { calc1120S } from '../../engine/tax_engine.js'
import { build1120SK1, type K1Code, type K1Data1120S } from '../build_k1_pdfs.js'
import type { Attachment, AttachmentContext } from './types.js'

interface SupplementalRow { label?: string; amount?: number; answer?: string; text?: string; status?: string; shareholder?: string }

const amountOf = (r: SupplementalRow): number | undefined =>
  typeof r.amount === 'number' && isFinite(r.amount) ? r.amount : undefined

/** Apply the supplemental rows for one shareholder onto the engine's allocation. */
export function applySupplemental(k1: K1Data1120S, rows: SupplementalRow[]): K1Data1120S {
  const out: K1Data1120S = { ...k1, codes: { ...(k1.codes || {}) }, items: { ...(k1.items || {}) } }
  const codes = out.codes!
  const items = out.items!
  const push = (box: '10' | '12' | '13' | '15' | '16' | '17', c: K1Code) => {
    const list = (codes[box] = [...(codes[box] || [])])
    const at = list.findIndex(x => x.code === c.code)
    if (at >= 0) list[at] = { ...list[at], ...c }
    else list.push(c)
  }
  for (const r of rows) {
    const label = String(r.label || '').trim()
    const amt = amountOf(r)
    let m: RegExpMatchArray | null
    if ((m = label.match(/^Box\s+17\s*V\b/i))) {
      if (/sstb/i.test(label)) { out.sstb = /^(yes|x|checked)/i.test(String(r.answer ?? r.text ?? '')); continue }
      if (/w-?2/i.test(label)) { if (amt !== undefined) out.w2_wages = amt; continue }
      if (/ubia|unadjusted/i.test(label)) { if (amt !== undefined) out.ubia = amt; continue }
      if (amt !== undefined) out.qbi_income = amt
      push('17', { code: 'V', amount: amt ?? out.qbi_income, statement: true })
      continue
    }
    if ((m = label.match(/^Box\s+(10|12|13|15|16|17)\s*([A-Z]{1,2})\b/i))) {
      push(m[1] as '10', { code: m[2].toUpperCase(), amount: amt })
      continue
    }
    if (/^Item\s+C\b/i.test(label)) { items.C = String(r.answer ?? r.text ?? '').trim() || null; continue }
    if ((m = label.match(/^Item\s+([DHI])\b/i))) {
      if (amt === undefined) continue
      const end = /\bend\b/i.test(label)
      const key = `${m[1].toUpperCase()}_${end ? 'eoy' : 'boy'}` as 'D_boy'
      items[key] = amt
      continue
    }
    if (/^Item\s+F3\b/i.test(label)) { items.F3 = String(r.answer ?? r.text ?? '').trim() || undefined; continue }
  }
  return out
}

export async function buildK1s1120S(ctx: AttachmentContext): Promise<Attachment[] | null> {
  const inputs = ctx.inputData || {}
  if (!Array.isArray(inputs.shareholders) || inputs.shareholders.length === 0) return null
  const result = calc1120S(inputs as any)
  const supplemental: SupplementalRow[] = Array.isArray(inputs.k1_supplemental_detail) ? inputs.k1_supplemental_detail : []
  const owners: Array<{ name?: string; ssn?: string; tin?: string; address?: string }> = ctx.entity.meta?.owners || []
  const same = (a?: string, b?: string) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

  const out: Attachment[] = []
  for (const [i, alloc] of result.computed.k1s.entries()) {
    const sh = inputs.shareholders[i] || {}
    const owner = owners.find(o => same(o.name, alloc.name))
    const rows = supplemental.filter(r => !r.shareholder || same(r.shareholder, alloc.name))
    const k1 = applySupplemental(alloc as K1Data1120S, rows)
    const built = await build1120SK1(
      ctx.taxYear,
      {
        name: ctx.entity.name, ein: ctx.entity.ein, address: ctx.entity.address,
        city: ctx.entity.city, state: ctx.entity.state, zip: ctx.entity.zip,
      },
      { name: alloc.name, tin: sh.tin || owner?.ssn || owner?.tin, address: sh.address || owner?.address },
      k1,
    )
    out.push({ seq: 20 + i / 1000, label: `Schedule K-1 (${alloc.name})`, pdf: built.pdf, filled: built.filled })
  }
  return out
}
