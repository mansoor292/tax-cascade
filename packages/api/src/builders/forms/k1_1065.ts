/**
 * Schedule K-1 (Form 1065) in the 1065 return package — one per partner.
 *
 * A filed partnership return carries a copy of every partner's K-1; the
 * package without them is missing the schedule that tells the IRS who
 * reports the income. Amounts are the engine's own allocation stored on the
 * return (computed_data.k1s from engine/form1065.ts), so the K-1s in the
 * package are the ones the Schedule K ties were checked against — never a
 * second allocation computed here.
 *
 * Partner identifying numbers come from input_data.partners[].tin (encrypted
 * at rest with the return); they are written, never logged.
 */
import { build1065K1Prepared, type K1Prepared1065 } from '../build_k1_pdfs.js'
import type { Attachment, AttachmentContext } from './types.js'

export async function buildK1s1065(ctx: AttachmentContext): Promise<Attachment[] | null> {
  if (ctx.formType !== '1065') return null
  const k1s = (ctx.computedData?.k1s || []) as K1Prepared1065[]
  if (!Array.isArray(k1s) || !k1s.length) return null
  const partners = Array.isArray(ctx.inputData?.partners) ? ctx.inputData.partners : []
  const e = ctx.entity
  const issuer = { name: e.name, ein: e.ein, address: e.address, city: e.city, state: e.state, zip: e.zip }
  const out: Attachment[] = []
  for (const k of k1s) {
    const p = partners.find((x: any) => x?.name === k.name) || {}
    const built = await build1065K1Prepared(ctx.taxYear, issuer, { ...k, tin: k.tin ?? p.tin, address: k.address ?? p.address })
    out.push({ seq: 900, label: `Schedule K-1 — ${k.name}`, pdf: built.pdf, filled: built.filled })
  }
  return out
}
