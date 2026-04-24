/**
 * Canonicalize `computed_data.computed` shape across the filed archiver and
 * the tax engine. The two code paths emit different key names for the same
 * concept:
 *
 *   engine path (calc1120/1120S/1040) → balance_due, balance_1c, income_tax
 *   archiver path (archive_filed_return) → amount_owed, gross_receipts, …
 *
 * Without reconciliation, Filed-vs-Amended comparison duplicates totals under
 * alias names and shows empty cells on one side for concepts that are really
 * identical.
 *
 * `canonicalizeComputed()` dual-writes every alias pair so both names resolve
 * to the same number. Called on both write paths just before the row is
 * persisted (see returns.ts compute handler + archive_filed_return.ts).
 */

/** Each primary key → list of alias names that should mirror the same value. */
export const COMPUTED_ALIASES: Record<string, string[]> = {
  // 1120 L35 / 1040 L37
  balance_due:         ['amount_owed'],
  // 1120 L1a — archiver + engine both use gross_receipts today, but keep
  // the entry so future renames flow through a single point.
  gross_receipts:      [],
  // 1120 L1c balance — engine uses balance_1c, archiver emits nothing here.
  // Mirror into gross_receipts_balance for clarity; also reverse-map from
  // L1a gross_receipts when returns=0 (handled caller-side, not here).
  balance_1c:          ['gross_receipts_balance'],
  // 1120 L2 — archiver emits cost_of_goods_sold, engine emits the short form.
  cost_of_goods_sold:  ['cogs'],
  // Identical today but pin so refactors stay symmetric.
  total_tax:           [],
  total_income:        [],
  total_deductions:    [],
  taxable_income:      [],
  overpayment:         [],
  refund:              [],
  total_payments:      [],
  gross_profit:        [],
  // Engine-only concept on 1120 amendments — no archiver counterpart today.
  income_tax:          [],
}

/**
 * Given a computed dict, ensure every alias pair is populated with the same
 * number. Never overwrites an existing value, so genuine differences survive.
 *
 * Runs in both directions: primary → aliases AND aliases → primary, so whichever
 * side of the pair the caller populates, the other side mirrors it.
 */
export function canonicalizeComputed(
  computed: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!computed || typeof computed !== 'object') return {}
  const out: Record<string, any> = { ...computed }

  for (const [primary, aliases] of Object.entries(COMPUTED_ALIASES)) {
    // primary → alias
    const pv = out[primary]
    if (typeof pv === 'number' && !isNaN(pv)) {
      for (const a of aliases) {
        if (out[a] === undefined || out[a] === null) out[a] = pv
      }
    }
    // alias → primary (first alias wins if multiple)
    if (out[primary] === undefined || out[primary] === null) {
      for (const a of aliases) {
        const av = out[a]
        if (typeof av === 'number' && !isNaN(av)) { out[primary] = av; break }
      }
    }
  }

  return out
}
