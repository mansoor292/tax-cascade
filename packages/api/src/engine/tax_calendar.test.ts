/**
 * Tax calendar rules. Expected dates are the IRS's actual published
 * deadlines for those years, not whatever the code happened to emit.
 */
import { describe, it, expect } from 'vitest'
import { generateObligations, nextBusinessDay, daysUntil } from './tax_calendar.js'

describe('nextBusinessDay (IRC §7503)', () => {
  it('leaves a weekday deadline alone', () => {
    expect(nextBusinessDay('2026-04-15')).toBe('2026-04-15')   // Wednesday
    expect(nextBusinessDay('2027-04-15')).toBe('2027-04-15')   // Thursday
  })

  it('rolls a Sunday deadline to Monday', () => {
    expect(nextBusinessDay('2026-03-15')).toBe('2026-03-16')
    expect(nextBusinessDay('2025-06-15')).toBe('2025-06-16')
  })

  it('honours DC Emancipation Day when it is observed on Apr 15', () => {
    // 2022: Apr 16 fell on a Saturday, so Emancipation Day was observed on
    // Friday Apr 15 — the IRS deadline moved to Monday Apr 18. This is the
    // case a naive weekend-only check gets wrong.
    expect(nextBusinessDay('2022-04-15')).toBe('2022-04-18')
  })

  it('handles Apr 15 on a Saturday with Emancipation Day observed Monday', () => {
    // 2023: Apr 15 Sat, Apr 16 Sun, Emancipation observed Mon Apr 17,
    // so the deadline was Tuesday Apr 18 — as the IRS published.
    expect(nextBusinessDay('2023-04-15')).toBe('2023-04-18')
  })
})

describe('daysUntil', () => {
  it('counts calendar days across a month boundary', () => {
    // Guards a real bug: building dates with 1-indexed months made this 31.
    expect(daysUntil('2026-03-01', '2026-02-01')).toBe(28)
    expect(daysUntil('2026-12-15', '2026-08-26')).toBe(111)
  })

  it('returns a negative count for an overdue date', () => {
    expect(daysUntil('2026-08-01', '2026-08-26')).toBe(-25)
  })
})

describe('generateObligations', () => {
  const fl = { state: 'FL', fiscal_year_end: '12/31' }

  it('uses the extended due date once an extension is on file', () => {
    const o = generateObligations(
      { id: 'E1', form_type: '1120S', ...fl, extended_years: [2025] } as any, 2025)
    const ret = o.find(x => x.kind === 'return')!
    expect(ret.due_date).toBe('2026-09-15')
    expect(ret.extended).toBe(true)
    // Once filed, a separate "file an extension" reminder is noise.
    expect(o.filter(x => x.kind === 'extension')).toHaveLength(0)
  })

  it('uses the original due date and prompts for an extension when none is filed', () => {
    const o = generateObligations(
      { id: 'E2', form_type: '1120', ...fl, extended_years: [] } as any, 2025)
    expect(o.find(x => x.kind === 'return')!.due_date).toBe('2026-04-15')
    expect(o.filter(x => x.kind === 'extension')).toHaveLength(1)
  })

  it('gives C-corps four estimated payments and S-corps none', () => {
    const c = generateObligations({ id: 'C', form_type: '1120', ...fl } as any, 2025)
    const s = generateObligations({ id: 'S', form_type: '1120S', ...fl } as any, 2025)
    expect(c.filter(x => x.kind === 'estimated_payment')).toHaveLength(4)
    // §1374/§1375 cases are not detected, so none are guessed at.
    expect(s.filter(x => x.kind === 'estimated_payment')).toHaveLength(0)
  })

  it('puts the individual Q4 estimate in January of the following year', () => {
    const o = generateObligations({ id: 'I', form_type: '1040', ...fl } as any, 2025)
    const q4 = o.find(x => x.kind === 'estimated_payment' && x.period === 'Q4')!
    expect(q4.due_date).toBe('2026-01-15')
  })

  it('adds Florida corporate items for corporations but not individuals', () => {
    const corp = generateObligations({ id: 'C', form_type: '1120', ...fl } as any, 2025)
    const ind  = generateObligations({ id: 'I', form_type: '1040', ...fl } as any, 2025)
    expect(corp.filter(x => x.kind === 'annual_report')).toHaveLength(1)
    expect(ind.filter(x => x.jurisdiction === 'FL')).toHaveLength(0)
  })

  it('flags a fiscal-year filer instead of guessing a calendar-year date', () => {
    const o = generateObligations(
      { id: 'F', form_type: '1120', fiscal_year_end: '06/30' } as any, 2025)
    expect(o.find(x => x.kind === 'return')!.note).toBeTruthy()
  })

  it('produces stable unique keys so refresh upserts instead of duplicating', () => {
    const all = [
      ...generateObligations({ id: 'A', form_type: '1120', ...fl } as any, 2025),
      ...generateObligations({ id: 'B', form_type: '1040', ...fl } as any, 2025),
    ]
    const keys = all.map(o => o.obligation_key)
    expect(new Set(keys).size).toBe(keys.length)

    // Same inputs must regenerate the same keys, or every refresh duplicates.
    const again = generateObligations({ id: 'A', form_type: '1120', ...fl } as any, 2025)
    expect(again.map(o => o.obligation_key))
      .toEqual(generateObligations({ id: 'A', form_type: '1120', ...fl } as any, 2025).map(o => o.obligation_key))
  })
})
