/**
 * Form 7203, 2025 — S corporation shareholder stock and debt basis, required
 * whenever the shareholder takes a distribution. It belongs to the
 * shareholder, so its header carries THAT person's name and SSN — on a joint
 * return often the spouse (input_data.form7203.shareholder). Lines come from
 * the engine (f7203.*), which builds Part I from the K-1 items on the return
 * plus the basis facts only the shareholder knows. See f1040_common.ts.
 */
import { specBuilder, any, headerName, headerSsn, digits } from './f1040_common.js'
import type { AttachmentContext } from './types.js'

const who = (c: AttachmentContext) => (c.inputData.form7203?.shareholder === 'spouse' ? 'spouse' : 'primary')

export const buildForm7203 = specBuilder({
  form: 'f7203', label: 'Form 7203', seq: 203,
  when: c => any(c, 'f7203.L5_basis_before_distributions', 'f7203.L15_stock_basis_eoy', 'f7203.L6_distributions'),
  fields: {
    f1_01: c => headerName(c, 'f7203', who(c)),
    f1_02: c => headerSsn(c, who(c)),
    f1_03: c => c.inputData.form7203?.scorp_name ?? c.inputData.k1_portfolio?.entity_name,
    f1_04: c => digits(c.inputData.form7203?.scorp_ein ?? c.inputData.k1_portfolio?.ein) || undefined,
    f1_07: 'f7203.L1_stock_basis_boy',
    f1_08: 'f7203.L2_contributions',
    f1_09: 'f7203.L3a_ordinary_income',
    f1_12: 'f7203.L3d_interest',
    f1_13: 'f7203.L3e_dividends',
    f1_15: 'f7203.L3g_capital_gain',
    f1_19: 'f7203.L3k_tax_exempt',
    f1_21: 'f7203.L3m_other_increases',
    f1_22: 'f7203.L4_increases',
    f1_23: 'f7203.L5_basis_before_distributions',
    f1_24: 'f7203.L6_distributions',
    f1_25: 'f7203.L7_basis_after_distributions',
    f1_26: 'f7203.L8a_nondeductible',
    f1_27: 'f7203.L8b_oil_gas_depletion',
    f1_29: 'f7203.L9_add_8',
    f1_30: 'f7203.L10_basis_before_losses',
    f1_31: 'f7203.L11_loss_items',
    f1_34: 'f7203.L14_decreases',
    f1_35: 'f7203.L15_stock_basis_eoy',
  },
})
