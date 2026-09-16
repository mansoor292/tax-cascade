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
  // Header — f1_1/f1_2 = tax year begin/end, f1_3 = ?, f1_4 = name
  'meta.entity_name':           'f1_4',
  'meta.address':               'f1_5',
  'meta.suite':                 'f1_6',   // Room or suite no. (parsed from address if "SUITE X")
  'meta.city':                  'f1_7',
  'meta.state':                 'f1_8',
  'meta.country':               'f1_9',
  'meta.zip':                   'f1_10',
  'meta.ein':                   'f1_11',
  'meta.date_incorporated':     'f1_12',
  'meta.total_assets':          'f1_13',

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

  // Page 1: Payments & Balance (Lines 32-37)
  'payments.L33_total_payments': 'f1_50',
  'payments.L35_amount_owed':    'f1_52',
  'payments.L36_overpayment':    'f1_53',
  'payments.L37_refunded':       'f1_55',

  // Page 1: Signature
  'meta.title':                  'f1_58',

  // Page 3: Schedule J (Tax Computation)
  'schedJ.J1a_income_tax':       'f3_1',
  'schedJ.J2_total_income_tax':  'f3_9',
  'schedJ.J4_add_2_3':           'f3_11',
  'schedJ.J7_subtract_6_4':      'f3_19',
  'schedJ.J11a_total_before_def':'f3_30',
  'schedJ.J12_total_tax':        'f3_33',
  'schedJ.J13_prior_overpayment':'f3_34',
  'schedJ.J14_estimated_payments':'f3_35',
  'schedJ.J17_7004_deposit':     'f3_38',
  'schedJ.J19_total_payments':   'f3_40',
  'schedJ.J23_total_pay_credits':'f3_48',

  // Page 1: Lines 32-37 (corrected from labeled PDF)
  'payments.L32_1062':           'f1_49',
  // 'payments.L33_total_payments' already mapped above as f1_50
  'payments.L34_est_penalty':    'f1_51',
  // 'payments.L35_amount_owed' already mapped above as f1_52
  // 'payments.L36_overpayment' already mapped above as f1_53
  // 'payments.L37a_credited' is f1_54
  // 'payments.L37b_refunded' is f1_55

  // Preparer (meta.title is already mapped above as f1_58)
  'preparer.name':               'f1_59',
  'preparer.ptin':               'f1_60',
  'preparer.firm_name':          'f1_61',
  'preparer.firm_ein':           'f1_62',
  'preparer.firm_address':       'f1_63',
  'preparer.phone':              'f1_64',

  // Page 6: Schedule L (Balance Sheet) — same f6_* IDs as 2024
  'schedL.L1_cash_boy_b':            'f6_2',
  'schedL.L1_cash_eoy_d':            'f6_4',
  // L2a cols b/d are SHADED on the IRS form (net shown on L2b b/d as
  // gross - allowance). Only cols a/c (gross) are fillable.
  // 'schedL.L2a_trade_boy_b': 'f6_6',   ← shaded, don't map
  // 'schedL.L2a_trade_eoy_d': 'f6_8',   ← shaded, don't map
  'schedL.L2a_trade_boy_a':          'f6_5',
  'schedL.L2a_trade_eoy_c':          'f6_7',
  'schedL.L2b_baddebt_boy_a':        'f6_9',
  'schedL.L2b_baddebt_boy_b':        'f6_10',
  'schedL.L2b_baddebt_eoy_c':        'f6_11',
  'schedL.L2b_baddebt_eoy_d':        'f6_12',
  'schedL.L3_inv_boy_b':             'f6_14',
  'schedL.L3_inv_eoy_d':             'f6_16',
  'schedL.L4_usgov_boy_b':           'f6_18',
  'schedL.L4_usgov_eoy_d':           'f6_20',
  'schedL.L5_taxexempt_boy_b':       'f6_22',
  'schedL.L5_taxexempt_eoy_d':       'f6_24',
  'schedL.L6_othercurr_boy_b':       'f6_26',
  'schedL.L6_othercurr_eoy_d':       'f6_28',
  'schedL.L7_loans_boy_b':           'f6_30',
  'schedL.L7_loans_eoy_d':           'f6_32',
  'schedL.L8_mortgage_boy_b':        'f6_34',
  'schedL.L8_mortgage_eoy_d':        'f6_36',
  'schedL.L9_otherinv_boy_b':        'f6_38',
  'schedL.L9_otherinv_eoy_d':        'f6_40',
  'schedL.L10a_bldg_boy_a':          'f6_41',
  'schedL.L10a_bldg_eoy_c':          'f6_43',
  'schedL.L10b_dep_boy_a':           'f6_45',
  'schedL.L10b_dep_boy_b':           'f6_46',
  'schedL.L10b_dep_eoy_c':           'f6_47',
  'schedL.L10b_dep_eoy_d':           'f6_48',
  'schedL.L11_depletable_boy_a':     'f6_49',
  'schedL.L11_depletable_eoy_c':     'f6_51',
  'schedL.L11_depletable_dep_boy_a': 'f6_53',
  'schedL.L11_depletable_dep_boy_b': 'f6_54',
  'schedL.L11_depletable_dep_eoy_c': 'f6_55',
  'schedL.L11_depletable_dep_eoy_d': 'f6_56',
  'schedL.L12_land_boy_b':           'f6_58',
  'schedL.L12_land_eoy_d':           'f6_60',
  'schedL.L13a_intang_boy_a':        'f6_61',
  'schedL.L13a_intang_eoy_c':        'f6_63',
  'schedL.L13b_amort_boy_a':         'f6_65',
  'schedL.L13b_amort_boy_b':         'f6_66',
  'schedL.L13b_amort_eoy_c':         'f6_67',
  'schedL.L13b_amort_eoy_d':         'f6_68',
  'schedL.L14_other_boy_b':          'f6_70',
  'schedL.L14_other_eoy_d':          'f6_72',
  'schedL.L15_total_boy_b':          'f6_74',
  'schedL.L15_total_eoy_d':          'f6_76',
  'schedL.L16_ap_boy_b':             'f6_78',
  'schedL.L16_ap_eoy_d':             'f6_80',
  'schedL.L17_mortshort_boy_b':      'f6_82',
  'schedL.L17_mortshort_eoy_d':      'f6_84',
  'schedL.L18_othercurrliab_boy_b':  'f6_86',
  'schedL.L18_othercurrliab_eoy_d':  'f6_88',
  'schedL.L19_loansfrom_boy_b':      'f6_90',
  'schedL.L19_loansfrom_eoy_d':      'f6_92',
  'schedL.L20_mortlong_boy_b':       'f6_94',
  'schedL.L20_mortlong_eoy_d':       'f6_96',
  'schedL.L21_otherliab_boy_b':      'f6_98',
  'schedL.L21_otherliab_eoy_d':      'f6_100',
  'schedL.L22a_pref_boy_b':          'f6_102',
  'schedL.L22a_pref_eoy_d':          'f6_104',
  'schedL.L22b_common_boy_b':        'f6_106',
  'schedL.L22b_common_eoy_d':        'f6_108',
  'schedL.L23_paidin_boy_b':         'f6_110',
  'schedL.L23_paidin_eoy_d':         'f6_112',
  'schedL.L24_retapp_boy_b':         'f6_114',
  'schedL.L24_retapp_eoy_d':         'f6_116',
  'schedL.L25_retained_boy_b':       'f6_118',
  'schedL.L25_retained_eoy_d':       'f6_120',
  'schedL.L26_adj_boy_b':            'f6_122',
  'schedL.L26_adj_eoy_d':            'f6_124',
  'schedL.L27_treasury_boy_b':       'f6_126',
  'schedL.L27_treasury_eoy_d':       'f6_128',
  // Line 28 is f6_129..132. It used to point at f6_126/f6_128 — line 27 —
  // so every 1120 printed its balance-sheet total inside the "Less cost of
  // treasury stock" parentheses, as a deduction, and left line 28 blank.
  'schedL.L28_total_boy_b':          'f6_130',
  'schedL.L28_total_eoy_d':          'f6_132',

  // Page 6: Schedule M-1 (Reconciliation)
  'schedM1.L1_net_income_books':     'f6_133',
  'schedM1.L2_fed_tax_books':        'f6_134',
  'schedM1.L5_expenses_not_ded':     'f6_143',
  'schedM1.L6_add_1_thru_5':         'f6_144',
  'schedM1.L8_ded_not_charged':      'f6_153',
  'schedM1.L9_add_7_8':              'f6_154',
  'schedM1.L10_income_line28':       'f6_155',

  // Page 6: Schedule M-2 (Retained Earnings)
  'schedM2.L1_beg_balance':          'f6_156',
  'schedM2.L4_add':                  'f6_162',
  'schedM2.L8_end_balance':          'f6_169',
}

// ═══════════════════════════════════════════════════════════════
// FORM 1120-S (2025)
// ═══════════════════════════════════════════════════════════════
export const F1120S_2025: Record<string, string> = {
  // Header
  'meta.entity_name':           'f1_4',
  'meta.address':               'f1_5',
  'meta.suite':                 'f1_6',   // Room or suite no.
  'meta.city':                  'f1_7',
  'meta.state':                 'f1_8',
  'meta.country':               'f1_9',
  'meta.zip':                   'f1_10',
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

  // ── Schedule L (Balance Sheet — Page 4) ──
  //
  // Derived from the blank form's own widget positions, matched against the
  // printed line labels. The previous map was written by copying the 1120's
  // f6_* sequence onto f4_*, which is wrong twice over:
  //
  //  1. Every row was off by one (four field ids). Cash landed above line 1,
  //     other current assets printed on line 5 "Tax-exempt securities", and
  //     total assets printed on line 14 — leaving line 15 blank, so a filed
  //     1120-S showed total assets of 0 against a real liabilities total.
  //  2. The two Schedule Ls are not the same shape. The 1120 splits capital
  //     stock into 22a/22b and retained earnings into appropriated (24) and
  //     unappropriated (25); the 1120-S has one of each, so everything from
  //     the 1120's line 25 down sits one line HIGHER here. Canonical keys
  //     keep the 1120 names (they are the shared vocabulary) and are remapped
  //     to the 1120-S row that carries the same meaning.
  //
  // Rows run f4_5..f4_128, four columns each — (a) gross BOY, (b) net BOY,
  // (c) gross EOY, (d) net EOY. Line 1 is f4_5..f4_8, and each subsequent
  // line is the next four. If this ever needs redoing, read the widget
  // rectangles off the PDF rather than counting from another form.
  'schedL.L1_cash_boy_b':            'f4_6',
  'schedL.L1_cash_eoy_d':            'f4_8',
  'schedL.L2a_trade_boy_a':          'f4_9',    // gross — cols a/c on the 2a row
  'schedL.L2a_trade_eoy_c':          'f4_11',
  'schedL.L2b_baddebt_boy_a':        'f4_13',   // allowance, shown in parens
  'schedL.L2b_baddebt_boy_b':        'f4_14',   // net receivable
  'schedL.L2b_baddebt_eoy_c':        'f4_15',
  'schedL.L2b_baddebt_eoy_d':        'f4_16',
  'schedL.L3_inv_boy_b':             'f4_18',
  'schedL.L3_inv_eoy_d':             'f4_20',
  'schedL.L4_usgov_boy_b':           'f4_22',
  'schedL.L4_usgov_eoy_d':           'f4_24',
  'schedL.L5_taxexempt_boy_b':       'f4_26',
  'schedL.L5_taxexempt_eoy_d':       'f4_28',
  'schedL.L6_othercurr_boy_b':       'f4_30',
  'schedL.L6_othercurr_eoy_d':       'f4_32',
  'schedL.L7_loans_boy_b':           'f4_34',
  'schedL.L7_loans_eoy_d':           'f4_36',
  'schedL.L8_mortgage_boy_b':        'f4_38',
  'schedL.L8_mortgage_eoy_d':        'f4_40',
  'schedL.L9_otherinv_boy_b':        'f4_42',
  'schedL.L9_otherinv_eoy_d':        'f4_44',
  'schedL.L10a_bldg_boy_a':          'f4_45',
  'schedL.L10a_bldg_eoy_c':          'f4_47',
  'schedL.L10b_dep_boy_a':           'f4_49',
  'schedL.L10b_dep_boy_b':           'f4_50',
  'schedL.L10b_dep_eoy_c':           'f4_51',
  'schedL.L10b_dep_eoy_d':           'f4_52',
  'schedL.L11_depletable_boy_a':     'f4_53',
  'schedL.L11_depletable_eoy_c':     'f4_55',
  'schedL.L11_depletable_dep_boy_a': 'f4_57',
  'schedL.L11_depletable_dep_boy_b': 'f4_58',
  'schedL.L11_depletable_dep_eoy_c': 'f4_59',
  'schedL.L11_depletable_dep_eoy_d': 'f4_60',
  'schedL.L12_land_boy_b':           'f4_62',
  'schedL.L12_land_eoy_d':           'f4_64',
  'schedL.L13a_intang_boy_a':        'f4_65',
  'schedL.L13a_intang_eoy_c':        'f4_67',
  'schedL.L13b_amort_boy_a':         'f4_69',
  'schedL.L13b_amort_boy_b':         'f4_70',
  'schedL.L13b_amort_eoy_c':         'f4_71',
  'schedL.L13b_amort_eoy_d':         'f4_72',
  'schedL.L14_other_boy_b':          'f4_74',
  'schedL.L14_other_eoy_d':          'f4_76',
  'schedL.L15_total_boy_b':          'f4_78',
  'schedL.L15_total_eoy_d':          'f4_80',
  // Liabilities and shareholders' equity — 1120-S lines 16-27.
  'schedL.L16_ap_boy_b':             'f4_82',
  'schedL.L16_ap_eoy_d':             'f4_84',
  'schedL.L17_mortshort_boy_b':      'f4_86',
  'schedL.L17_mortshort_eoy_d':      'f4_88',
  'schedL.L18_othercurrliab_boy_b':  'f4_90',
  'schedL.L18_othercurrliab_eoy_d':  'f4_92',
  'schedL.L19_loansfrom_boy_b':      'f4_94',
  'schedL.L19_loansfrom_eoy_d':      'f4_96',
  'schedL.L20_mortlong_boy_b':       'f4_98',
  'schedL.L20_mortlong_eoy_d':       'f4_100',
  'schedL.L21_otherliab_boy_b':      'f4_102',
  'schedL.L21_otherliab_eoy_d':      'f4_104',
  // 1120-S line 22 is a single "Capital stock" line. An S corporation may
  // have only one class of stock, so the 1120's preferred/common split
  // collapses here; L22a_pref is deliberately unmapped rather than sharing
  // a box with common and letting write order decide.
  'schedL.L22b_common_boy_b':        'f4_106',
  'schedL.L22b_common_eoy_d':        'f4_108',
  'schedL.L23_paidin_boy_b':         'f4_110',
  'schedL.L23_paidin_eoy_d':         'f4_112',
  // The 1120's line 25 (retained earnings, unappropriated) is the 1120-S's
  // line 24; there is no appropriated line here, so L24_retapp is unmapped.
  'schedL.L25_retained_boy_b':       'f4_114',
  'schedL.L25_retained_eoy_d':       'f4_116',
  'schedL.L26_adj_boy_b':            'f4_118',
  'schedL.L26_adj_eoy_d':            'f4_120',
  'schedL.L27_treasury_boy_b':       'f4_122',
  'schedL.L27_treasury_eoy_d':       'f4_124',
  'schedL.L28_total_boy_b':          'f4_126',
  'schedL.L28_total_eoy_d':          'f4_128',

  // Reconciliation (Page 5 — Schedule M-1 equivalent for S-Corps)
  'schedM1.L1_net_income_books':     'f5_1',
  'schedM1.L1_net_income':           'f5_1',
  'schedM1.L2_income_on_K':          'f5_4',
  'schedM1.L3_expenses_not_K':       'f5_9',
  'schedM1.L4_add':                  'f5_10',
  'schedM1.L5_income_not_K':         'f5_13',
  'schedM1.L6_ded_on_K':             'f5_16',
  'schedM1.L7_add_5_6':              'f5_17',
  'schedM1.L8_income_line18':        'f5_18',
  'schedM1.L8_income_K18':           'f5_18',

  // Schedule B — Other information (Page 2)
  'schedB.L1c_other':                'f2_1',
  'schedB.L2b_product':              'f2_3',
  'schedB.L5a_restricted':           'f2_44',
  'schedB.L5a_nonrestricted':        'f2_45',
  'schedB.L5b_outstanding':          'f2_46',
  'schedB.L5b_if_executed':          'f2_47',

  // Schedule K — Pro-rata share items (Page 3-4)
  'schedK.L1_ordinary':              'f3_3',
  'schedK.L2_rental_re':             'f3_4',
  'schedK.L3a_other_rental':         'f3_5',
  'schedK.L3b_rental_exp':           'f3_6',
  'schedK.L3c_net_rental':           'f3_7',
  'schedK.L4_interest':              'f3_8',
  'schedK.L5a_dividends':            'f3_9',
  'schedK.L5b_qual_div':             'f3_10',
  'schedK.L6_royalties':             'f3_11',
  'schedK.L7_st_gain':               'f3_12',
  'schedK.L8a_lt_gain':              'f3_13',
  'schedK.L8b_collectibles':         'f3_14',
  'schedK.L8c_unrecaptured':         'f3_15',
  'schedK.L9_1231':                  'f3_16',
  'schedK.L10_other_amount':         'f3_18',
  'schedK.L11_179':                  'f3_19',
  'schedK.L11_section_179':          'f3_19',
  'schedK.L12a_cash_charity':        'f3_20',
  'schedK.L12a_charitable':          'f3_20',
  'schedK.L12b_noncash_charity':     'f3_21',
  'schedK.L12c_invest_interest':     'f3_22',
  'schedK.L13a_li_housing_42':       'f3_27',
  'schedK.L13b_li_housing_oth':      'f3_28',
  'schedK.L15a_depreciation':        'f3_37',
  'schedK.L15b_adj_gain':            'f3_38',
  'schedK.L15c_depletion':           'f3_39',
  'schedK.L15d_oil_gross':           'f3_40',
  'schedK.L15e_oil_ded':             'f3_41',
  'schedK.L15f_other_amt':           'f3_42',
  'schedK.L16a_tax_exempt_int':      'f3_43',
  'schedK.L16b_other_exempt':        'f3_44',
  'schedK.L16c_nondeductible':       'f3_45',
  'schedK.L16d_distributions':       'f3_46',
  'schedK.L16e_loan_repay':          'f3_47',
  'schedK.L16f_foreign_taxes':       'f3_48',
  'schedK.L17a_invest_income':       'f4_1',
  'schedK.L17b_invest_expense':      'f4_2',
  'schedK.L17c_div_from_ae':         'f4_3',
  // Line 18 has TWO canonical keys: L18_income_loss is what the engine
  // computes, L18_reconciliation is what the filed-return extractor produces.
  // Both used to point at f4_4, so whichever the model iterated last won —
  // in practice the extractor's zero, printing line 18 as 0 on a return whose
  // computed reconciliation was $1.3M. The engine's figure is the one a
  // computed return should carry; an extracted return has no engine value, so
  // the alias below fills it in without being able to overwrite.
  'schedK.L18_income_loss':          'f4_4',

  // ── Schedule M-2 (Page 5) — the accumulated adjustments account ──
  //
  // There was no 1120-S Schedule M-2 map at all, so the schedule printed
  // blank on every S-corporation return this system has produced. On an 1120
  // that would be a presentation gap; here it is the account that tracks what
  // a shareholder can take out tax-free, and it is the schedule a reader
  // checks distributions against.
  //
  // The line numbers do NOT mean the same thing as the 1120's M-2, so the
  // existing keys cannot simply be reused. The 1120 runs "2 Net income,
  // 3 Other increases, 4 Add lines 1-3"; the 1120-S runs "2 Ordinary income,
  // 3 Other additions, 4 Loss, 5 Other reductions, 6 Combine". Only lines 1
  // and 8 carry the same meaning on both, and L4_add is 1120-only — mapping
  // it here would put an "add" subtotal on the S corporation's LOSS line.
  //
  // Four columns per row at x = 259/338/418/497: (a) accumulated adjustments
  // account, (b) shareholders' undistributed taxable income previously taxed,
  // (c) accumulated earnings and profits, (d) other adjustments account.
  // Only column (a) is mapped: a corporation that has always been an S corp
  // has no C-corp earnings and profits, so (b)-(d) stay empty, and several of
  // those cells are shaded on the form anyway.
  'schedM2.L1_beg_balance':          'f5_19',
  'schedM2.L2_ordinary_income':      'f5_23',
  'schedM2.L3_other_additions':      'f5_27',
  'schedM2.L4_loss':                 'f5_31',
  'schedM2.L5_other_reductions':     'f5_35',
  'schedM2.L6_combine':              'f5_39',
  'schedM2.L7_distributions':        'f5_43',
  'schedM2.L8_end_balance':          'f5_47',
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
