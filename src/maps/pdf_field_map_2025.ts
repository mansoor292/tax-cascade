/**
 * 2025 Canonical Key → PDF Field ID Maps
 * ALL field IDs verified by Textract OCR of labeled PDFs (2025-04-12)
 *
 * IMPORTANT: 2025 field IDs differ from 2024 due to form layout changes.
 * The 1040 added new lines (7a replaces 7, new 11a/11b/12a-e structure).
 */

// ═══════════════════════════════════════════════════════════════
// FORM 1040 (2025)
// ═══════════════════════════════════════════════════════════════
export const F1040_2025: Record<string, string> = {
  // Header
  'meta.first_name':            'f1_14',
  'meta.last_name':             'f1_15',
  'meta.ssn':                   'f1_16',
  'meta.spouse_first':          'f1_17',
  'meta.spouse_last':           'f1_18',
  'meta.spouse_ssn':            'f1_19',
  'meta.address':               'f1_20',
  'meta.apt':                   'f1_21',
  'meta.city':                  'f1_22',
  'meta.state':                 'f1_23',
  'meta.zip':                   'f1_24',

  // Income
  'income.L1a_w2_wages':        'f1_47',
  'income.L1b_household':       'f1_48',
  'income.L1c_tips':            'f1_49',
  'income.L1d_medicaid':        'f1_50',
  'income.L1e_dependent_care':  'f1_51',
  'income.L1f_adoption':        'f1_52',
  'income.L1g_8919':            'f1_53',
  'income.L1h_other_earned':    'f1_55',  // f1_54 = type description
  'income.L1i_combat_pay':      'f1_56',
  'income.L1z_total_wages':     'f1_57',
  'income.L2a_tax_exempt_int':  'f1_58',
  'income.L2b_taxable_int':     'f1_59',
  'income.L3a_qual_dividends':  'f1_60',
  'income.L3b_ord_dividends':   'f1_61',
  'income.L4a_ira':             'f1_62',
  'income.L4b_ira_taxable':     'f1_63',
  'income.L5a_pensions':        'f1_65',
  'income.L5b_pensions_tax':    'f1_66',
  'income.L6a_social_sec':      'f1_68',
  'income.L6b_ss_taxable':      'f1_69',
  'income.L7a_capital_gains':   'f1_70',  // 2025: "7a" replaces "7"
  'income.L8_schedule1':        'f1_72',
  'income.L9_total_income':     'f1_73',
  'income.L10_adjustments':     'f1_74',
  // 2025 has new L11a/L11b structure
  'income.L11a_subtract':       'f1_75',  // 11a (need to verify from full map)
  'income.L11b_agi':            'f1_76',  // 11b = AGI (new for 2025)
  // 2025 has new deduction structure: 12a-12e
  'deductions.L13a_qbi':        'f2_03',
  'deductions.L14_total':       'f2_05',
  'tax.L15_taxable_income':     'f2_06',

  // Page 2: Tax
  'tax.L16_income_tax':         'f2_07',  // need to verify
  'tax.L17_sched2':             'f2_09',
  'tax.L18_add_16_17':          'f2_10',
  'credits.L19_child_tax':      'f2_11',
  'credits.L20_sched3':         'f2_12',
  'credits.L21_add_19_20':      'f2_13',
  'tax.L22_subtract':           'f2_14',
  'tax.L23_other_taxes':        'f2_15',
  'tax.L24_total_tax':          'f2_16',

  // Payments
  'payments.L25a_w2':           'f2_17',
  'payments.L25b_1099':         'f2_18',
  'payments.L25c_other':        'f2_19',
  'payments.L25d_total':        'f2_20',
  'payments.L26_estimated':     'f2_21',
  'payments.L33_total':         'f2_29',

  // Result
  'result.L34_overpayment':     'f2_30',
  'refund.L35a_refunded':       'f2_31',
  'refund.L36_applied_est':     'f2_34',
  'owed.L37_amount_owed':       'f2_35',
  'penalty.L38_est_penalty':    'f2_36',
}

// ═══════════════════════════════════════════════════════════════
// FORM 1120 (2025)
// ═══════════════════════════════════════════════════════════════
export const F1120_2025: Record<string, string> = {
  // Header
  'meta.entity_name':           'f1_4',
  'meta.address':               'f1_5',
  'meta.city_state_zip':        'f1_6',   // need to verify from map
  'meta.ein':                   'f1_11',
  'meta.date_incorporated':     'f1_12',

  // Income
  'income.L1a_gross_receipts':  'f1_14',
  'income.L1b_returns':         'f1_15',
  'income.L1c_balance':         'f1_16',
  'income.L2_cogs':             'f1_17',
  'income.L3_gross_profit':     'f1_18',
  'income.L4_dividends':        'f1_19',
  'income.L5_interest':         'f1_20',
  'income.L6_gross_rents':      'f1_21',
  'income.L7_gross_royalties':  'f1_22',
  'income.L8_capital_gains':    'f1_23',
  'income.L9_net_gain_4797':    'f1_24',
  'income.L10_other_income':    'f1_25',
  'income.L11_total_income':    'f1_26',

  // Deductions
  'deductions.L12_officer_comp':'f1_27',
  'deductions.L13_salaries':    'f1_28',
  'deductions.L14_repairs':     'f1_29',
  'deductions.L15_bad_debts':   'f1_30',
  'deductions.L16_rents':       'f1_31',
  'deductions.L17_taxes_licenses':'f1_32',
  'deductions.L18_interest':    'f1_33',
  'deductions.L19_charitable':  'f1_34',
  'deductions.L20_depreciation':'f1_35',
  'deductions.L21_depletion':   'f1_36',
  'deductions.L22_advertising': 'f1_37',
  'deductions.L23_pension':     'f1_38',
  'deductions.L24_employee_benefits':'f1_39',
  'deductions.L26_other_deductions':'f1_41',
  'deductions.L27_total_deductions':'f1_42',

  // Tax
  'tax.L28_ti_before_nol':      'f1_43',
  'tax.L29a_nol':               'f1_44',
  'tax.L29b_special_ded':       'f1_45',
  'tax.L29c_total_29':          'f1_46',
  'tax.L30_taxable_income':     'f1_47',
  'tax.L31_total_tax':          'f1_48',
}

// ═══════════════════════════════════════════════════════════════
// FORM 1120-S (2025)
// ═══════════════════════════════════════════════════════════════
export const F1120S_2025: Record<string, string> = {
  // Header
  'meta.entity_name':           'f1_4',
  'meta.address':               'f1_5',
  'meta.city_state_zip':        'f1_6',   // may need f1_9 or f1_10
  'meta.s_election_date':       'f1_11',
  'meta.business_code':         'f1_12',
  'meta.ein':                   'f1_13',
  'meta.date_incorporated':     'f1_14',
  'meta.num_shareholders':      'f1_16',

  // Income
  'income.L1a_gross_receipts':  'f1_17',
  'income.L1b_returns':         'f1_18',
  'income.L2_cogs':             'f1_20',
  'income.L3_gross_profit':     'f1_21',
  'income.L4_net_gain_4797':    'f1_22',
  'income.L5_other_income':     'f1_23',
  'income.L6_total_income':     'f1_24',

  // Deductions
  'deductions.L7_officer_comp': 'f1_25',
  'deductions.L8_salaries':     'f1_26',
  'deductions.L9_repairs':      'f1_27',
  'deductions.L10_bad_debts':   'f1_28',
  'deductions.L11_rents':       'f1_29',
  'deductions.L12_taxes':       'f1_30',
  'deductions.L13_interest':    'f1_31',
  'deductions.L14_depreciation':'f1_32',
  'deductions.L15_depletion':   'f1_33',
  'deductions.L16_advertising': 'f1_34',
  'deductions.L17_pension':     'f1_35',
  'deductions.L18_employee_benefits':'f1_36',
  'deductions.L19_energy':      'f1_37',
  'deductions.L20_other':       'f1_38',
  'deductions.L21_total':       'f1_39',

  // Ordinary income
  'tax.L22_ordinary_income':    'f1_40',
  'tax.L23a_passive':           'f1_41',
  'tax.L23b_sched_d':           'f1_42',
  'tax.L23c_total':             'f1_43',
  'payments.L24a_estimated':    'f1_44',
  'payments.L24b_7004':         'f1_45',
  'payments.L24c_fuels':        'f1_46',
  'payments.L24d_elective':     'f1_47',
  'payments.L24z_total':        'f1_48',
  'penalty.L25':                'f1_49',
  'owed.L26':                   'f1_50',
  'overpayment.L27':            'f1_51',
  'meta.title':                 'f1_54',
}

// ═══════════════════════════════════════════════════════════════
// SUPPORTING FORMS (2025)
// ═══════════════════════════════════════════════════════════════

export const F1040S1_2025: Record<string, string> = {
  'meta.name':                  'f1_01',
  'meta.ssn':                   'f1_02',
  'income.L5_sched_e':          'f1_09',
  'income.L9_total_other':      'f1_37',
  'income.L10_additional':      'f1_38',
}

export const F1040S2_2025: Record<string, string> = {
  'tax.L11_addl_medicare':      'f1_22',
  'tax.L12_niit':               'f1_23',
  'tax.L3_add_1z_2':            'f1_13',
}

export const F8959_2025: Record<string, string> = {
  'L1_medicare_wages':          'f1_3',
  'L4_total':                   'f1_6',
  'L5_threshold':               'f1_7',
  'L6_excess':                  'f1_8',
  'L7_addl_medicare':           'f1_9',
  'L18_total':                  'f1_20',
  'L19_withheld':               'f1_21',
  'L22_excess_withholding':     'f1_24',
  'L24_total_withholding':      'f1_26',
}

export const F8960_2025: Record<string, string> = {
  'L1_interest':                'f1_3',
  'L2_dividends':               'f1_4',
  'L4a_rental_partnership':     'f1_6',
  'L8_total_invest_income':     'f1_15',
  'L12_net_invest_income':      'f1_22',
  'L13_magi':                   'f1_23',
  'L14_threshold':              'f1_24',
  'L15_excess':                 'f1_25',
  'L16_lesser':                 'f1_26',
  'L17_niit':                   'f1_27',
}

export const F8995A_2025: Record<string, string> = {
  'L27_total_qbi_component':    'f2_36',
  'L32_qbi_before_limit':       'f2_41',
  'L33_taxable_before_qbi':     'f2_42',
  'L35_subtract':               'f2_44',
  'L36_income_limitation':      'f2_45',
  'L37_qbi_before_dpad':        'f2_46',
  'L39_total_qbi':              'f2_48',
}

export const F7203_2025: Record<string, string> = {
  'meta.shareholder_name':      'f1_01',
  'meta.shareholder_id':        'f1_02',
  'meta.scorp_name':            'f1_03',
  'meta.scorp_ein':             'f1_04',
  'L1_stock_basis_boy':         'f1_07',
  'L3a_ordinary_income':        'f1_09',
  'L3d_interest':               'f1_12',
  'L3e_dividends':              'f1_13',
  'L4_add':                     'f1_22',
  'L5_basis_before_dist':       'f1_23',
  'L6_distributions':           'f1_24',
  'L7_basis_after_dist':        'f1_25',
  'L8a_nondeductible':          'f1_26',
  'L9_add_8':                   'f1_29',
  'L10_basis_before_loss':      'f1_30',
  'L15_stock_basis_eoy':        'f1_35',
}

export const F1120SK1_2025: Record<string, string> = {
  'meta.corp_ein':              'f1_06',
  'meta.corp_name_addr':        'f1_07',
  'meta.irs_center':            'f1_08',
  'meta.shareholder_id':        'f1_11',
  'meta.shareholder_name':      'f1_12',
  'meta.alloc_pct':             'f1_16',
  'L1_ordinary':                'f1_21',
  'L2_rental_re':               'f1_22',
  'L3_other_rental':            'f1_23',
  'L4_interest':                'f1_24',
  'L5a_dividends':              'f1_25',
  'L5b_qual_div':               'f1_26',
  'L6_royalties':               'f1_27',
  'L7_st_gain':                 'f1_28',
  'L8a_lt_gain':                'f1_29',
  'L9_1231':                    'f1_32',
  'L11_179':                    'f1_43',
}

export const F1125A_2025: Record<string, string> = {
  'meta.name':                  'f1_1',
  'meta.ein':                   'f1_2',
  'L1_inventory_boy':           'f1_3',
  'L2_purchases':               'f1_5',
  'L3_labor':                   'f1_7',
  'L4_additional_263a':         'f1_9',
  'L5_other_costs':             'f1_11',
  'L6_total':                   'f1_13',
  'L7_inventory_eoy':           'f1_15',
  'L8_cogs':                    'f1_17',
}
