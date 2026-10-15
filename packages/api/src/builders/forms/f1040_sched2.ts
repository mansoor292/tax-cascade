/**
 * Schedule 2 (Form 1040), 2025 — additional taxes: AMT (Part I) and the
 * 0.9% Additional Medicare and 3.8% net investment income taxes (Part II),
 * which reach 1040 lines 17 and 23. See f1040_common.ts.
 */
import { specBuilder, any } from './f1040_common.js'

export const buildSchedule2 = specBuilder({
  form: 'f1040s2', label: 'Schedule 2', seq: 2,
  when: c => any(c, 'sched2.L3_add_1z_2', 'sched2.L21_total_other_taxes'),
  header: { name: 'f1_01', ssn: 'f1_02' },
  fields: {
    f1_12: 'sched2.L2_amt',
    f1_13: 'sched2.L3_add_1z_2',
    f1_15: 'sched2.L4_se_tax',
    f1_22: 'sched2.L11_additional_medicare',
    f1_23: 'sched2.L12_niit',
    f2_24: 'sched2.L21_total_other_taxes',
  },
})
