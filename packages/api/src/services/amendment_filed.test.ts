/**
 * When an amendment was filed (2026-10-24): it is often recorded weeks after
 * it went in, and the TC977s accept the amendments in the order they were
 * filed — so the date given is the date kept, and a date that cannot be
 * right is refused rather than stored.
 */
import { describe, it, expect } from 'vitest'
import { filedAtFor } from './amendment_filed.js'

const now = new Date('2026-10-24T15:00:00Z')

describe('filedAtFor', () => {
  it('keeps the date given, at noon UTC so it reads the same in every US time zone', () => {
    expect(filedAtFor('2026-05-11', 2023, now)).toEqual({ ok: true, filed_at: '2026-05-11T12:00:00.000Z' })
    expect(filedAtFor('2026-10-24', 2025, now)).toEqual({ ok: true, filed_at: '2026-10-24T12:00:00.000Z' })
  })

  it('is now when no date is given', () => {
    expect(filedAtFor(undefined, 2023, now)).toEqual({ ok: true, filed_at: now.toISOString() })
  })

  it('refuses a date that is not one, one in the future, or one before the tax year ended', () => {
    expect(filedAtFor('05/11/2026', 2023, now)).toMatchObject({ ok: false, error: 'filed_on must be a date, YYYY-MM-DD' })
    expect(filedAtFor('2026-02-30', 2023, now)).toMatchObject({ ok: false })
    expect(filedAtFor('2026-10-25', 2023, now)).toMatchObject({ ok: false, error: 'filed_on 2026-10-25 is in the future' })
    expect(filedAtFor('2023-12-31', 2023, now)).toMatchObject({ ok: false, error: 'filed_on 2023-12-31 is before the 2023 tax year ended' })
  })
})
