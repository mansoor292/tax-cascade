/**
 * The year's books, classified to return lines: QuickBooks P&L and balance
 * sheet (current year, plus the prior year's balance sheet for Schedule L's
 * opening column) run through the mapper (maps/qbo_to_inputs.ts).
 *
 * One code path for GET /api/qbo/:entity_id/qbo-to-tax-inputs and the golden
 * view (/api/golden), so the books a preparer inspects are the books the
 * comparison shows. Reports come from the qbo_report cache when present.
 */
import { lazyServiceClient } from '../lib/supabase.js'
import { getFinancials } from '../routes/qbo.js'
import { buildCorporateInputsFromQbo, type MapperOutput } from '../maps/qbo_to_inputs.js'

const supabase = lazyServiceClient()

export interface BooksPacket {
  packet: MapperOutput
  sources: { pnl_as_of: string | null; bs_as_of: string | null; prior_bs_as_of: string | null; business_code: string | null }
}

/** null when the entity has no P&L for the year (not connected, or no data). */
export async function booksPacket(userId: string, entityId: string, year: number, formType: '1120' | '1120S'): Promise<BooksPacket | null> {
  const [fin, priorFin, entityRow] = await Promise.all([
    getFinancials(entityId, year, { userId }).catch(() => null),
    getFinancials(entityId, year - 1, { userId }).catch(() => null),
    (async () => {
      try {
        const r = await supabase.from('tax_entity').select('meta').eq('id', entityId).eq('user_id', userId).single()
        return r.data
      } catch { return null }
    })(),
  ])
  const pnl = fin?.profit_and_loss?.items
  if (!pnl) return null
  const packet = buildCorporateInputsFromQbo({
    pnl, bs: fin?.balance_sheet?.items, priorBs: priorFin?.balance_sheet?.items,
    form_type: formType, business_code: entityRow?.meta?.business_code,
  })
  return {
    packet,
    sources: {
      pnl_as_of: fin?.profit_and_loss?.fetched_at || null,
      bs_as_of: fin?.balance_sheet?.fetched_at || null,
      prior_bs_as_of: priorFin?.balance_sheet?.fetched_at || null,
      business_code: entityRow?.meta?.business_code || null,
    },
  }
}
