/**
 * Schedule 1 (Form 1040), 2025 — additional income. Line 5 is where K-1
 * income from an S corporation lands (via Schedule E); line 8z carries other
 * income itemized on a statement (f1040_statements.ts). See f1040_common.ts.
 */
import { specBuilder, any } from './f1040_common.js'

export const SCHED1_8Z_STATEMENT = 'See Statement - Sch 1 (1040) - 8z - Other income'

export const buildSchedule1 = specBuilder({
  form: 'f1040s1', label: 'Schedule 1', seq: 1,
  when: c => any(c, 'sched1.L10_additional_income', 'sched1.L26_adjustments'),
  header: { name: 'f1_01', ssn: 'f1_02' },
  fields: {
    f1_09: 'sched1.L5_rental_partnership_scorp',
    // 8z: a description box, then the amount. Itemized other income is
    // described by reference to its statement.
    f1_35: c => (c.model['sched1.L8z_other_income'] && c.inputData.other_income_detail?.length ? SCHED1_8Z_STATEMENT : undefined),
    f1_36: 'sched1.L8z_other_income',
    f1_37: 'sched1.L9_total_other_income',
    f1_38: 'sched1.L10_additional_income',
  },
})
