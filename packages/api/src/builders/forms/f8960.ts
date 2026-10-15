/**
 * Form 8960, 2025 — net investment income tax. K-1 income from a nonpassive
 * S corporation enters on 4a and is backed out on 4b; line 5a is 1040 line 7
 * (a capital loss counts up to the 3,000 deductible). See f1040_common.ts.
 */
import { specBuilder, any } from './f1040_common.js'

export const buildForm8960 = specBuilder({
  form: 'f8960', label: 'Form 8960', seq: 72,
  when: c => any(c, 'f8960.L17_niit'),
  header: { name: 'f1_1', ssn: 'f1_2' },
  fields: {
    f1_3: 'f8960.L1_interest',
    f1_4: 'f8960.L2_dividends',
    f1_6: 'f8960.L4a_rental_partnership',
    f1_7: 'f8960.L4b_nonsection1411_adj',
    f1_9: 'f8960.L5a_net_gain',
    f1_12: 'f8960.L5d_combined',
    f1_14: 'f8960.L7_other',
    f1_15: 'f8960.L8_total',
    f1_22: 'f8960.L12_net_investment_income',
    f1_23: 'f8960.L13_magi',
    f1_24: 'f8960.L14_threshold',
    f1_25: 'f8960.L15_excess',
    f1_26: 'f8960.L16_lesser',
    f1_27: 'f8960.L17_niit',
  },
})
