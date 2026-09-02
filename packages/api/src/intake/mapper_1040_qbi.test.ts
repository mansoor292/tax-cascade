/**
 * 1040 QBI mapping — pins the SOP-03 (2026-09-02) double bug.
 *
 * The KV strings are verbatim from a real filed 2023 1040's Textract output.
 * The form's OWN line 13 read 0, but Form 8995's line 33 ("Taxable income
 * BEFORE qualified business income deduction" = 236,260) matched the
 * unanchored QBI pattern — and the conflict check used truthiness, so the
 * correctly-mapped 0 counted as "unset" and was overwritten. The filed line
 * view then showed a $236,260 QBI deduction on a return that took none.
 */
import { describe, it, expect } from 'vitest'
import { mapToCanonical } from './json_model_mapper.js'

const KVS = [
  { key: 'Filing Status', value: 'Single' },
  { key: '13 Qualified business income deduction from Form 8995 or Form 8995-A 13', value: '0.' },
  // Form 8995 lines that also contain the phrase — none of them are 1040 L13:
  { key: '33 Taxable income before qualified business income deduction 33', value: '236,260.' },
  { key: '32 Qualified business income deduction before the income limitation. Add lines 27 and 31 32', value: '0.' },
  { key: '39 Total qualified business income deduction. Add lines 37 and 38 39', value: '0.' },
  { key: '15 Subtract line 14 from line 11. If zero or less, enter -0-. This is your taxable income 15', value: '236,260.' },
]

describe('1040 QBI line mapping', () => {
  it('keeps line 13 at its documented 0 — Form 8995 line 33 must not overwrite it', () => {
    const result = mapToCanonical({ form_type: '1040', tax_year: 2023, key_value_pairs: KVS })
    expect(result.model['deductions.L13a_qbi']).toBe(0)
    expect(result.model['tax.L15_taxable_income']).toBe(236260)
  })

  it('a documented zero survives later same-rule matches regardless of KV order', () => {
    const reversed = [...KVS].reverse()
    const result = mapToCanonical({ form_type: '1040', tax_year: 2023, key_value_pairs: reversed })
    expect(result.model['deductions.L13a_qbi']).toBe(0)
  })
})
