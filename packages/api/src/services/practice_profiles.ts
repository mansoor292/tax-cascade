/**
 * Returns held in Catipult → the same ReturnProfile the IRS return
 * transcripts give, so every return-based rule (taxnow/insights.ts) runs on a
 * client's own returns where the IRS has no return transcript for that year
 * (the IRS serves them only for 2022–2025, and only for 1120/1120-S/1065).
 *
 * No second mapping is kept here: a profile field names IRS transcript lines,
 * and the curated transcript table (data/schema/transcript/<form>.json,
 * schema/transcript_map.ts) says which golden key each of those lines
 * reports. field_values hold golden keys, so the box is read from there.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hydrateAll, ENCRYPTED_RETURN_FIELDS, RETURN_ENC_COLS } from '../lib/row_crypto.js'
import { transcriptTable } from '../schema/transcript_map.js'
import type { ReturnProfile } from '../taxnow/insights.js'

const FIELD_LINES: Array<[keyof ReturnProfile, string[]]> = [
  ['gross_receipts', ['income|gross receipts', 'income|gross receipts or sales']],
  ['other_income', ['income|other income']],
  ['officer_comp', ['deductions|compensation of officers']],
  ['ordinary_income', ['deductions|ordinary income/loss', 'income|ordinary income (loss)']],
  ['taxable_income', ['tax and payments|taxable income per computer', 'deductions|taxable income']],
  ['total_tax', ['tax and payments|total income tax', 'tax and payments|tax shown on return']],
  ['distributions', ["schedule k - shareholders' shares of income, credits, deductions, etc|total property distribution"]],
  ['k_income', ["schedule k - shareholders' shares of income, credits, deductions, etc|income (loss)"]],
  ['m2_boy', ['indicators, codes, and miscellaneous information|schedule m-2: balance at beginning of tax year']],
  ['loans_to_shareholders', ['schedule l - balance sheets per books|loans to shareholders end of year', 'schedule l - balance sheets per books|loans to shareholders end of tax year']],
]

const SOURCE_RANK: Record<string, number> = { amendment: 3, filed_import: 2, proforma: 1 }

export async function profilesFromReturns(supabase: SupabaseClient, entityId: string, userId: string): Promise<ReturnProfile[]> {
  const { data: ent } = await supabase.from('tax_entity').select('form_type').eq('id', entityId).maybeSingle()
  const form = ent?.form_type as string | undefined
  if (!form || !['1120', '1120S', '1065'].includes(form)) return []
  const table = transcriptTable(form)
  if (!table) return []
  const { data } = await supabase.from('tax_return')
    .select(`id, tax_year, source, field_values, ${RETURN_ENC_COLS}`)
    .eq('entity_id', entityId)
  const rows = await hydrateAll(supabase, (data ?? []) as any[], { ...ENCRYPTED_RETURN_FIELDS, userIdFrom: () => userId })
  // One return per year: an amendment over the filed return over a draft.
  const best = new Map<number, any>()
  for (const r of rows) {
    if (!r.field_values || !(r.source in SOURCE_RANK)) continue
    const cur = best.get(r.tax_year)
    if (!cur || SOURCE_RANK[r.source] > SOURCE_RANK[cur.source]) best.set(r.tax_year, r)
  }
  const out: ReturnProfile[] = []
  for (const [year, r] of best) {
    const p: ReturnProfile = { form, taxYear: year, source: 'catipult_return' }
    for (const [field, lines] of FIELD_LINES) {
      for (const line of lines) {
        const k = table.get(line)
        const v = k ? Number(r.field_values[k.key]) : NaN
        if (k && Number.isFinite(v)) { (p as any)[field] = Math.round(v * 100); break }
      }
    }
    out.push(p)
  }
  return out
}
