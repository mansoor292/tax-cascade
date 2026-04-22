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
import { getCanonicalAliases } from '../maps/engine_to_pdf.js'

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

  const m = mapped.model as Record<string, any>
  const totals: Record<string, number | null> = {}

  if (formType === '1040') {
    totals.total_income          = num(m, 'income.L9_total_income')
    totals.agi                   = num(m, 'income.L11b_agi')
    totals.taxable_income        = num(m, 'tax.L15_taxable_income')
    totals.income_tax            = num(m, 'tax.L16_income_tax')
    totals.total_tax             = num(m, 'tax.L24_total_tax')
    totals.total_payments        = num(m, 'payments.L33_total')
    totals.overpayment           = num(m, 'result.L34_overpayment')
    totals.refund                = num(m, 'refund.L35a_refunded')
    totals.amount_owed           = num(m, 'owed.L37_amount_owed')
    totals.wages                 = num(m, 'income.L1z_total_wages', 'income.L1a_w2_wages')
    totals.taxable_interest      = num(m, 'income.L2b_taxable_int')
    totals.ordinary_dividends    = num(m, 'income.L3b_ord_dividends')
    totals.qualified_dividends   = num(m, 'income.L3a_qual_dividends')
    totals.standard_deduction    = num(m, 'deductions.L12e_standard')
    totals.qbi_deduction         = num(m, 'deductions.L13a_qbi')
    // Schedule E totals (if the ingested bundle included it)
    totals.sched_e_rental_net    = num(m, 'schedE.L26_rental_royalty_net')
    totals.sched_e_partnership   = num(m, 'schedE.L32_partnership_total')
    totals.sched_e_total         = num(m, 'schedE.L41_total_income_loss')
  } else if (formType === '1120') {
    totals.gross_receipts        = num(m, 'income.L1a_gross_receipts')
    totals.cost_of_goods_sold    = num(m, 'income.L2_cogs')
    totals.gross_profit          = num(m, 'income.L3_gross_profit')
    totals.total_income          = num(m, 'income.L11_total_income')
    totals.total_deductions      = num(m, 'deductions.L27_total_deductions')
    totals.taxable_income_before_nol = num(m, 'tax.L28_ti_before_nol')
    totals.taxable_income        = num(m, 'tax.L30_taxable_income')
    totals.total_tax             = num(m, 'tax.L31_total_tax')
    totals.total_payments        = num(m, 'payments.L33_total_payments')
    totals.amount_owed           = num(m, 'payments.L35_amount_owed')
    totals.overpayment           = num(m, 'payments.L36_overpayment')
    totals.refund                = num(m, 'payments.L37_refunded')
  } else if (formType === '1120S') {
    totals.gross_receipts        = num(m, 'income.L1a_gross_receipts')
    totals.cost_of_goods_sold    = num(m, 'income.L2_cogs')
    totals.gross_profit          = num(m, 'income.L3_gross_profit')
    totals.total_income          = num(m, 'income.L6_total_income', 'income.L11_total_income')
    totals.total_deductions      = num(m, 'deductions.L20_total_deductions', 'deductions.L27_total_deductions')
    totals.ordinary_income_loss  = num(m, 'tax.L21_ordinary_income', 'tax.L30_taxable_income')
    totals.total_tax             = num(m, 'tax.L22_total_tax', 'tax.L31_total_tax')
    totals.total_payments        = num(m, 'payments.L33_total_payments')
    totals.amount_owed           = num(m, 'payments.L35_amount_owed')
    totals.overpayment           = num(m, 'payments.L36_overpayment')
  }

  return { field_values, totals }
}
