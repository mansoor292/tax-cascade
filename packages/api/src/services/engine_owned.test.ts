import { describe, it, expect } from 'vitest'
import { dropEngineOwned } from './engine_owned.js'

describe('dropEngineOwned', () => {
  it('clears engine-owned 1040 sections so a line that went to zero cannot keep its old value', () => {
    const stored = { 'f8960.L7_other': 123, 'f8960.L8_total': 900, 'income.L1z_wages': 5, 'schedD.L14_lt_carryover': 7 }
    const engine = { 'f8960.L8_total': 777 } // L7 is now zero, so the engine does not write it
    const merged: Record<string, number> = { ...dropEngineOwned(stored, '1040'), ...engine }
    expect(merged['f8960.L7_other']).toBeUndefined()
    expect(merged['f8960.L8_total']).toBe(777)
    expect(merged['income.L1z_wages']).toBe(5)
    expect(merged['schedD.L14_lt_carryover']).toBe(7)
  })

  it('leaves other form types untouched', () => {
    const stored = { 'f8960.L7_other': 123 }
    expect(dropEngineOwned(stored, '1120')).toBe(stored)
  })
})
