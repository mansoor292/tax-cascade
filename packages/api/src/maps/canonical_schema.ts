/**
 * Canonical schema — single source of truth for the shape of
 * `tax_return.field_values`.
 *
 * `field_values` IS the golden model: every IRS-line concept lives there
 * under its sectioned canonical key (`income.L1a_gross_receipts`,
 * `deductions.L16_advertising`, `tax.L31_total_tax`). Flat metric names
 * (`total_tax`, `taxable_income`, `agi`) are NOT a separate persisted slot —
 * they're per-form aliases for specific sectioned lines and live in code
 * (`maps/metric_to_field.ts`), not the DB.
 *
 * `input_data` carries the descriptive snapshot of what the caller passed.
 * `computed_data` retains structural engine output (citations, k1s array,
 * qbo_warnings) but no longer holds a flat-totals dict.
 *
 * Translation from descriptive → sectioned happens once at the boundary
 * (mapper output, qbo_to_inputs output, request body). Internal code
 * (engine, persist path, PDF builder, validators, Compare UI) speaks
 * sectioned only and never mixes the two.
 *
 * `validateFieldValues()` runs in the persist path and warns on any key
 * that isn't in this schema, catching writers that drift back to the old
 * mixed-shape style.
 */

/** Allowed prefixes for `field_values`. Keys must be of the form
 *  `<prefix>.<rest>` where prefix is in this list. */
const FIELD_VALUE_SECTION_PREFIXES = new Set([
  'income',
  'cogs',
  'deductions',
  'tax',
  'credits',
  'payments',
  'result',
  'refund',
  'owed',
  'overpayment',
  'schedJ',
  'schedL',
  'schedM1',
  'schedM2',
  'schedK',
  'schedB',
  'schedC',
  'schedE',
  'schedule_e',
  'dep',
  'amort',
  'nol',
  'meta',
  'preparer',
])

/** Sectioned keys must NOT match these patterns — these are the descriptive
 *  shapes that used to coexist with sectioned in field_values. If validation
 *  rejects one of these, a writer is still emitting the old shape and needs
 *  to translate at boundary instead. */
const DESCRIPTIVE_KEY_PATTERNS: RegExp[] = [
  // No L<digit> after the prefix → descriptive
  /^income\.(?!L\d)(?!total_assets)/,
  /^deductions\.(?!L\d)/,
  /^cogs\.(?!L\d)/,
  /^tax\.(?!L\d)(?!taxable_income_before_nol)/,
  /^payments\.(?!L\d)/,
  /^schedule_k\./, // legacy descriptive schedK shape
]

/** Check that a field_values dict contains only sectioned canonical keys. */
export function validateFieldValues(
  fv: Record<string, any> | null | undefined,
  form_type: string,
): { ok: boolean; errors: string[] } {
  if (!fv) return { ok: true, errors: [] }
  const errors: string[] = []
  for (const k of Object.keys(fv)) {
    if (typeof k !== 'string' || k === '') {
      errors.push(`empty key`)
      continue
    }
    const prefix = k.split('.', 1)[0]
    if (!FIELD_VALUE_SECTION_PREFIXES.has(prefix)) {
      errors.push(`${k}: unknown section prefix '${prefix}'`)
      continue
    }
    if (DESCRIPTIVE_KEY_PATTERNS.some(re => re.test(k))) {
      errors.push(`${k}: descriptive shape — should be sectioned IRS-line (translate at boundary)`)
    }
  }
  // form_type unused for now but kept on signature so per-form tightening
  // (e.g. require specific keys for a 1120) is a one-line change later.
  void form_type
  return { ok: errors.length === 0, errors }
}

