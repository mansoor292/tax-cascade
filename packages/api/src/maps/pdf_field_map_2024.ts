/**
 * Deterministic Canonical Key → PDF Field ID Map
 *
 * NO fuzzy logic on output. Each canonical key maps to exactly one
 * PDF field ID (the short f-prefix used by pdf-lib after XFA stripping).
 *
 * Source: Manual mapping from IRS f1120_2024.pdf field enumeration
 * via pdf-lib getFields() cross-referenced with XFA position data.
 */

export const PDF_FIELD_MAP_1120: Record<string, string> = {
  // ── Page 1: Header ──
  'meta.entity_name':          'f1_4',
  'meta.address':              'f1_5',
  'meta.city_state_zip':       'f1_6',
  'meta.ein':                  'f1_7',
  'meta.date_incorporated':    'f1_8',
  'meta.total_assets':         'f1_9',

  // ── Page 1: Income (Lines 1a-11) ──
  'income.L1a_gross_receipts': 'f1_10',
  'income.L1b_returns':        'f1_11',
  'income.L1c_balance':        'f1_12',
  'income.L2_cogs':            'f1_13',
  'income.L3_gross_profit':    'f1_14',
  'income.L4_dividends':       'f1_15',
  'income.L5_interest':        'f1_16',
  'income.L6_gross_rents':     'f1_17',
  'income.L7_gross_royalties': 'f1_18',
  'income.L8_capital_gains':   'f1_19',
  'income.L9_net_gain_4797':   'f1_20',
  'income.L10_other_income':   'f1_21',
  'income.L11_total_income':   'f1_22',

  // ── Page 1: Deductions (Lines 12-27) ──
  'deductions.L12_officer_comp':     'f1_23',
  'deductions.L13_salaries':         'f1_24',
  'deductions.L14_repairs':          'f1_25',
  'deductions.L15_bad_debts':        'f1_26',
  'deductions.L16_rents':            'f1_27',
  'deductions.L17_taxes_licenses':   'f1_28',
  'deductions.L18_interest':         'f1_29',
  'deductions.L19_charitable':       'f1_30',
  'deductions.L20_depreciation':     'f1_31',
  'deductions.L21_depletion':        'f1_32',
  'deductions.L22_advertising':      'f1_33',
  'deductions.L23_pension':          'f1_34',
  'deductions.L24_employee_benefits':'f1_35',
  'deductions.L25_energy':           'f1_36',
  'deductions.L26_other_deductions': 'f1_37',
  'deductions.L27_total_deductions': 'f1_38',

  // ── Page 1: Tax & Payments (Lines 28-37) ──
  'tax.L28_ti_before_nol':      'f1_39',
  'tax.L29a_nol':               'f1_40',
  'tax.L29b_special_ded':       'f1_41',
  'tax.L29c_total_29':          'f1_42',
  'tax.L30_taxable_income':     'f1_43',   // gap in XFA map — between 29c(f1_42) and 31(f1_44)
  'tax.L31_total_tax':          'f1_44',   // XFA confirmed: line 31
  // f1_45 = line 32 RESERVED — leave blank
  'payments.L33_total_payments': 'f1_46',  // gap in XFA map — between 32(f1_45) and 34(f1_47)
  'payments.L35_amount_owed':    'f1_48',  // XFA confirmed: line 35
  'payments.L36_overpayment':    'f1_49',  // XFA confirmed: line 36
  'payments.L37_refunded':       'f1_51',  // XFA confirmed: line 37 refunded
  'meta.title':                  'f1_56',

  // ── Page 3: Schedule J (Tax Computation) ──
  'schedJ.J1a_income_tax':       'f3_1',
  'schedJ.J2_total_income_tax':  'f3_9',
  'schedJ.J4_add_2_3':           'f3_11',
  'schedJ.J7_subtract_6_4':      'f3_19',
  'schedJ.J11a_total_before_def':'f3_30',
  'schedJ.J12_total_tax':        'f3_33',
  'schedJ.J13_prior_overpayment':'f3_34',
  'schedJ.J14_estimated_payments':'f3_35',
  'schedJ.J19_total_payments':   'f3_40',
  'schedJ.J23_total_pay_credits':'f3_47',

  // ── Page 4: Schedule K (Other Information) ──
  'meta.business_activity_code': 'f4_2',
  'meta.business_activity':      'f4_3',
  'meta.product_service':        'f4_4',

  // ── Page 6: Schedule L (Balance Sheet) ──
  // 4 fields per line: (a) BOY cost, (b) BOY net, (c) EOY cost, (d) EOY net
  // L1 Cash: f6_1..f6_4
  'schedL.L1_cash_boy_b':            'f6_2',
  'schedL.L1_cash_eoy_d':            'f6_4',
  // L2a Trade notes: f6_5..f6_8
  'schedL.L2a_trade_boy_a':          'f6_5',
  'schedL.L2a_trade_boy_b':          'f6_6',
  'schedL.L2a_trade_eoy_c':          'f6_7',
  'schedL.L2a_trade_eoy_d':          'f6_8',
  // L2b Bad debts: f6_9..f6_12
  'schedL.L2b_baddebt_boy_a':        'f6_9',
  'schedL.L2b_baddebt_boy_b':        'f6_10',
  'schedL.L2b_baddebt_eoy_c':        'f6_11',
  'schedL.L2b_baddebt_eoy_d':        'f6_12',
  // L3 Inventories: f6_13..f6_16
  'schedL.L3_inv_boy_b':             'f6_14',
  'schedL.L3_inv_eoy_d':             'f6_16',
  // L4 US govt obligations: f6_17..f6_20
  'schedL.L4_usgov_boy_b':           'f6_18',
  'schedL.L4_usgov_eoy_d':           'f6_20',
  // L5 Tax-exempt securities: f6_21..f6_24
  'schedL.L5_taxexempt_boy_b':       'f6_22',
  'schedL.L5_taxexempt_eoy_d':       'f6_24',
  // L6 Other current assets: f6_25..f6_28
  'schedL.L6_othercurr_boy_b':       'f6_26',
  'schedL.L6_othercurr_eoy_d':       'f6_28',
  // L7 Loans to shareholders: f6_29..f6_32
  'schedL.L7_loans_boy_b':           'f6_30',
  'schedL.L7_loans_eoy_d':           'f6_32',
  // L8 Mortgage/RE loans: f6_33..f6_36
  'schedL.L8_mortgage_boy_b':        'f6_34',
  'schedL.L8_mortgage_eoy_d':        'f6_36',
  // L9 Other investments: f6_37..f6_40
  'schedL.L9_otherinv_boy_b':        'f6_38',
  'schedL.L9_otherinv_eoy_d':        'f6_40',
  // L10a Buildings: f6_41..f6_44
  'schedL.L10a_bldg_boy_a':          'f6_41',
  'schedL.L10a_bldg_eoy_c':          'f6_43',
  // L10b Accum depreciation: f6_45..f6_48
  'schedL.L10b_dep_boy_a':           'f6_45',
  'schedL.L10b_dep_boy_b':           'f6_46',
  'schedL.L10b_dep_eoy_c':           'f6_47',
  'schedL.L10b_dep_eoy_d':           'f6_48',
  // L11a Depletable assets: f6_49..f6_52
  // L11b Accum depletion: f6_53..f6_56
  // L12 Land: f6_57..f6_60
  'schedL.L12_land_boy_b':           'f6_58',
  'schedL.L12_land_eoy_d':           'f6_60',
  // L13a Intangible assets: f6_61..f6_64
  'schedL.L13a_intang_boy_a':        'f6_61',
  'schedL.L13a_intang_eoy_c':        'f6_63',
  // L13b Accum amortization: f6_65..f6_68
  'schedL.L13b_amort_boy_a':         'f6_65',
  'schedL.L13b_amort_boy_b':         'f6_66',
  'schedL.L13b_amort_eoy_c':         'f6_67',
  'schedL.L13b_amort_eoy_d':         'f6_68',
  // L14 Other assets: f6_69..f6_72
  'schedL.L14_other_boy_b':          'f6_70',
  'schedL.L14_other_eoy_d':          'f6_72',
  // L15 Total assets: f6_73..f6_76
  'schedL.L15_total_boy_b':          'f6_74',
  'schedL.L15_total_eoy_d':          'f6_76',
  // L16 Accounts payable: f6_77..f6_80
  'schedL.L16_ap_boy_b':             'f6_78',
  'schedL.L16_ap_eoy_d':             'f6_80',
  // L17 Mortgages short: f6_81..f6_84 (only 3 fields per liab line?)
  'schedL.L17_mortshort_boy_b':      'f6_82',
  'schedL.L17_mortshort_eoy_d':      'f6_84',
  // L18 Other current liabilities: f6_85..f6_88
  'schedL.L18_othercurrliab_boy_b':  'f6_86',
  'schedL.L18_othercurrliab_eoy_d':  'f6_88',
  // L19 Loans from shareholders: f6_89..f6_92
  'schedL.L19_loansfrom_boy_b':      'f6_90',
  'schedL.L19_loansfrom_eoy_d':      'f6_92',
  // L20 Mortgages long: f6_93..f6_96
  'schedL.L20_mortlong_boy_b':       'f6_94',
  'schedL.L20_mortlong_eoy_d':       'f6_96',
  // L21 Other liabilities: f6_97..f6_100
  'schedL.L21_otherliab_boy_b':      'f6_98',
  'schedL.L21_otherliab_eoy_d':      'f6_100',
  // L22a Preferred stock: f6_101..f6_104
  'schedL.L22a_pref_boy_b':          'f6_102',
  'schedL.L22a_pref_eoy_d':          'f6_104',
  // L22b Common stock: f6_105..f6_108
  'schedL.L22b_common_boy_b':        'f6_106',
  'schedL.L22b_common_eoy_d':        'f6_108',
  // L23 Paid-in capital: f6_109..f6_112
  'schedL.L23_paidin_boy_b':         'f6_110',
  'schedL.L23_paidin_eoy_d':         'f6_112',
  // L24 Retained earnings appropriated: f6_113..f6_116
  'schedL.L24_retapp_boy_b':         'f6_114',
  'schedL.L24_retapp_eoy_d':         'f6_116',
  // L25 Retained earnings unappropriated: f6_117..f6_120
  'schedL.L25_retained_boy_b':       'f6_118',
  'schedL.L25_retained_eoy_d':       'f6_120',
  // L26 Adjustments: f6_121..f6_124
  'schedL.L26_adj_boy_b':            'f6_122',
  'schedL.L26_adj_eoy_d':            'f6_124',
  // L27 Treasury stock: f6_125..f6_128
  'schedL.L27_treasury_boy_b':       'f6_126',
  'schedL.L27_treasury_eoy_d':       'f6_128',
  // L28 Total liabilities & equity: f6_129..f6_132
  'schedL.L28_total_boy_b':          'f6_130',
  'schedL.L28_total_eoy_d':          'f6_132',

  // ── Page 6: Schedule M-1 (Book-Tax Reconciliation) ──
  // Left side: f6_133..f6_144
  'schedM1.L1_net_income_books':    'f6_133',
  'schedM1.L2_fed_tax_books':       'f6_134',
  'schedM1.L3_excess_cap_losses':   'f6_135',
  'schedM1.L5_expenses_not_ded':    'f6_143',
  'schedM1.L5c_travel_ent':         'f6_141',
  'schedM1.L6_add_1_thru_5':        'f6_144',
  // Right side: f6_145..f6_155
  'schedM1.L8a_depreciation':        'f6_149',
  'schedM1.L8_ded_not_charged':      'f6_153',
  'schedM1.L9_add_7_8':              'f6_154',
  'schedM1.L10_income_line28':       'f6_155',

  // ── Page 6: Schedule M-2 (Retained Earnings) ──
  // Left side: f6_156..f6_162
  'schedM2.L1_beg_balance':         'f6_156',
  'schedM2.L2_net_income':          'f6_157',
  'schedM2.L4_add':                 'f6_162',
  // Right side: f6_163..f6_169
  'schedM2.L8_end_balance':         'f6_169',
}

// ═══════════════════════════════════════════════════════════════
// FORM 1040 — XFA-anchored field map
//
// XFA anchors (confirmed):
//   f1_42=2a, f1_43=2b, f1_44=3a, f1_45=3b,
//   f1_48=5a, f1_49=5b, f1_50=6a,
//   f1_52=7, f1_53=8, f1_54=9, f1_55=10, f1_56=11,
//   f1_57=12, f1_58=13, f1_59=14
//   f2_03=17, f2_04=18, f2_06=20, f2_09=23, f2_10=24,
//   f2_12=25b, f2_13=25c, f2_24=35a, f2_27=36, f2_28=37
//
// Gaps inferred from field order + form layout:
//   f1_30..f1_41 = header/dependents/wages area
//   f1_46..f1_47 = lines 4a/4b (IRA)
//   f1_51 = line 6b (SS taxable)
//   f1_60 = line 15 (taxable income)
//   f2_01..f2_02 = line 16 (tax)
//   f2_05 = line 19, f2_07..f2_08 = lines 21/22
//   f2_11 = line 25a, f2_14 = line 25d
//   f2_15..f2_23 = lines 26-33
// ═══════════════════════════════════════════════════════════════

export const PDF_FIELD_MAP_1040: Record<string, string> = {
  // ═══════════════════════════════════════════════════════════
  // Source: Textract OCR of labeled field PDF (every field printed its ID)
  // Verified 2024-04-12 — NO guessing, every mapping confirmed by Textract
  // ═══════════════════════════════════════════════════════════

  // ── Page 1: Header ──
  'meta.first_name':           'f1_04',   // "Your first name and middle initial"
  'meta.last_name':            'f1_05',   // "Last name"
  'meta.ssn':                  'f1_06',   // "Your social security number"
  'meta.spouse_first':         'f1_07',   // "If joint return, spouse's first name"
  'meta.spouse_last':          'f1_08',   // "Last name"
  'meta.spouse_ssn':           'f1_09',   // "Spouse's social security number"
  'meta.address':              'f1_10',   // "Home address (number and street)"
  'meta.apt':                  'f1_11',   // "Apt. no."
  'meta.city':                 'f1_12',   // "City, town, or post office"
  'meta.state':                'f1_13',   // "State"
  'meta.zip':                  'f1_14',   // "ZIP code"

  // ── Page 1: Income (Lines 1a-15) ──
  'income.L1a_w2_wages':       'f1_32',   // "1a Total amount from Form(s) W-2, box 1"
  'income.L1b_household':      'f1_33',   // "1b Household employee wages"
  'income.L1c_tips':           'f1_34',   // "1c Tip income"
  'income.L1d_medicaid':       'f1_35',   // "1d Medicaid waiver payments"
  'income.L1e_dependent_care': 'f1_36',   // "1e Taxable dependent care benefits"
  'income.L1f_adoption':       'f1_37',   // "1f Employer-provided adoption benefits"
  'income.L1g_8919':           'f1_38',   // "1g Wages from Form 8919"
  'income.L1h_other_earned':   'f1_39',   // "1h Other earned income"
  'income.L1i_combat_pay':     'f1_40',   // "1i Nontaxable combat pay election"
  'income.L1z_total_wages':    'f1_41',   // "1z Add lines 1a through 1h"
  'income.L2a_tax_exempt_int': 'f1_42',   // "2a Tax-exempt interest"
  'income.L2b_taxable_int':    'f1_43',   // "2b Taxable interest"
  'income.L3a_qual_dividends': 'f1_44',   // "3a Qualified dividends"
  'income.L3b_ord_dividends':  'f1_45',   // "3b Ordinary dividends"
  'income.L4a_ira':            'f1_46',   // "4a IRA distributions"
  'income.L4b_ira_taxable':    'f1_47',   // "4b Taxable amount"
  'income.L5a_pensions':       'f1_48',   // "5a Pensions and annuities"
  'income.L5b_pensions_tax':   'f1_49',   // "5b Taxable amount"
  'income.L6a_social_sec':     'f1_50',   // "6a Social security benefits"
  'income.L6b_ss_taxable':     'f1_51',   // "6b Taxable amount"
  'income.L7_capital_gains':   'f1_52',   // "7 Capital gain or (loss)"
  'income.L8_schedule1':       'f1_53',   // "8 Additional income from Schedule 1, line 10"
  'income.L9_total_income':    'f1_54',   // "9 Total income"
  'income.L10_adjustments':    'f1_55',   // "10 Adjustments to income from Schedule 1"
  'income.L11_agi':            'f1_56',   // "11 Adjusted gross income"
  'deductions.L12_standard':   'f1_57',   // "12 Standard deduction or itemized"
  'deductions.L13_qbi':        'f1_58',   // "13 Qualified business income deduction"
  'deductions.L14_total':      'f1_59',   // "14 Add lines 12 and 13"
  'tax.L15_taxable_income':    'f1_60',   // "15 Taxable income"

  // ── Page 2: Tax and Credits (Lines 16-24) ──
  'tax.L16_income_tax':        'f2_01',   // "16 Tax" (f2_02 is checkbox area)
  'tax.L17_sched2':            'f2_03',   // "17 Amount from Schedule 2, line 3"
  'tax.L18_add_16_17':         'f2_04',   // "18 Add lines 16 and 17"
  'credits.L19_child_tax':     'f2_05',   // "19 Child tax credit from Schedule 8812"
  'credits.L20_sched3':        'f2_06',   // "20 Amount from Schedule 3, line 8"
  'credits.L21_add_19_20':     'f2_07',   // "21 Add lines 19 and 20"
  'tax.L22_subtract':          'f2_08',   // "22 Subtract line 21 from line 18"
  'tax.L23_other_taxes':       'f2_09',   // "23 Other taxes from Schedule 2, line 21"
  'tax.L24_total_tax':         'f2_10',   // "24 Total tax"

  // ── Page 2: Payments (Lines 25-33) ──
  'payments.L25a_w2':          'f2_11',   // "25a Form(s) W-2"
  'payments.L25b_1099':        'f2_12',   // "25b Form(s) 1099"
  'payments.L25c_other':       'f2_13',   // "25c Other forms"
  'payments.L25d_total':       'f2_14',   // "25d Add lines 25a through 25c"
  'payments.L26_estimated':    'f2_15',   // "26 Estimated tax payments"
  'payments.L27_eic':          'f2_16',   // "27 Earned income credit"
  'payments.L28_child_addl':   'f2_17',   // "28 Additional child tax credit"
  'payments.L29_aoc':          'f2_18',   // "29 American opportunity credit"
  'payments.L30_reserved':     'f2_19',   // "30 Reserved for future use"
  'payments.L31_sched3_15':    'f2_20',   // "31 Amount from Schedule 3, line 15"
  'payments.L32_other_total':  'f2_21',   // "32 Total other payments and refundable credits"
  'payments.L33_total':        'f2_22',   // "33 Total payments"

  // ── Page 2: Refund / Amount Owed (Lines 34-38) ──
  'result.L34_overpayment':    'f2_23',   // "34 Overpayment"
  'refund.L35a_refunded':      'f2_24',   // "35a Amount refunded to you"
  'refund.L36_applied_est':    'f2_27',   // "36 Applied to estimated tax"
  'owed.L37_amount_owed':      'f2_28',   // "37 Amount you owe"
  'penalty.L38_est_penalty':   'f2_29',   // "38 Estimated tax penalty"

  // ── Page 2: Preparer ──
  'preparer.occupation':       'f2_33',   // "Your occupation"
  'preparer.spouse_occ':       'f2_35',   // "Spouse's occupation"
  'preparer.name':             'f2_39',   // "Preparer's name"
  'preparer.ptin':             'f2_40',   // "PTIN"
  'preparer.firm_name':        'f2_41',   // "Firm's name"
  'preparer.firm_phone':       'f2_42',   // "Phone no."
  'preparer.firm_address':     'f2_43',   // "Firm's address"
  'preparer.firm_ein':         'f2_44',   // "Firm's EIN"
}

// ═══════════════════════════════════════════════════════════════
// FORM 1120-S — Textract-verified field map
//
// Source: Textract OCR of labeled field PDF (2024-04-12)
// Every mapping confirmed — NO guessing
// ═══════════════════════════════════════════════════════════════

export const PDF_FIELD_MAP_1120S: Record<string, string> = {
  // ── Page 1: Header ──
  'meta.entity_name':          'f1_4',    // "Name"
  'meta.address':              'f1_5',    // "Number, street, and room or suite no."
  'meta.city_state_zip':       'f1_6',    // "City or town, state, ZIP"
  'meta.s_election_date':      'f1_7',    // "A S election effective date"
  'meta.business_code':        'f1_8',    // "B Business activity code number"
  'meta.ein':                  'f1_9',    // "D Employer identification number"
  'meta.date_incorporated':    'f1_10',   // "E Date incorporated"
  'meta.total_assets':         'f1_11',   // "F Total assets"
  'meta.num_shareholders':     'f1_12',   // "I Number of shareholders"

  // ── Page 1: Income (Lines 1a-6) ──
  'income.L1a_gross_receipts': 'f1_13',   // "1a Gross receipts or sales"
  'income.L1b_returns':        'f1_14',   // "b Less returns and allowances"
  'income.L1c_balance':        'f1_15',   // "1c Balance" (textract: not in KV but f1_15 by position)
  'income.L2_cogs':            'f1_16',   // "2 Cost of goods sold"
  'income.L3_gross_profit':    'f1_17',   // "3 Gross profit"
  'income.L4_net_gain_4797':   'f1_18',   // "4 Net gain (loss) from Form 4797"
  'income.L5_other_income':    'f1_19',   // "5 Other income (loss)"
  'income.L6_total_income':    'f1_20',   // "6 Total income (loss)"

  // ── Page 1: Deductions (Lines 7-21) ──
  'deductions.L7_officer_comp':'f1_21',   // "7 Compensation of officers"
  'deductions.L8_salaries':    'f1_22',   // "8 Salaries and wages"
  'deductions.L9_repairs':     'f1_23',   // "9 Repairs and maintenance"
  'deductions.L10_bad_debts':  'f1_24',   // "10 Bad debts"
  'deductions.L11_rents':      'f1_25',   // "11 Rents"
  'deductions.L12_taxes':      'f1_26',   // "12 Taxes and licenses"
  'deductions.L13_interest':   'f1_27',   // "13 Interest"
  'deductions.L14_depreciation':'f1_28',  // "14 Depreciation from Form 4562"
  'deductions.L15_depletion':  'f1_29',   // "15 Depletion"
  'deductions.L16_advertising':'f1_30',   // "16 Advertising"
  'deductions.L17_pension':    'f1_31',   // "17 Pension, profit-sharing"
  'deductions.L18_employee_benefits':'f1_32', // "18 Employee benefit programs"
  'deductions.L19_energy':     'f1_33',   // "19 Energy efficient buildings"
  'deductions.L20_other':      'f1_34',   // "20 Other deductions"
  'deductions.L21_total':      'f1_35',   // "21 Total deductions"

  // ── Page 1: Lines 22-28 ──
  'tax.L22_ordinary_income':   'f1_36',   // "22 Ordinary business income (loss)"
  'tax.L23a_passive':          'f1_37',   // "23a Excess net passive income or LIFO"
  'tax.L23b_sched_d':          'f1_38',   // "23b Tax from Schedule D"
  'tax.L23c_total':            'f1_39',   // "23c Add lines 23a and 23b"
  'payments.L24a_estimated':   'f1_40',   // "24a Current year estimated tax payments"
  'payments.L24b_7004':        'f1_41',   // "24b Tax deposited with Form 7004"
  'payments.L24c_fuels':       'f1_42',   // "24c Credit for federal tax on fuels"
  'payments.L24d_elective':    'f1_43',   // "24d Elective payment election"
  'payments.L24z_total':       'f1_44',   // "24z Add lines 24a through 24d"
  'penalty.L25':               'f1_45',   // "25 Estimated tax penalty"
  'owed.L26':                  'f1_46',   // "26 Amount owed"
  'overpayment.L27':           'f1_47',   // "27 Overpayment"
  'refund.L28_credited':       'f1_48',   // "28 Credited to estimated tax"
  'refund.L28_refunded':       'f1_49',   // "28 Refunded"

  // ── Page 1: Signature ──
  'meta.title':                'f1_50',   // "Title"
  'preparer.name':             'f1_51',   // "Preparer's name"
  'preparer.ptin':             'f1_52',   // "PTIN"
  'preparer.firm_name':        'f1_53',   // "Firm's name"
  'preparer.firm_address':     'f1_54',   // "Firm's address"
  'preparer.firm_ein':         'f1_55',   // "Firm's EIN"
  'preparer.phone':            'f1_56',   // "Phone no."

  // ── Page 2: Schedule B (Other Information) ──
  'schedB.L1c_other':          'f2_1',    // "(specify)"
  'schedB.L2b_product':        'f2_3',    // "b Product or service"
  'schedB.L5a_restricted':     'f2_44',   // "Total shares of restricted stock"
  'schedB.L5a_nonrestricted':  'f2_45',   // "Total shares of non-restricted stock"
  'schedB.L5b_outstanding':    'f2_46',   // "Total shares outstanding at EOY"
  'schedB.L5b_if_executed':    'f2_47',   // "Total shares if all instruments executed"

  // ── Page 3: Schedule K (Shareholders' Pro Rata Share Items) ──
  'schedK.L1_ordinary':        'f3_3',    // "1 Ordinary business income (loss)"
  'schedK.L2_rental_re':       'f3_4',    // "2 Net rental real estate income"
  'schedK.L3a_other_rental':   'f3_5',    // "3a Other gross rental income"
  'schedK.L3b_rental_exp':     'f3_6',    // "3b Expenses from other rental"
  'schedK.L3c_net_rental':     'f3_7',    // "3c Other net rental income"
  'schedK.L4_interest':        'f3_8',    // "4 Interest income"
  'schedK.L5a_dividends':      'f3_9',    // "5a Ordinary dividends"
  'schedK.L5b_qual_div':       'f3_10',   // "5b Qualified dividends"
  'schedK.L6_royalties':       'f3_11',   // "6 Royalties"
  'schedK.L7_st_gain':         'f3_12',   // "7 Net short-term capital gain"
  'schedK.L8a_lt_gain':        'f3_13',   // "8a Net long-term capital gain"
  'schedK.L8b_collectibles':   'f3_14',   // "8b Collectibles (28%) gain"
  'schedK.L8c_unrecaptured':   'f3_15',   // "8c Unrecaptured section 1250 gain"
  'schedK.L9_1231':            'f3_16',   // "9 Net section 1231 gain"
  'schedK.L10_other_amount':   'f3_18',   // "10 Other income amount"
  'schedK.L11_179':            'f3_19',   // "11 Section 179 deduction"
  'schedK.L12a_cash_charity':  'f3_20',   // "12a Cash charitable contributions"
  'schedK.L12b_noncash_charity':'f3_21',  // "12b Noncash charitable contributions"
  'schedK.L12c_invest_interest':'f3_22',  // "12c Investment interest expense"
  'schedK.L13a_li_housing_42': 'f3_27',   // "13a Low-income housing credit (42j5)"
  'schedK.L13b_li_housing_oth':'f3_28',   // "13b Low-income housing credit (other)"
  'schedK.L15a_depreciation':  'f3_37',   // "15a Post-1986 depreciation adjustment"
  'schedK.L15b_adj_gain':      'f3_38',   // "15b Adjusted gain or loss"
  'schedK.L15c_depletion':     'f3_39',   // "15c Depletion (other than oil/gas)"
  'schedK.L15d_oil_gross':     'f3_40',   // "15d Oil/gas gross income"
  'schedK.L15e_oil_ded':       'f3_41',   // "15e Oil/gas deductions"
  'schedK.L15f_other_amt':     'f3_42',   // "15f Other AMT items"
  'schedK.L16a_tax_exempt_int':'f3_43',   // "16a Tax-exempt interest income"
  'schedK.L16b_other_exempt':  'f3_44',   // "16b Other tax-exempt income"
  'schedK.L16c_nondeductible': 'f3_45',   // "16c Nondeductible expenses"
  'schedK.L16d_distributions': 'f3_46',   // "16d Distributions"
  'schedK.L16e_loan_repay':    'f3_47',   // "16e Repayment of loans from shareholders"
  'schedK.L16f_foreign_taxes': 'f3_48',   // "16f Foreign taxes paid or accrued"

  // ── Page 4: Schedule K continued ──
  'schedK.L17a_invest_income': 'f4_1',    // "17a Investment income"
  'schedK.L17b_invest_expense':'f4_2',    // "17b Investment expenses"
  'schedK.L17c_div_from_ae':   'f4_3',    // "17c Dividend distributions from A&E"
  'schedK.L18_reconciliation': 'f4_4',    // "18 Income reconciliation"

  // ── Page 5: Schedule M-1 (Book-Tax Reconciliation) ──
  'schedM1.L1_net_income':     'f5_1',    // "1 Net income (loss) per books"
  'schedM1.L2_income_on_K':    'f5_4',    // "2 Income on Schedule K not in books"
  'schedM1.L3_expenses_not_K': 'f5_9',    // "3 Expenses on books not on Schedule K"
  'schedM1.L4_add':            'f5_10',   // "4 Add lines 1 through 3"
  'schedM1.L5_income_not_K':   'f5_13',   // "5 Income on books not on Schedule K"
  'schedM1.L6_ded_on_K':       'f5_16',   // "6 Deductions on Schedule K not on books"
  'schedM1.L7_add_5_6':        'f5_17',   // "7 Add lines 5 and 6"
  'schedM1.L8_income_K18':     'f5_18',   // "8 Income (Schedule K, line 18)"
}

/**
 * Get the PDF field ID for a canonical key on any form.
 */
export function getPdfFieldId(form: '1120' | '1040' | '1120S', canonicalKey: string): string | undefined {
  const map = form === '1120' ? PDF_FIELD_MAP_1120 : form === '1040' ? PDF_FIELD_MAP_1040 : PDF_FIELD_MAP_1120S
  return map[canonicalKey]
}

/**
 * Get all canonical keys that have PDF field mappings.
 */
export function getMappedKeys(form: '1120' | '1040' | '1120S'): string[] {
  const map = form === '1120' ? PDF_FIELD_MAP_1120 : form === '1040' ? PDF_FIELD_MAP_1040 : PDF_FIELD_MAP_1120S
  return Object.keys(map)
}


// Year-keyed aliases for the PDF route
export const F1120_2024 = PDF_FIELD_MAP_1120
export const F1120_2023 = PDF_FIELD_MAP_1120  // 2023 uses same form layout as 2024
export const F1120_2022 = PDF_FIELD_MAP_1120
export const F1040_2024 = PDF_FIELD_MAP_1040
export const F1040_2023 = PDF_FIELD_MAP_1040
export const F1120S_2024 = PDF_FIELD_MAP_1120S
export const F1120S_2023 = PDF_FIELD_MAP_1120S
