/**
 * Form 8995-A, 2025 — QBI deduction above the threshold, one business
 * (Part I row A) with the W-2 wage limit in Part II and the 20%-of-taxable-
 * income cap in Part IV. The business name and EIN come from the K-1
 * (input_data.k1_portfolio). See f1040_common.ts.
 */
import { specBuilder, any, digits } from './f1040_common.js'

export const buildForm8995A = specBuilder({
  form: 'f8995a', label: 'Form 8995-A', seq: 55.1,
  when: c => any(c, 'f8995a.L39_qbi_deduction', 'f8995a.L2_qbi'),
  header: { name: 'f1_01', ssn: 'f1_02' },
  fields: {
    f1_03: c => c.inputData.k1_portfolio?.entity_name,
    f1_04: c => digits(c.inputData.k1_portfolio?.ein) || undefined,
    f1_09: 'f8995a.L2_qbi',
    f1_12: 'f8995a.L3_twenty_pct_qbi',
    f1_15: 'f8995a.L4_w2_wages',
    f1_18: 'f8995a.L5_fifty_pct_wages',
    f1_21: 'f8995a.L6_twentyfive_pct_wages',
    f1_24: 'f8995a.L7_ubia',
    f1_27: 'f8995a.L8_two_half_pct_ubia',
    f1_30: 'f8995a.L9_add_6_8',
    f1_33: 'f8995a.L10_greater_5_9',
    f1_36: 'f8995a.L11_smaller_3_10',
    f1_42: 'f8995a.L13_greater_11_12',
    f1_48: 'f8995a.L15_qbi_component',
    f1_51: 'f8995a.L16_total_qbi_component',
    f2_14: 'f8995a.L21_threshold',
    f2_22: 'f8995a.L23_phase_in_range',
    f2_36: 'f8995a.L27_total_qbi_component',
    f2_41: 'f8995a.L32_qbi_before_income_limit',
    f2_42: 'f8995a.L33_taxable_income_before_qbi',
    f2_43: 'f8995a.L34_net_capital_gain',
    f2_44: 'f8995a.L35_subtract',
    f2_45: 'f8995a.L36_income_limit',
    f2_46: 'f8995a.L37_qbi_before_dpad',
    f2_48: 'f8995a.L39_qbi_deduction',
  },
})
