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
 * Helpers:
 *   readMetric(fv, form, metric)            — single value
 *   extractAggregates(fv, form_type)        — agg_* columns for SQL-side queries
 *   buildMetricMatrix(rows, metrics)        — multi-row YoY matrix
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

const METRIC_TO_FIELD_BY_FORM: Record<string, Record<string, string>> = {
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
