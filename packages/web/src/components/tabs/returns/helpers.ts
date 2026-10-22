/**
 * Pure grouping for the Returns tab — exported for unit tests.
 */
import type { TaxReturn } from '@taxengine/shared'
import type { YearFiling } from '@/lib/filing'
import type { GoldenView, GoldenRow } from '@/hooks/use-golden'

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
  /** Filed / accepted for the year (GET /api/review/filing) */
  filing?: YearFiling
}

/**
 * `filing` adds each year's filed/accepted status, and a row for a year whose
 * filed return is on file only as a catalogued PDF — without one, the
 * group's 2025 returns (catalogued through MCP) had no row here at all and
 * read as unfiled while Compare showed the PDF (UI audit, 2026-10-22).
 */
export function groupByYear(returns: TaxReturn[], filing: YearFiling[] = []): GroupedYear[] {
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
  for (const f of filing) {
    const slot = byYear.get(f.tax_year)
    if (slot) slot.filing = f
    else if (f.filed) byYear.set(f.tax_year, { year: f.tax_year, amendments: [], extensions: [], others: [], filing: f })
  }
  // Sort amendments newest-first within each year
  for (const g of byYear.values()) {
    g.amendments.sort((a, b) => (b.computed_at || '').localeCompare(a.computed_at || ''))
  }
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year)
}

/**
 * Does an amendment agree with the books? Owner's rule (2026-10-22): an
 * amendment starts from the filed return, and the books may agree with it or
 * not — "that's separate. For clean-ups they have to agree, for scenario
 * analysis they don't." An amendment is a clean-up, so its disagreements
 * with the books are listed beside it; a scenario is never held to them.
 * Compared on every line where both carry a figure, within $1.
 */
export function booksAgreement(view: Pick<GoldenView, 'sources' | 'rows'>, returnId: string): {
  available: boolean
  why?: string
  compared: number
  differ: GoldenRow[]
} {
  const books = view.sources.books
  if (!books || books.available === false || !(books.lines ?? 0)) {
    return { available: false, why: books?.why ?? 'no books for this year', compared: 0, differ: [] }
  }
  const label = view.sources.returns.find(r => r.id === returnId)?.label
  if (!label) return { available: true, compared: 0, differ: [] }
  let compared = 0
  const differ: GoldenRow[] = []
  for (const r of view.rows) {
    const a = r.returns?.[label]?.value
    const b = r.books?.value
    if (typeof a !== 'number' || typeof b !== 'number') continue
    compared++
    if (Math.abs(a - b) > 1) differ.push(r)
  }
  return { available: true, compared, differ }
}

/**
 * The best base for a what-if or an amendment of `year`: the filed return,
 * else the latest amendment, else the latest draft (Mansoor, 2026-10-22:
 * "find the best source as base … typically the filed return"). The
 * Scenarios form defaulted to no base at all.
 */
export function bestBase(returns: TaxReturn[], year: number, formType: string): TaxReturn | undefined {
  const rank: Record<string, number> = { filed_import: 0, amendment: 1, proforma: 2 }
  return returns
    .filter(r => r.tax_year === year && r.form_type === formType && r.source && r.source in rank)
    .sort((a, b) => rank[a.source!] - rank[b.source!] || String(b.computed_at ?? '').localeCompare(String(a.computed_at ?? '')))[0]
}

