/**
 * Archive a filed return from mapper output.
 *
 * Filed returns are immutable snapshots of what was actually submitted — we
 * trust the extracted values verbatim and do NOT recompute. This helper turns
 * a MappingResult into the shape expected by a tax_return row: a sectioned
 * canonical field_values map (descriptive mapper output gets translated at
 * this boundary) plus a compact `totals` object with comparison-friendly
 * keys (taxable_income, total_tax, etc.) so compare_returns can line returns
 * up year-over-year regardless of source.
 */
import type { MappingResult } from './json_model_mapper.js'
import { descriptiveToSectioned } from '../maps/descriptive_to_sectioned.js'

export interface FiledReturnArchive {
  /** All canonical fields extracted from the PDF, sectioned IRS-line keys only. */
  field_values: Record<string, number | string | null>
  /** Comparison-friendly flat totals — derived from sectioned field_values. */
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
  // Boundary translation: mapper emits descriptive keys (income.gross_receipts,
  // deductions.advertising). We translate ONCE here so storage is sectioned
  // IRS-line only (income.L1a_gross_receipts, deductions.L16_advertising or
  // L22 on 1120). No dual-write — keeping both shapes drifts on amendment
  // recompute.
  const descriptive: Record<string, number | string | null> = {}
  for (const f of mapped.fields) {
    descriptive[f.canonical_key] = f.value
  }
  const field_values = descriptiveToSectioned(descriptive, formType) as Record<string, number | string | null>

  // Extract totals from field_values — sectioned IRS-line keys only. The
  // descriptive fallbacks that used to live here are gone now that the
  // mapper output is translated at the boundary.
  const totals: Record<string, number | null> = {}

  if (formType === '1040') {
    totals.total_income          = num(field_values, 'income.L9_total_income')
    totals.agi                   = num(field_values, 'income.L11b_agi')
    totals.taxable_income        = num(field_values, 'tax.L15_taxable_income')
    totals.income_tax            = num(field_values, 'tax.L16_income_tax')
    totals.total_tax             = num(field_values, 'tax.L24_total_tax')
    totals.total_payments        = num(field_values, 'payments.L33_total')
    totals.overpayment           = num(field_values, 'result.L34_overpayment')
    totals.refund                = num(field_values, 'refund.L35a_refunded')
    totals.balance_due           = num(field_values, 'result.L37_balance_due')
    totals.wages                 = num(field_values, 'income.L1z_total_wages', 'income.L1a_w2_wages')
    totals.taxable_interest      = num(field_values, 'income.L2b_taxable_int')
    totals.ordinary_dividends    = num(field_values, 'income.L3b_ord_dividends')
    totals.qualified_dividends   = num(field_values, 'income.L3a_qual_dividends')
    totals.standard_deduction    = num(field_values, 'deductions.L12e_standard', 'deductions.L12_standard')
    totals.qbi_deduction         = num(field_values, 'deductions.L13a_qbi')
    totals.sched_e_rental_net    = num(field_values, 'schedE.L26_rental_royalty_net')
    totals.sched_e_partnership   = num(field_values, 'schedE.L32_partnership_total')
    totals.sched_e_total         = num(field_values, 'schedE.L41_total_income_loss')
  } else if (formType === '1120') {
    totals.gross_receipts        = num(field_values, 'income.L1a_gross_receipts')
    totals.balance_1c            = num(field_values, 'income.L1c_balance')
    totals.cost_of_goods_sold    = num(field_values, 'income.L2_cogs')
    totals.gross_profit          = num(field_values, 'income.L3_gross_profit')
    totals.total_income          = num(field_values, 'income.L11_total_income')
    totals.total_deductions      = num(field_values, 'deductions.L27_total_deductions')
    totals.taxable_income_before_nol = num(field_values, 'tax.L28_ti_before_nol')
    totals.taxable_income        = num(field_values, 'tax.L30_taxable_income')
    totals.total_tax             = num(field_values, 'tax.L31_total_tax')
    totals.total_payments        = num(field_values, 'payments.L33_total_payments')
    totals.balance_due           = num(field_values, 'payments.L35_amount_owed')
    totals.overpayment           = num(field_values, 'payments.L36_overpayment')
    totals.refund                = num(field_values, 'payments.L37_refunded')
  } else if (formType === '1120S') {
    totals.gross_receipts        = num(field_values, 'income.L1a_gross_receipts')
    totals.balance_1c            = num(field_values, 'income.L1c_balance')
    totals.cost_of_goods_sold    = num(field_values, 'income.L2_cogs')
    totals.gross_profit          = num(field_values, 'income.L3_gross_profit')
    totals.total_income          = num(field_values, 'income.L6_total_income', 'income.L11_total_income')
    totals.total_deductions      = num(field_values, 'deductions.L20_total_deductions', 'deductions.L21_total', 'deductions.L27_total_deductions')
    totals.ordinary_income_loss  = num(field_values, 'tax.L21_ordinary_income', 'tax.L22_ordinary_income', 'tax.L30_taxable_income')
    totals.total_tax             = num(field_values, 'tax.L22_total_tax', 'tax.L31_total_tax')
    totals.total_payments        = num(field_values, 'payments.L33_total_payments')
    totals.balance_due           = num(field_values, 'payments.L35_amount_owed')
    totals.overpayment           = num(field_values, 'payments.L36_overpayment')
  }

  return { field_values, totals }
}
