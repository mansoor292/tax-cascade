/**
 * Pure helpers for the line-by-line canonical-key comparison — exported for
 * unit tests.
 */
import { SECTION_ORDER } from '@taxengine/shared'
import type { TaxReturn } from '@taxengine/shared'

/** Collect all numeric canonical key/value pairs from a return row.
 *  Line-by-line comparison is about WHAT'S ON THE FORM — every IRS line
 *  the return populates. That's `field_values` (sectioned IRS-line keys).
 *  We deliberately skip `computed_data.computed`: those are flat derived
 *  totals (`total_tax`, `balance_due`) that just duplicate sectioned lines
 *  (`tax.L31_total_tax`, `payments.L35_amount_owed`) under engine names.
 *  Flat totals drive the multi-year YoY matrix and the agg_* columns
 *  elsewhere — they're not form lines and don't belong here. */
export function collectValues(ret: TaxReturn | undefined): Record<string, number> {
  if (!ret) return {}
  const out: Record<string, number> = {}
  const fv = (ret.field_values || {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(fv)) {
    if (typeof v === 'number' && !isNaN(v)) out[k] = v
  }
  return out
}

/** Humanize a canonical key: "income.L1a_gross_receipts" → "L1a gross receipts". */
export function humanize(key: string): string {
  const [, rest] = key.split('.', 2)
  if (!rest) return key
  return rest.replace(/_/g, ' ')
}

export function sectionOf(key: string): string {
  const prefix = key.split('.', 2)[0]
  if (SECTION_ORDER.includes(prefix)) return prefix
  return 'other'
}

export function sortKey(a: string, b: string): number {
  const sa = sectionOf(a), sb = sectionOf(b)
  const idxA = SECTION_ORDER.indexOf(sa), idxB = SECTION_ORDER.indexOf(sb)
  if (idxA !== idxB) return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
  return a.localeCompare(b)
}
