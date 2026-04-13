/**
 * Engine output key → PDF canonical key mappings
 *
 * The tax engine uses short keys (gross_receipts, total_income).
 * The pdf_field_map uses IRS-line canonical keys (income.L1a_gross_receipts).
 * This bridges the two so computed returns can fill PDFs.
 */

export const ENGINE_TO_PDF_1120: Record<string, string> = {
  // Inputs → canonical
  'gross_receipts':        'income.L1a_gross_receipts',
  'returns_allowances':    'income.L1b_returns',
  'cost_of_goods_sold':    'income.L2_cogs',
  'dividends':             'income.L4_dividends',
  'interest_income':       'income.L5_interest',
  'gross_rents':           'income.L6_gross_rents',
  'gross_royalties':       'income.L7_gross_royalties',
  'capital_gains':         'income.L8_capital_gains',
  'net_gain_4797':         'income.L9_net_gain_4797',
  'other_income':          'income.L10_other_income',
  'officer_compensation':  'deductions.L12_officer_comp',
  'salaries_wages':        'deductions.L13_salaries',
  'repairs_maintenance':   'deductions.L14_repairs',
  'bad_debts':             'deductions.L15_bad_debts',
  'rents':                 'deductions.L16_rents',
  'taxes_licenses':        'deductions.L17_taxes_licenses',
  'interest_expense':      'deductions.L18_interest',
  'charitable_contrib':    'deductions.L19_charitable',
  'depreciation':          'deductions.L20_depreciation',
  'depletion':             'deductions.L21_depletion',
  'advertising':           'deductions.L22_advertising',
  'pension_plans':         'deductions.L23_pension',
  'employee_benefits':     'deductions.L24_employee_benefits',
  'other_deductions':      'deductions.L26_other_deductions',
  'nol_deduction':         'tax.L29a_nol',
  'special_deductions':    'tax.L29b_special_ded',
  'estimated_tax_paid':    'schedJ.J13_estimated_payments',
  // Computed → canonical
  'balance_1c':            'income.L1c_balance',
  'gross_profit':          'income.L3_gross_profit',
  'total_income':          'income.L11_total_income',
  'total_deductions':      'deductions.L27_total_deductions',
  'taxable_income_before_nol': 'tax.L28_ti_before_nol',
  'taxable_income':        'tax.L30_taxable_income',
  'income_tax':            'tax.L31_total_tax',
  'total_tax':             'tax.L31_total_tax',
}

export const ENGINE_TO_PDF_1120S: Record<string, string> = {
  // Inputs → canonical
  'gross_receipts':        'income.L1a_gross_receipts',
  'returns_allowances':    'income.L1b_returns',
  'cost_of_goods_sold':    'income.L2_cogs',
  'net_gain_4797':         'income.L4_net_gain_4797',
  'other_income':          'income.L5_other_income',
  'officer_compensation':  'deductions.L7_officer_comp',
  'salaries_wages':        'deductions.L8_salaries',
  'repairs_maintenance':   'deductions.L9_repairs',
  'bad_debts':             'deductions.L10_bad_debts',
  'rents':                 'deductions.L11_rents',
  'taxes_licenses':        'deductions.L12_taxes',
  'interest':              'deductions.L13_interest',
  'depreciation':          'deductions.L14_depreciation',
  'depletion':             'deductions.L15_depletion',
  'advertising':           'deductions.L16_advertising',
  'pension_plans':         'deductions.L17_pension',
  'employee_benefits':     'deductions.L18_employee_benefits',
  'other_deductions':      'deductions.L20_other',
  // Computed → canonical
  'balance_1c':            'income.L1c_balance',
  'gross_profit':          'income.L3_gross_profit',
  'total_income':          'income.L6_total_income',
  'total_deductions':      'deductions.L21_total',
  'ordinary_income_loss':  'tax.L22_ordinary_income',
}

export const ENGINE_TO_PDF_1040: Record<string, string> = {
  // Inputs → canonical
  'wages':                 'income.L1z_total_wages',
  'taxable_interest':      'income.L2b_taxable_int',
  'ordinary_dividends':    'income.L3b_ord_dividends',
  'qualified_dividends':   'income.L3a_qual_dividends',
  'capital_gains':         'income.L7a_capital_gains',
  'schedule1_income':      'income.L8_schedule1',
  'withholding':           'payments.L25d_total',
  'estimated_payments':    'payments.L26_estimated',
  // Computed → canonical
  'total_income':          'income.L9_total_income',
  'agi':                   'income.L11b_agi',
  'standard_deduction':    'deductions.L14_total',
  'qbi_deduction':         'deductions.L13a_qbi',
  'taxable_income':        'tax.L15_taxable_income',
  'income_tax':            'tax.L16_income_tax',
  'total_tax':             'tax.L24_total_tax',
  'total_payments':        'payments.L33_total',
  'balance_due':           'result.L37_balance_due',
  'refund':                'refund.L35a_refunded',
}

export function getEngineToCanonicalMap(formType: string): Record<string, string> {
  switch (formType) {
    case '1120': return ENGINE_TO_PDF_1120
    case '1120S': return ENGINE_TO_PDF_1120S
    case '1040': return ENGINE_TO_PDF_1040
    default: return {}
  }
}
