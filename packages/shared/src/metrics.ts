/**
 * Metric → sectioned field_values key, per form type.
 *
 * `field_values` is the golden model — every IRS-line concept lives there
 * under its sectioned canonical key (`tax.L31_total_tax`, `income.L11_total_income`).
 * Flat metric names (`total_tax`, `taxable_income`, `agi`) are useful for
 * cross-form aggregation (dashboards, year-over-year matrix, agg_* plaintext
 * columns), but they're just per-form aliases for specific sectioned lines.
 *
 * That alias mapping lives in code (this file), not in the DB. We do NOT
 * persist a separate `computed_data.computed` flat-totals dict — it would be
 * a second source of truth that drifts on every engine change.
 *
 * This module moved verbatim from packages/api/src/maps/metric_to_field.ts
 * into the shared package because the web app had re-derived 42 of these
 * strings by hand (three separate copies of the total_tax-per-form switch),
 * and one had already drifted. Both packages import from here now; an
 * engine-side line renumber is a one-file change again.
 *
 * Helpers:
 *   metricKey(form, metric)                 — sectioned key or null
 *   readMetric(fv, form, metric)            — single value
 *   extractAggregates(fv, form_type)        — agg_* columns for SQL-side queries
 *   metricsForForm(form)                    — ordered {fv_key,label} display rows
 *   keyMetric(form, fv)                     — the "what moved" headline metric
 */

const METRIC_TO_FIELD_1120: Record<string, string> = {
  gross_receipts:            'income.L1a_gross_receipts',
  balance_1c:                'income.L1c_balance',
  cost_of_goods_sold:        'income.L2_cogs',
  gross_profit:              'income.L3_gross_profit',
  total_income:              'income.L11_total_income',
  total_deductions:          'deductions.L27_total_deductions',
  taxable_income_before_nol: 'tax.L28_ti_before_nol',
  taxable_income:            'tax.L30_taxable_income',
  income_tax:                'schedJ.J1a_income_tax',
  total_tax:                 'tax.L31_total_tax',
  total_payments:            'payments.L33_total_payments',
  amount_owed:               'payments.L35_amount_owed',
  balance_due:               'payments.L35_amount_owed',
  overpayment:               'payments.L36_overpayment',
  refund:                    'payments.L37_refunded',
}

const METRIC_TO_FIELD_1120S: Record<string, string> = {
  gross_receipts:            'income.L1a_gross_receipts',
  balance_1c:                'income.L1c_balance',
  cost_of_goods_sold:        'income.L2_cogs',
  gross_profit:              'income.L3_gross_profit',
  total_income:              'income.L6_total_income',
  total_deductions:          'deductions.L20_total_deductions',
  ordinary_income_loss:      'tax.L21_ordinary_income',
  total_tax:                 'tax.L22_total_tax',
  total_payments:            'payments.L33_total_payments',
  amount_owed:               'payments.L35_amount_owed',
  balance_due:               'payments.L35_amount_owed',
  overpayment:               'payments.L36_overpayment',
}

const METRIC_TO_FIELD_1040: Record<string, string> = {
  total_income:              'income.L9_total_income',
  agi:                       'income.L11b_agi',
  standard_deduction:        'deductions.L12_standard',
  qbi_deduction:             'deductions.L13a_qbi',
  taxable_income:            'tax.L15_taxable_income',
  income_tax:                'tax.L16_income_tax',
  total_tax:                 'tax.L24_total_tax',
  total_payments:            'payments.L33_total',
  refund:                    'refund.L35a_refunded',
  overpayment:               'result.L34_overpayment',
  balance_due:               'result.L37_balance_due',
  amount_owed:               'result.L37_balance_due',
}

export const METRIC_TO_FIELD_BY_FORM: Record<string, Record<string, string>> = {
  '1120':  METRIC_TO_FIELD_1120,
  '1120S': METRIC_TO_FIELD_1120S,
  '1040':  METRIC_TO_FIELD_1040,
}

/** Resolve a flat metric name to the sectioned field_values key for this form,
 *  or null if the form doesn't have that metric (e.g. `agi` on 1120). */
export function metricKey(form_type: string | null | undefined, metric: string): string | null {
  if (!form_type) return null
  const map = METRIC_TO_FIELD_BY_FORM[form_type]
  return map?.[metric] ?? null
}

/** Read a flat metric from a field_values dict. Returns null if the form
 *  doesn't have that metric or the key is absent / non-numeric. */
export function readMetric(
  field_values: Record<string, any> | null | undefined,
  form_type: string | null | undefined,
  metric: string,
): number | null {
  const k = metricKey(form_type, metric)
  if (!k || !field_values) return null
  const v = field_values[k]
  return typeof v === 'number' && !isNaN(v) ? v : null
}

/** Build the agg_* numeric columns for SQL-side filtering / dashboard queries.
 *  Reads only field_values — never computed_data. Returns nulls for missing. */
export function extractAggregates(
  field_values: Record<string, any> | null | undefined,
  form_type: string | null | undefined,
): { agg_total_income: number | null; agg_taxable_income: number | null; agg_total_tax: number | null; agg_agi: number | null } {
  return {
    agg_total_income:   readMetric(field_values, form_type, 'total_income'),
    agg_taxable_income: readMetric(field_values, form_type, 'taxable_income'),
    agg_total_tax:      readMetric(field_values, form_type, 'total_tax'),
    agg_agi:            readMetric(field_values, form_type, 'agi'),
  }
}

/** Standard metric set surfaced in the Compare endpoint's YoY matrix.
 *  Each form type populates whatever subset it has; the rest stay absent. */
export const COMPARE_METRICS = [
  'gross_profit',
  'total_income',
  'total_deductions',
  'taxable_income',
  'income_tax',
  'total_tax',
  'overpayment',
  'balance_due',
  'ordinary_income_loss',
  'agi',
  'amount_owed',
  'refund',
  'total_payments',
] as const

/** Display labels for COMPARE_METRICS rows — keyed off the same list so the
 *  web can't render a row the API never populates (that drift shipped once:
 *  a taxable_income_before_nol row that silently never had data). */
export const COMPARE_METRIC_LABELS: Record<(typeof COMPARE_METRICS)[number], string> = {
  gross_profit:         'Gross profit',
  total_income:         'Total income',
  total_deductions:     'Total deductions',
  taxable_income:       'Taxable income',
  income_tax:           'Income tax',
  total_tax:            'Total tax',
  overpayment:          'Overpayment',
  balance_due:          'Balance due',
  ordinary_income_loss: 'Ordinary income/loss (1120S)',
  agi:                  'AGI (1040)',
  amount_owed:          'Amount owed',
  refund:               'Refund',
  total_payments:       'Total payments',
}

/**
 * Canonical ordered metric list per form type for display tables. Always
 * render these rows in this order for any Filed / Amendment / Proforma /
 * Extension of that form, so the reader can scan filed-vs-amended-vs-
 * proforma without fields shuffling on object key order. Extension forms
 * (7004/4868) use flat keys — their field_values never adopted sectioned
 * naming.
 */
export const METRICS_BY_FORM: Record<string, Array<{ fv_key: string; label: string }>> = {
  '1120': [
    { fv_key: 'income.L1a_gross_receipts',         label: 'Gross receipts' },
    { fv_key: 'income.L11_total_income',           label: 'Total income' },
    { fv_key: 'deductions.L27_total_deductions',   label: 'Total deductions' },
    { fv_key: 'tax.L30_taxable_income',            label: 'Taxable income' },
    { fv_key: 'schedJ.J1a_income_tax',             label: 'Income tax' },
    { fv_key: 'tax.L31_total_tax',                 label: 'Total tax' },
    { fv_key: 'payments.L33_total_payments',       label: 'Total payments' },
    { fv_key: 'payments.L36_overpayment',          label: 'Overpayment' },
  ],
  '1120S': [
    { fv_key: 'income.L1a_gross_receipts',         label: 'Gross receipts' },
    { fv_key: 'income.L3_gross_profit',            label: 'Gross profit' },
    { fv_key: 'income.L6_total_income',            label: 'Total income' },
    { fv_key: 'deductions.L20_total_deductions',   label: 'Total deductions' },
    { fv_key: 'tax.L21_ordinary_income',           label: 'Ordinary income/loss' },
    { fv_key: 'tax.L22_total_tax',                 label: 'Total tax' },
    { fv_key: 'payments.L33_total_payments',       label: 'Total payments' },
    { fv_key: 'payments.L36_overpayment',          label: 'Overpayment' },
  ],
  '1040': [
    { fv_key: 'income.L9_total_income',            label: 'Total income' },
    { fv_key: 'income.L11b_agi',                   label: 'AGI' },
    { fv_key: 'tax.L15_taxable_income',            label: 'Taxable income' },
    { fv_key: 'tax.L16_income_tax',                label: 'Income tax' },
    { fv_key: 'tax.L24_total_tax',                 label: 'Total tax' },
    { fv_key: 'payments.L33_total',                label: 'Total payments' },
    { fv_key: 'refund.L35a_refunded',              label: 'Refund' },
    { fv_key: 'result.L37_balance_due',            label: 'Balance due' },
  ],
  '7004': [
    { fv_key: 'tentative_tax',                     label: 'Tentative tax' },
    { fv_key: 'total_payments',                    label: 'Total payments' },
    { fv_key: 'balance_due',                       label: 'Balance due' },
    { fv_key: 'overpayment',                       label: 'Overpayment' },
  ],
  '4868': [
    { fv_key: 'tentative_tax',                     label: 'Tentative tax' },
    { fv_key: 'total_payments',                    label: 'Total payments' },
    { fv_key: 'balance_due',                       label: 'Balance due' },
    { fv_key: 'overpayment',                       label: 'Overpayment' },
  ],
}

export function metricsForForm(form_type: string): Array<{ fv_key: string; label: string }> {
  return METRICS_BY_FORM[form_type] || METRICS_BY_FORM['1120']
}

/**
 * The headline "what moved" metric for a return of this form — what an
 * amendment column shows.
 *   1120  → total_tax            (tax.L31_total_tax)
 *   1120S → ordinary income/loss (tax.L21_ordinary_income)
 *   1040  → total_tax            (tax.L24_total_tax)
 */
export function keyMetric(
  form_type: string | null | undefined,
  field_values: Record<string, unknown> | null | undefined,
): { value: number | undefined; label: string } {
  const fv = field_values || {}
  const num = (k: string) => {
    const v = fv[k]
    return typeof v === 'number' && !isNaN(v) ? v : undefined
  }
  if (form_type === '1120S') return { value: num('tax.L21_ordinary_income'), label: 'Δ Ord. income' }
  if (form_type === '1040')  return { value: num('tax.L24_total_tax'),       label: 'Δ Tax' }
  return                            { value: num('tax.L31_total_tax'),       label: 'Δ Tax' }
}
