/**
 * Schedule 8812 (Form 1040), 2025 — child tax credit. Filed whenever a
 * qualifying child is claimed, including when income phases the credit out
 * to nothing (line 12 "No. Stop here"; Part II-A then answers No). The blank
 * on file before 2026-10-15 was the 2011 revision under a 2025 name, which is
 * why no 8812 was ever produced. See f1040_common.ts.
 */
import { specBuilder, any, line } from './f1040_common.js'

export const buildSchedule8812 = specBuilder({
  form: 'f8812', label: 'Schedule 8812', seq: 47,
  when: c => any(c, 'f8812.L4_qualifying_children'),
  header: { name: 'f1_1', ssn: 'f1_2' },
  fields: {
    f1_3: 'f8812.L1_agi',
    f1_8: 'f8812.L3_add_1_2d',
    f1_9: c => line(c, 'f8812.L4_qualifying_children') || undefined,
    f1_10: 'f8812.L5_children_credit',
    f1_13: 'f8812.L8_add_5_7',
    f1_14: 'f8812.L9_threshold',
    f1_15: 'f8812.L10_excess_rounded',
    f1_16: 'f8812.L11_phaseout',
    f1_17: 'f8812.L12_after_phaseout',
    f1_18: 'f8812.L13_credit_limit',
    f1_19: 'f8812.L14_ctc_odc',
  },
  checks: c => (line(c, 'f8812.L12_after_phaseout') > 0
    ? ['c1_1[1]']
    // No credit left: line 12 "No", and Part II-A's two questions are No.
    : ['c1_1[0]', 'c2_1[0]', 'c2_2[0]']),
})
