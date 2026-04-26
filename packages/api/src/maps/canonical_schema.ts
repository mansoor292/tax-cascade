/**
 * Canonical schema — single source of truth for the shape of
 * `tax_return.field_values` and `tax_return.computed_data.computed`.
 *
 * Three slots, three responsibilities, no overlap:
 *
 *   - `input_data`     descriptive (what the caller / mapper / QBO emitted)
 *   - `field_values`   sectioned IRS-line keys ONLY — `income.L1a_gross_receipts`,
 *                      `deductions.L16_advertising`, `tax.L31_total_tax`, …
 *   - `computed_data.computed`  flat derived totals ONLY — `total_tax`,
 *                      `balance_due`, `gross_profit`, `taxable_income`. NO
 *                      overlap with field_values.
 *
 * Translation from descriptive → sectioned happens once at the boundary
 * (mapper output, qbo_to_inputs output, request body). Internal code
 * (engine, persist path, PDF builder, validators, Compare UI) speaks
 * sectioned only and never mixes the two.
 *
 * `validateFieldValues()` runs in the persist path and throws on any key
 * that isn't in this schema, catching writers that drift back to the old
 * mixed-shape style before the bad data hits the DB.
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

/** Computed keys are flat (no dots). The full set per form is small —
 *  these are derived totals, not lines. Anything line-like belongs in
 *  field_values. */
export const COMPUTED_KEYS_BY_FORM: Record<string, string[]> = {
  '1120': [
    'balance_1c',
    'gross_profit',
    'total_income',
    'total_deductions',
    'taxable_income_before_nol',
    'special_deductions',
    'nol_applied',
    'nol_carryforward_remaining',
    'nol_generated',
    'taxable_income',
    'income_tax',
    'total_credits',
    'total_tax',
    'total_payments',
    'balance_due',
    'overpayment',
  ],
  '1120S': [
    'balance_1c',
    'gross_profit',
    'total_income',
    'total_deductions',
    'ordinary_income_loss',
    // k1s array carries shareholder allocations — not a flat scalar but lives
    // in computed alongside the totals; allow it through
    'k1s',
  ],
  '1040': [
    'total_income',
    'agi',
    'taxable_income',
    'income_tax',
    'total_tax',
    'total_payments',
    'refund',
    'balance_due',
    'standard_deduction',
    'qbi_deduction',
    'self_employment_tax',
    'additional_medicare',
    'niit',
    'amt',
    'ctc',
    'eitc',
  ],
  '7004': ['tentative_tax', 'total_payments', 'balance_due', 'overpayment'],
  '4868': ['tentative_tax', 'total_payments', 'balance_due', 'overpayment'],
  '8868': ['tentative_tax', 'total_payments', 'balance_due', 'overpayment'],
}

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

/** Check that a computed dict contains only flat keys allowed for the form. */
export function validateComputed(
  c: Record<string, any> | null | undefined,
  form_type: string,
): { ok: boolean; errors: string[] } {
  if (!c) return { ok: true, errors: [] }
  const allowed = new Set(COMPUTED_KEYS_BY_FORM[form_type] || [])
  if (allowed.size === 0) return { ok: true, errors: [] } // unknown form — skip
  const errors: string[] = []
  for (const k of Object.keys(c)) {
    if (k.includes('.')) {
      errors.push(`${k}: dotted key in computed — should be flat`)
      continue
    }
    if (!allowed.has(k)) {
      errors.push(`${k}: not in COMPUTED_KEYS_BY_FORM['${form_type}']`)
    }
  }
  return { ok: errors.length === 0, errors }
}
