/**
 * Schedule 3 (Form 1040), 2025 — Part II payments: the amount paid with the
 * extension (line 10) and excess social security withheld (line 11), totalled
 * on line 15 → 1040 line 31. See f1040_common.ts.
 */
import { specBuilder, any } from './f1040_common.js'

export const buildSchedule3 = specBuilder({
  form: 'f1040s3', label: 'Schedule 3', seq: 3,
  when: c => any(c, 'sched3.L15_total_payments'),
  header: { name: 'f1_01', ssn: 'f1_02' },
  fields: {
    f1_27: 'sched3.L10_extension_payment',
    f1_28: 'sched3.L11_excess_social_security',
    f1_37: 'sched3.L15_total_payments',
  },
})
