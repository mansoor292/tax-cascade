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
  // 11a is the last money box on page 1; 11b opens page 2, so the pair
  // straddles the page break. L11b_agi was 'f1_76' — a page-1 id that is not
  // the AGI box — so adjusted gross income printed nowhere on a 2025 return.
  // Likewise 12e and 13b were absent entirely and the standard deduction never
  // appeared, on the form for the year currently being filed.
  'income.L11a_subtract':       'f1_75',  // verified: 11a, page 1
  'income.L11b_agi':            'f2_01',  // verified: 11b, page 2
  'deductions.L12e_standard':   'f2_02',  // verified
  'deductions.L13a_qbi':        'f2_03',
  'deductions.L13b_addl':       'f2_04',  // verified: Schedule 1-A, new for 2025
  'deductions.L14_total':       'f2_05',
  'tax.L15_taxable_income':     'f2_06',

  // Page 2: Tax
  'tax.L16_income_tax':         'f2_08',  // verified: f2_07 is the "Check if
                                            // any from Form(s): 3 ___" write-in
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
  // 27-32 were unmapped: the fuzzy label matcher then put whichever twin key
  // it met first on line 31 (a stored 0), so a six-figure Schedule 3 total
  // printed as 0 and line 32 was blank. Verified against the 2025 blank and
  // the filed 2025 joint return (scripts/parity/).
  'payments.L27_eic':           'f2_23',
  'payments.L28_child_addl':    'f2_24',
  'payments.L29_aoc':           'f2_25',
  'payments.L30_reserved':      'f2_26',
  'payments.L31_sched3':        'f2_27',
  'payments.L32_other_total':   'f2_28',
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
  'schedL.L2b_baddebt_eoy_c':        'f6_11',
  // Line 2b columns (b)/(d), f6_10/f6_12, are the NET receivable (2a less the
  // allowance), not the allowance — mapping the allowance there printed a
  // receivable as 0. fill1120Extras writes the net.
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
  // M-1 detail amounts (rects verified against the 2025 blank). The itemize
  // TEXT lines (f6_136/137, 142, 146/147, 151/152) are written by
  // fill1120Extras from input_data.schedM1_L*_items.
  'schedM1.L3_excess_cap_losses':    'f6_135',
  'schedM1.L4_income_not_recorded':  'f6_138',
  'schedM1.L5a_depreciation':        'f6_139',
  'schedM1.L5b_charitable':          'f6_140',
  'schedM1.L5c_travel_ent':          'f6_141',
  'schedM1.L5_expenses_not_ded':     'f6_143',
  'schedM1.L6_add_1_thru_5':         'f6_144',
  'schedM1.L7a_tax_exempt_interest': 'f6_145',
  'schedM1.L7_income_not_included':  'f6_148',
  'schedM1.L8a_depreciation':        'f6_149',
  'schedM1.L8b_charitable':          'f6_150',
  'schedM1.L8_ded_not_charged':      'f6_153',
  'schedM1.L9_add_7_8':              'f6_154',
  'schedM1.L10_income_line28':       'f6_155',

  // Page 6: Schedule M-2 (Retained Earnings)
  // Lines 2, 5a-c, 6 and 7 were unmapped, so the fuzzy label matcher placed
  // them — 5a (cash distributions) landed on Schedule J line 5a, the foreign
  // tax credit. Rects verified against the blank: left column 2-4, right 5-8.
  'schedM2.L1_beg_balance':          'f6_156',
  'schedM2.L2_net_income':           'f6_157',
  'schedM2.L3_other_increases':      'f6_161',
  'schedM2.L4_add':                  'f6_162',
  'schedM2.L5a_cash_distributions':  'f6_163',
  'schedM2.L5b_stock_distributions': 'f6_164',
  'schedM2.L5c_property_distributions': 'f6_165',
  'schedM2.L6_other_decreases':      'f6_167',
  'schedM2.L7_add_5_6':              'f6_168',
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
  'meta.total_assets':          'f1_15',
  'meta.num_shareholders':      'f1_16',

  // Income
  'income.L1a_gross_receipts':  'f1_17',
  'income.L1b_returns':         'f1_18',
  'income.L1c_balance':         'f1_19',
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
  'refund.L28_credited':        'f1_52',
  'refund.L28_refunded':        'f1_53',
  // f1_54/f1_55 are the direct-deposit routing and account numbers; the
  // officer's title is f1_56. The title once went to f1_54 and printed
  // "PRESIDENT" in the routing-number boxes.
  'meta.title':                 'f1_56',

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
  // One key per box — L1_net_income was mapped here too, so whichever the
  // model iterated last decided what line 1 printed. The engine emits
  // L1_net_income (ordinary income); the book figure belongs on this line and
  // reaches it through SCHEDULE_TWINS when nothing sets it explicitly.
  'schedM1.L1_net_income_books':     'f5_1',
  'schedM1.L2_income_on_K':          'f5_4',
  'schedM1.L3_expenses_not_K':       'f5_9',
  'schedM1.L4_add':                  'f5_10',
  'schedM1.L5_income_not_K':         'f5_13',
  'schedM1.L6_ded_on_K':             'f5_16',
  'schedM1.L7_add_5_6':              'f5_17',
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
  // One key per box. L11_section_179 and L12a_charitable used to be mapped
  // here as well, both onto these same two fields, so whichever the model
  // iterated last decided what printed — the defect that had line 18 showing
  // zero against a $1.3M reconciliation. The 2024 map never had them. The
  // engine emits those spellings, so they reach the box through SCHED_K_TWINS
  // in build_return_pdf rather than through a second mapping.
  'schedK.L11_179':                  'f3_19',
  'schedK.L12a_cash_charity':        'f3_20',
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

// ═══════════════════════════════════════════════════════════════
// FORM 1065 (2025)
// Field ids read from the blank's widget list (data/line_dicts/f1065--2025)
// and checked against a filled render. Page 1 names follow
// CANONICAL_ALIAS_1065; Schedule L follows the 1120's column convention
// (a/c gross, b/d net); the "Analysis of Net Income (Loss) per Return"
// block is the `analysis.` section.
// ═══════════════════════════════════════════════════════════════
export const F1065_2025: Record<string, string> = {
  'meta.entity_name': 'f1_04',
  'meta.address': 'f1_05',
  'meta.suite': 'f1_06',
  'meta.city': 'f1_07',
  'meta.state': 'f1_08',
  'meta.country': 'f1_09',
  'meta.zip': 'f1_10',
  'meta.business_activity': 'f1_11',
  'meta.product_service': 'f1_12',
  'meta.business_code': 'f1_13',
  'meta.ein': 'f1_14',
  'meta.date_incorporated': 'f1_15',
  'meta.total_assets': 'f1_16',
  'meta.num_k1s': 'f1_18',
  'preparer.name': 'f1_57',
  'preparer.ptin': 'f1_58',
  'preparer.firm_name': 'f1_59',
  'preparer.firm_ein': 'f1_60',
  'preparer.firm_address': 'f1_61',
  'preparer.phone': 'f1_62',
  'income.L1a_gross_receipts': 'f1_19',
  'income.L1b_returns': 'f1_20',
  'income.L1c_balance': 'f1_21',
  'income.L2_cogs': 'f1_22',
  'income.L3_gross_profit': 'f1_23',
  'income.L4_other_partnerships': 'f1_24',
  'income.L5_net_farm': 'f1_25',
  'income.L6_net_gain_4797': 'f1_26',
  'income.L7_other_income': 'f1_27',
  'income.L8_total_income': 'f1_28',
  'deductions.L9_salaries': 'f1_29',
  'deductions.L10_guaranteed_payments': 'f1_30',
  'deductions.L11_repairs': 'f1_31',
  'deductions.L12_bad_debts': 'f1_32',
  'deductions.L13_rent': 'f1_33',
  'deductions.L14_taxes': 'f1_34',
  'deductions.L15_interest': 'f1_35',
  'deductions.L16a_depreciation': 'f1_36',
  'deductions.L16b_depreciation_1125a': 'f1_37',
  'deductions.L16c_depreciation_net': 'f1_38',
  'deductions.L17_depletion': 'f1_39',
  'deductions.L18_retirement': 'f1_40',
  'deductions.L19_employee_benefits': 'f1_41',
  'deductions.L20_energy_efficient': 'f1_42',
  'deductions.L21_other_deductions': 'f1_43',
  'deductions.L22_total_deductions': 'f1_44',
  'tax.L23_ordinary_business_income': 'f1_45',
  'tax.L24_lookback_contracts': 'f1_46',
  'tax.L25_lookback_forecast': 'f1_47',
  'tax.L26_bba_imputed': 'f1_48',
  'tax.L27_other_taxes': 'f1_49',
  'tax.L28_total_balance_due': 'f1_50',
  'payments.L29_elective_payment': 'f1_51',
  'payments.L30_payment': 'f1_52',
  'owed.L31_amount_owed': 'f1_53',
  'overpayment.L32_overpayment': 'f1_54',
  // Schedule K
  'schedK.L1_ordinary_income': 'f5_01',
  'schedK.L2_net_rental_re': 'f5_02',
  'schedK.L3a_other_gross_rental': 'f5_03',
  'schedK.L3b_other_rental_expenses': 'f5_04',
  'schedK.L3c_other_net_rental': 'f5_05',
  'schedK.L4a_gp_services': 'f5_06',
  'schedK.L4b_gp_capital': 'f5_07',
  'schedK.L4c_gp_total': 'f5_08',
  'schedK.L5_interest': 'f5_09',
  'schedK.L6a_ordinary_dividends': 'f5_10',
  'schedK.L6b_qualified_dividends': 'f5_11',
  'schedK.L6c_dividend_equivalents': 'f5_12',
  'schedK.L7_royalties': 'f5_13',
  'schedK.L8_st_capital_gain': 'f5_14',
  'schedK.L9a_lt_capital_gain': 'f5_15',
  'schedK.L9b_collectibles_gain': 'f5_16',
  'schedK.L9c_unrecaptured_1250': 'f5_17',
  'schedK.L10_net_1231_gain': 'f5_18',
  'schedK.L11_other_income': 'f5_20',
  'schedK.L12_section_179': 'f5_21',
  'schedK.L13a_cash_contributions': 'f5_22',
  'schedK.L13b_noncash_contributions': 'f5_23',
  'schedK.L13c_investment_interest': 'f5_24',
  'schedK.L13d_59e2_expenditures': 'f5_26',
  'schedK.L13e_other_deductions': 'f5_28',
  'schedK.L14a_se_earnings': 'f5_29',
  'schedK.L14b_farm_income': 'f5_30',
  'schedK.L14c_nonfarm_income': 'f5_31',
  'schedK.L17a_post86_depreciation': 'f5_41',
  'schedK.L17b_adjusted_gain': 'f5_42',
  'schedK.L18a_tax_exempt_interest': 'f5_47',
  'schedK.L18b_other_tax_exempt': 'f5_48',
  'schedK.L18c_nondeductible': 'f5_49',
  'schedK.L19a_cash_distributions': 'f5_50',
  'schedK.L19b_property_distributions': 'f5_51',
  'schedK.L20a_investment_income': 'f5_52',
  'schedK.L20b_investment_expenses': 'f5_53',
  'schedK.L21_foreign_taxes': 'f5_55',
  // Analysis of Net Income (Loss) per Return
  'analysis.L1_net_income': 'f6_01',
  'analysis.L2a_general_corporate': 'f6_02',
  'analysis.L2a_general_individual_active': 'f6_03',
  'analysis.L2a_general_individual_passive': 'f6_04',
  'analysis.L2a_general_partnership': 'f6_05',
  'analysis.L2a_general_exempt_org': 'f6_06',
  'analysis.L2a_general_nominee': 'f6_07',
  'analysis.L2b_limited_corporate': 'f6_08',
  'analysis.L2b_limited_individual_active': 'f6_09',
  'analysis.L2b_limited_individual_passive': 'f6_10',
  'analysis.L2b_limited_partnership': 'f6_11',
  'analysis.L2b_limited_exempt_org': 'f6_12',
  'analysis.L2b_limited_nominee': 'f6_13',
  // Schedule L — columns a/b beginning, c/d end
  'schedL.L1_cash_boy_a': 'f6_14',
  'schedL.L1_cash_boy_b': 'f6_15',
  'schedL.L1_cash_eoy_c': 'f6_16',
  'schedL.L1_cash_eoy_d': 'f6_17',
  'schedL.L2a_trade_boy_a': 'f6_18',
  'schedL.L2a_trade_boy_b': 'f6_19',
  'schedL.L2a_trade_eoy_c': 'f6_20',
  'schedL.L2a_trade_eoy_d': 'f6_21',
  'schedL.L2b_baddebt_boy_a': 'f6_22',
  'schedL.L2b_baddebt_boy_b': 'f6_23',
  'schedL.L2b_baddebt_eoy_c': 'f6_24',
  'schedL.L2b_baddebt_eoy_d': 'f6_25',
  'schedL.L3_inv_boy_a': 'f6_26',
  'schedL.L3_inv_boy_b': 'f6_27',
  'schedL.L3_inv_eoy_c': 'f6_28',
  'schedL.L3_inv_eoy_d': 'f6_29',
  'schedL.L4_usgov_boy_a': 'f6_30',
  'schedL.L4_usgov_boy_b': 'f6_31',
  'schedL.L4_usgov_eoy_c': 'f6_32',
  'schedL.L4_usgov_eoy_d': 'f6_33',
  'schedL.L5_taxexempt_boy_a': 'f6_34',
  'schedL.L5_taxexempt_boy_b': 'f6_35',
  'schedL.L5_taxexempt_eoy_c': 'f6_36',
  'schedL.L5_taxexempt_eoy_d': 'f6_37',
  'schedL.L6_othercurr_boy_a': 'f6_38',
  'schedL.L6_othercurr_boy_b': 'f6_39',
  'schedL.L6_othercurr_eoy_c': 'f6_40',
  'schedL.L6_othercurr_eoy_d': 'f6_41',
  'schedL.L7a_loans_partners_boy_a': 'f6_42',
  'schedL.L7a_loans_partners_boy_b': 'f6_43',
  'schedL.L7a_loans_partners_eoy_c': 'f6_44',
  'schedL.L7a_loans_partners_eoy_d': 'f6_45',
  'schedL.L7b_mortgage_boy_a': 'f6_46',
  'schedL.L7b_mortgage_boy_b': 'f6_47',
  'schedL.L7b_mortgage_eoy_c': 'f6_48',
  'schedL.L7b_mortgage_eoy_d': 'f6_49',
  'schedL.L8_otherinv_boy_a': 'f6_50',
  'schedL.L8_otherinv_boy_b': 'f6_51',
  'schedL.L8_otherinv_eoy_c': 'f6_52',
  'schedL.L8_otherinv_eoy_d': 'f6_53',
  'schedL.L9a_bldg_boy_a': 'f6_54',
  'schedL.L9a_bldg_boy_b': 'f6_55',
  'schedL.L9a_bldg_eoy_c': 'f6_56',
  'schedL.L9a_bldg_eoy_d': 'f6_57',
  'schedL.L9b_dep_boy_a': 'f6_58',
  'schedL.L9b_dep_boy_b': 'f6_59',
  'schedL.L9b_dep_eoy_c': 'f6_60',
  'schedL.L9b_dep_eoy_d': 'f6_61',
  'schedL.L10a_depletable_boy_a': 'f6_62',
  'schedL.L10a_depletable_boy_b': 'f6_63',
  'schedL.L10a_depletable_eoy_c': 'f6_64',
  'schedL.L10a_depletable_eoy_d': 'f6_65',
  'schedL.L10b_depletion_boy_a': 'f6_66',
  'schedL.L10b_depletion_boy_b': 'f6_67',
  'schedL.L10b_depletion_eoy_c': 'f6_68',
  'schedL.L10b_depletion_eoy_d': 'f6_69',
  'schedL.L11_land_boy_a': 'f6_70',
  'schedL.L11_land_boy_b': 'f6_71',
  'schedL.L11_land_eoy_c': 'f6_72',
  'schedL.L11_land_eoy_d': 'f6_73',
  'schedL.L12a_intang_boy_a': 'f6_74',
  'schedL.L12a_intang_boy_b': 'f6_75',
  'schedL.L12a_intang_eoy_c': 'f6_76',
  'schedL.L12a_intang_eoy_d': 'f6_77',
  'schedL.L12b_amort_boy_a': 'f6_78',
  'schedL.L12b_amort_boy_b': 'f6_79',
  'schedL.L12b_amort_eoy_c': 'f6_80',
  'schedL.L12b_amort_eoy_d': 'f6_81',
  'schedL.L13_other_boy_a': 'f6_82',
  'schedL.L13_other_boy_b': 'f6_83',
  'schedL.L13_other_eoy_c': 'f6_84',
  'schedL.L13_other_eoy_d': 'f6_85',
  'schedL.L14_total_boy_a': 'f6_86',
  'schedL.L14_total_boy_b': 'f6_87',
  'schedL.L14_total_eoy_c': 'f6_88',
  'schedL.L14_total_eoy_d': 'f6_89',
  'schedL.L15_ap_boy_a': 'f6_90',
  'schedL.L15_ap_boy_b': 'f6_91',
  'schedL.L15_ap_eoy_c': 'f6_92',
  'schedL.L15_ap_eoy_d': 'f6_93',
  'schedL.L16_mortshort_boy_a': 'f6_94',
  'schedL.L16_mortshort_boy_b': 'f6_95',
  'schedL.L16_mortshort_eoy_c': 'f6_96',
  'schedL.L16_mortshort_eoy_d': 'f6_97',
  'schedL.L17_othercurrliab_boy_a': 'f6_98',
  'schedL.L17_othercurrliab_boy_b': 'f6_99',
  'schedL.L17_othercurrliab_eoy_c': 'f6_100',
  'schedL.L17_othercurrliab_eoy_d': 'f6_101',
  'schedL.L18_nonrecourse_boy_a': 'f6_102',
  'schedL.L18_nonrecourse_boy_b': 'f6_103',
  'schedL.L18_nonrecourse_eoy_c': 'f6_104',
  'schedL.L18_nonrecourse_eoy_d': 'f6_105',
  'schedL.L19a_loansfrom_boy_a': 'f6_106',
  'schedL.L19a_loansfrom_boy_b': 'f6_107',
  'schedL.L19a_loansfrom_eoy_c': 'f6_108',
  'schedL.L19a_loansfrom_eoy_d': 'f6_109',
  'schedL.L19b_mortlong_boy_a': 'f6_110',
  'schedL.L19b_mortlong_boy_b': 'f6_111',
  'schedL.L19b_mortlong_eoy_c': 'f6_112',
  'schedL.L19b_mortlong_eoy_d': 'f6_113',
  'schedL.L20_otherliab_boy_a': 'f6_114',
  'schedL.L20_otherliab_boy_b': 'f6_115',
  'schedL.L20_otherliab_eoy_c': 'f6_116',
  'schedL.L20_otherliab_eoy_d': 'f6_117',
  'schedL.L21_capital_boy_a': 'f6_118',
  'schedL.L21_capital_boy_b': 'f6_119',
  'schedL.L21_capital_eoy_c': 'f6_120',
  'schedL.L21_capital_eoy_d': 'f6_121',
  'schedL.L22_total_boy_a': 'f6_122',
  'schedL.L22_total_boy_b': 'f6_123',
  'schedL.L22_total_eoy_c': 'f6_124',
  'schedL.L22_total_eoy_d': 'f6_125',
  // Schedules M-1 and M-2
  'schedM1.L1_net_income_books': 'f6_126',
  'schedM1.L2_income_on_k': 'f6_128',
  'schedM1.L3_guaranteed_payments': 'f6_129',
  'schedM1.L4a_depreciation': 'f6_130',
  'schedM1.L4b_travel_entertainment': 'f6_131',
  'schedM1.L4_expenses_not_on_k': 'f6_132',
  'schedM1.L5_add_1_4': 'f6_133',
  'schedM1.L6a_tax_exempt_interest': 'f6_134',
  'schedM1.L6_income_not_on_k': 'f6_136',
  'schedM1.L7a_depreciation': 'f6_137',
  'schedM1.L7_deductions_not_on_books': 'f6_139',
  'schedM1.L8_add_6_7': 'f6_140',
  'schedM1.L9_income_analysis': 'f6_141',
  'schedM2.L1_beg_balance': 'f6_142',
  'schedM2.L2a_contributed_cash': 'f6_143',
  'schedM2.L2b_contributed_property': 'f6_144',
  'schedM2.L3_net_income': 'f6_145',
  'schedM2.L4_other_increases': 'f6_147',
  'schedM2.L5_add_1_4': 'f6_148',
  'schedM2.L6a_distributions_cash': 'f6_149',
  'schedM2.L6b_distributions_property': 'f6_150',
  'schedM2.L7_other_decreases': 'f6_153',
  'schedM2.L8_add_6_7': 'f6_154',
  'schedM2.L9_end_balance': 'f6_155',
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULE C (FORM 1040) 2025 and SCHEDULE SE 2025 — single-member LLCs held
// as their own entity (engine/schedule_c.ts). Ids from data/line_dicts
// f1040sc--2025 / f1040sse--2025, checked on a filled render.
// ═══════════════════════════════════════════════════════════════
export const F1040SC_2025: Record<string, string> = {
  'meta.proprietor_name': 'f1_1',
  'meta.ssn': 'f1_2',
  'meta.business_activity': 'f1_3',
  'meta.business_code': 'f1_4',
  'meta.entity_name': 'f1_5',
  'meta.ein': 'f1_6',
  'meta.address': 'f1_7',
  'meta.city_state_zip': 'f1_8',
  'schedC.L1_gross_receipts': 'f1_10',
  'schedC.L2_returns': 'f1_11',
  'schedC.L3_subtract': 'f1_12',
  'schedC.L4_cogs': 'f1_13',
  'schedC.L5_gross_profit': 'f1_14',
  'schedC.L6_other_income': 'f1_15',
  'schedC.L7_gross_income': 'f1_16',
  'schedC.L8_advertising': 'f1_17',
  'schedC.L9_car_truck': 'f1_18',
  'schedC.L10_commissions_fees': 'f1_19',
  'schedC.L11_contract_labor': 'f1_20',
  'schedC.L12_depletion': 'f1_21',
  'schedC.L13_depreciation': 'f1_22',
  'schedC.L14_employee_benefits': 'f1_23',
  'schedC.L15_insurance': 'f1_24',
  'schedC.L16a_mortgage_interest': 'f1_25',
  'schedC.L16b_other_interest': 'f1_26',
  'schedC.L17_legal_professional': 'f1_27',
  'schedC.L18_office_expense': 'f1_28',
  'schedC.L19_pension_plans': 'f1_29',
  'schedC.L20a_rent_vehicles': 'f1_30',
  'schedC.L20b_rent_other': 'f1_31',
  'schedC.L21_repairs': 'f1_32',
  'schedC.L22_supplies': 'f1_33',
  'schedC.L23_taxes_licenses': 'f1_34',
  'schedC.L24a_travel': 'f1_35',
  'schedC.L24b_meals': 'f1_36',
  'schedC.L25_utilities': 'f1_37',
  'schedC.L26_wages': 'f1_38',
  'schedC.L27a_energy_efficient': 'f1_40',
  'schedC.L27b_other_expenses': 'f1_39',
  'schedC.L28_total_expenses': 'f1_41',
  'schedC.L29_tentative_profit': 'f1_42',
  'schedC.L30_home_office': 'f1_45',
  'schedC.L31_net_profit': 'f1_46',
  'schedC.L48_total_other_expenses': 'f2_33',
}
export const F1040SSE_2025: Record<string, string> = {
  'meta.name': 'f1_1',
  'meta.ssn': 'f1_2',
  'f1040sse.L2_net_profit': 'f1_5',
  'f1040sse.L3_combine': 'f1_6',
  'f1040sse.L4a_times_9235': 'f1_7',
  'f1040sse.L4c_net_earnings': 'f1_9',
  'f1040sse.L6_add_4c_5b': 'f1_12',
  'f1040sse.L8a_ss_wages': 'f1_14',
  'f1040sse.L8d_total_wages': 'f1_17',
  'f1040sse.L9_subtract': 'f1_18',
  'f1040sse.L10_social_security': 'f1_19',
  'f1040sse.L11_medicare': 'f1_20',
  'f1040sse.L12_se_tax': 'f1_21',
  'f1040sse.L13_deduction': 'f1_22',
}
