/**
 * Form 8959, 2025 — Additional Medicare Tax on Medicare wages (box 5) over the
 * filing-status threshold, and the 0.9% employers already withheld (Part V →
 * 1040 line 25c). See f1040_common.ts.
 */
import { specBuilder, any } from './f1040_common.js'

export const buildForm8959 = specBuilder({
  form: 'f8959', label: 'Form 8959', seq: 71,
  when: c => any(c, 'f8959.L18_total', 'f8959.L24_total_withholding'),
  header: { name: 'f1_1', ssn: 'f1_2' },
  fields: {
    f1_3: 'f8959.L1_medicare_wages',
    f1_6: 'f8959.L4_total',
    f1_7: 'f8959.L5_threshold',
    f1_8: 'f8959.L6_excess',
    f1_9: 'f8959.L7_tax_on_wages',
    f1_11: 'f8959.L9_threshold',
    f1_12: 'f8959.L10_wages_from_L4',
    f1_17: 'f8959.L15_threshold',
    f1_20: 'f8959.L18_total',
    f1_21: 'f8959.L19_medicare_withheld',
    f1_22: 'f8959.L20_medicare_wages',
    f1_23: 'f8959.L21_regular_rate',
    f1_24: 'f8959.L22_additional_withheld',
    f1_26: 'f8959.L24_total_withholding',
  },
})
