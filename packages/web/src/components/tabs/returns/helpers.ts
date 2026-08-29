/**
 * Pure grouping for the Returns tab — exported for unit tests.
 */
import type { TaxReturn } from '@taxengine/shared'

export interface GroupedYear {
  year: number
  filed?: TaxReturn
  /** All amendments for the year, newest first. Duplicates (same supersedes_id,
   *  separate compute runs) are intentionally preserved so the UI can surface
   *  them — they're almost always cruft the user needs to see and delete. */
  amendments: TaxReturn[]
  proforma?: TaxReturn
  extensions: TaxReturn[]
  others: TaxReturn[]
}

export function groupByYear(returns: TaxReturn[]): GroupedYear[] {
  const byYear = new Map<number, GroupedYear>()
  for (const r of returns) {
    if (!byYear.has(r.tax_year)) {
      byYear.set(r.tax_year, { year: r.tax_year, amendments: [], extensions: [], others: [] })
    }
    const slot = byYear.get(r.tax_year)!
    const pickLatest = (cur: TaxReturn | undefined, next: TaxReturn) => {
      if (!cur) return next
      return (next.computed_at || '') > (cur.computed_at || '') ? next : cur
    }
    switch (r.source) {
      case 'filed_import': slot.filed     = pickLatest(slot.filed, r); break
      case 'amendment':    slot.amendments.push(r); break
      case 'proforma':     slot.proforma  = pickLatest(slot.proforma, r); break
      case 'extension':    slot.extensions.push(r); break
      default:             slot.others.push(r)
    }
  }
  // Sort amendments newest-first within each year
  for (const g of byYear.values()) {
    g.amendments.sort((a, b) => (b.computed_at || '').localeCompare(a.computed_at || ''))
  }
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year)
}
