/**
 * Archive a filed return from mapper output.
 *
 * Filed returns are immutable snapshots of what was actually submitted — we
 * trust the extracted values verbatim and do NOT recompute. This helper turns
 * a MappingResult into the shape expected by a tax_return row: a full
 * canonical field_values map plus a compact `totals` object with comparison-
 * friendly keys (taxable_income, total_tax, etc.) so compare_returns can line
 * returns up year-over-year regardless of source.
 */
import type { MappingResult } from './json_model_mapper.js'
import { getCanonicalAliases, syncFieldValueAliases } from '../maps/engine_to_pdf.js'
import { canonicalizeComputed } from '../maps/computed_aliases.js'

export interface FiledReturnArchive {
  /** All canonical fields extracted from the PDF, trusted verbatim. */
  field_values: Record<string, number | string | null>
  /** Comparison-friendly totals keyed so compare_returns can find them. */
  totals: Record<string, number | null>
}

function num(model: Record<string, any>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = model[k]
    if (typeof v === 'number' && !isNaN(v)) return v
  }
  return null
}

export function archiveFiledReturn(
  mapped: MappingResult,
  formType: string,
  _entityName: string | null,
): FiledReturnArchive {
  // Dual-write: mapper emits descriptive keys (e.g. deductions.advertising),
  // engine emits IRS-line keys (e.g. deductions.L22_advertising). Write both
  // so comparison tools line up regardless of which convention they expect.
  const field_values: Record<string, number | string | null> = {}
  const aliases = getCanonicalAliases(formType)
  for (const f of mapped.fields) {
    field_values[f.canonical_key] = f.value
    const aliased = aliases[f.canonical_key]
    if (aliased && field_values[aliased] === undefined) {
      field_values[aliased] = f.value
    }
  }

  // Extract totals from field_values — the dual-write above gave us both
  // descriptive (income.gross_receipts) and IRS-line (income.L1a_gross_receipts)
  // representations, so whichever form the mapper natively emits is covered.
  // Reading from mapped.model alone missed the descriptive-only outputs from
  // the 1120S mapper and produced all-null totals (bug: EZA 1120S filed rows
  // showed every metric as —).
  const totals: Record<string, number | null> = {}

  if (formType === '1040') {
    totals.total_income          = num(field_values, 'income.L9_total_income',          'income.total_income')
    totals.agi                   = num(field_values, 'income.L11b_agi',                  'income.agi')
    totals.taxable_income        = num(field_values, 'tax.L15_taxable_income',           'tax.taxable_income')
    totals.income_tax            = num(field_values, 'tax.L16_income_tax',               'tax.income_tax')
    totals.total_tax             = num(field_values, 'tax.L24_total_tax',                'tax.total_tax')
    totals.total_payments        = num(field_values, 'payments.L33_total',               'payments.total_payments')
    totals.overpayment           = num(field_values, 'result.L34_overpayment',           'result.overpayment')
    totals.refund                = num(field_values, 'refund.L35a_refunded',             'refund.refunded')
    totals.amount_owed           = num(field_values, 'owed.L37_amount_owed',             'owed.amount_owed')
    totals.wages                 = num(field_values, 'income.L1z_total_wages',           'income.L1a_w2_wages', 'income.wages')
    totals.taxable_interest      = num(field_values, 'income.L2b_taxable_int',           'income.taxable_interest')
    totals.ordinary_dividends    = num(field_values, 'income.L3b_ord_dividends',         'income.ordinary_dividends')
    totals.qualified_dividends   = num(field_values, 'income.L3a_qual_dividends',        'income.qualified_dividends')
    totals.standard_deduction    = num(field_values, 'deductions.L12e_standard',         'deductions.standard')
    totals.qbi_deduction         = num(field_values, 'deductions.L13a_qbi',              'deductions.qbi')
    totals.sched_e_rental_net    = num(field_values, 'schedE.L26_rental_royalty_net')
    totals.sched_e_partnership   = num(field_values, 'schedE.L32_partnership_total')
    totals.sched_e_total         = num(field_values, 'schedE.L41_total_income_loss')
  } else if (formType === '1120') {
    totals.gross_receipts        = num(field_values, 'income.L1a_gross_receipts',        'income.gross_receipts')
    totals.cost_of_goods_sold    = num(field_values, 'income.L2_cogs',                   'income.cost_of_goods_sold')
    totals.gross_profit          = num(field_values, 'income.L3_gross_profit',           'income.gross_profit')
    totals.total_income          = num(field_values, 'income.L11_total_income',          'income.total_income')
    totals.total_deductions      = num(field_values, 'deductions.L27_total_deductions',  'deductions.total_deductions')
    totals.taxable_income_before_nol = num(field_values, 'tax.L28_ti_before_nol',        'tax.taxable_income_before_nol')
    totals.taxable_income        = num(field_values, 'tax.L30_taxable_income',           'tax.taxable_income')
    totals.total_tax             = num(field_values, 'tax.L31_total_tax',                'tax.total_tax')
    totals.total_payments        = num(field_values, 'payments.L33_total_payments',      'payments.total_payments')
    totals.amount_owed           = num(field_values, 'payments.L35_amount_owed',         'payments.amount_owed')
    totals.overpayment           = num(field_values, 'payments.L36_overpayment',         'payments.overpayment')
    totals.refund                = num(field_values, 'payments.L37_refunded',            'payments.refunded')
  } else if (formType === '1120S') {
    totals.gross_receipts        = num(field_values, 'income.L1a_gross_receipts',        'income.gross_receipts')
    totals.cost_of_goods_sold    = num(field_values, 'income.L2_cogs',                   'income.cost_of_goods_sold')
    totals.gross_profit          = num(field_values, 'income.L3_gross_profit',           'income.gross_profit')
    totals.total_income          = num(field_values, 'income.L6_total_income',           'income.L11_total_income', 'income.total_income')
    totals.total_deductions      = num(field_values, 'deductions.L20_total_deductions',  'deductions.L27_total_deductions', 'deductions.total_deductions')
    totals.ordinary_income_loss  = num(field_values, 'tax.L21_ordinary_income',          'tax.L30_taxable_income', 'deductions.ordinary_income_loss')
    totals.total_tax             = num(field_values, 'tax.L22_total_tax',                'tax.L31_total_tax', 'tax.total_tax')
    totals.total_payments        = num(field_values, 'payments.L33_total_payments',      'payments.total_payments')
    totals.amount_owed           = num(field_values, 'payments.L35_amount_owed',         'payments.amount_owed')
    totals.overpayment           = num(field_values, 'payments.L36_overpayment',         'payments.overpayment', 'overpayment.L27')
  }

  // Dual-write alias keys so archiver totals line up with the engine's
  // computed_data.computed shape (amount_owed ↔ balance_due, cogs ↔
  // cost_of_goods_sold, etc.). Without this, Filed vs Amended comparisons
  // show empty cells under different names for the same concept.
  // Also sync field_values descriptive ↔ sectioned aliases so any later
  // engine recompute can never disagree with the archived form.
  syncFieldValueAliases(field_values, formType)
  return { field_values, totals: canonicalizeComputed(totals) as Record<string, number | null> }
}
