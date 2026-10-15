/**
 * Form 1040-V, 2025 — the payment voucher, produced whenever line 37 shows an
 * amount owed. Not an attachment (it goes loose with the check), so it sorts
 * after every schedule. See f1040_common.ts.
 */
import { specBuilder, line, headerSsn } from './f1040_common.js'

export const buildForm1040V = specBuilder({
  form: 'f1040v', label: 'Form 1040-V', seq: 999,
  when: c => line(c, 'owed.L37_amount_owed') > 0,
  fields: {
    f1_1: c => headerSsn(c, 'primary'),
    f1_2: c => (c.entity.meta?.spouse_ssn ? headerSsn(c, 'spouse') : undefined),
    f1_3: c => line(c, 'owed.L37_amount_owed'),
    f1_5: c => c.entity.meta?.first_name,
    f1_6: c => c.entity.meta?.last_name,
    f1_7: c => c.entity.meta?.spouse_first,
    f1_8: c => c.entity.meta?.spouse_last,
    f1_9: c => c.entity.address,
    f1_11: c => c.entity.city,
    f1_12: c => c.entity.state,
    f1_13: c => c.entity.zip,
  },
})
