/**
 * Schedule D (Form 1040), 2025 — capital gains and losses: broker sales
 * reported without adjustment on line 1a, the K-1 short-term gain on line 5,
 * prior-year carryovers on lines 6 and 14, and the §1211(b) limit on line 21.
 * Lines 6, 14 and 21 print inside the form's own parentheses, so they carry
 * the magnitude only. See f1040_common.ts.
 */
import { specBuilder, any, line } from './f1040_common.js'

export const buildScheduleD = specBuilder({
  form: 'f1040sd', label: 'Schedule D', seq: 12,
  when: c => any(c, 'schedD.L16_total', 'schedD.L7_net_short_term', 'schedD.L15_net_long_term'),
  header: { name: 'f1_1', ssn: 'f1_2' },
  fields: {
    f1_3: 'schedD.L1a_proceeds_d',
    f1_4: 'schedD.L1a_basis_e',
    f1_6: 'schedD.L1a_gain_h',
    f1_20: 'schedD.L5_k1_st_gain',
    f1_21: 'schedD.L6_st_carryover',
    f1_22: 'schedD.L7_net_short_term',
    f1_42: 'schedD.L14_lt_carryover',
    f1_43: 'schedD.L15_net_long_term',
    f2_1: 'schedD.L16_total',
    f2_4: c => (line(c, 'schedD.L16_total') < 0 ? line(c, 'schedD.L21_loss_allowed') : undefined),
  },
  magnitude: ['f1_21', 'f1_42', 'f2_4'],
  checks: c => {
    const out: string[] = []
    const l15 = line(c, 'schedD.L15_net_long_term'), l16 = line(c, 'schedD.L16_total')
    if (!l16) return out
    const bothGains = l15 > 0 && l16 > 0
    // 17: are lines 15 and 16 both gains?
    out.push(bothGains ? 'c2_1[0]' : 'c2_1[1]')
    // 20: are lines 18 and 19 both zero or blank? No 28%-rate or unrecaptured
    // §1250 gain is tracked, so they always are.
    out.push('c2_2[0]')
    // 22: qualified dividends on 1040 line 3a? (the question when 17 is No)
    if (!bothGains) out.push(line(c, 'income.L3a_qual_dividends') > 0 ? 'c2_3[0]' : 'c2_3[1]')
    return out
  },
})
