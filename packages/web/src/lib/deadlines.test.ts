import { describe, it, expect } from 'vitest'
import { nextDeadline } from './deadlines'
import type { Obligation } from '@/hooks/use-calendar'

const o = (id: string, days_until: number, status: Obligation['status'] = 'pending', urgency: Obligation['urgency'] = 'upcoming') =>
  ({ id, days_until, status, urgency, title: id }) as Obligation

describe('nextDeadline', () => {
  it('skips past dates — an unconfirmed December payment is not the next deadline', () => {
    const list = [o('q4-est', -311, 'pending', 'unverified'), o('late-return', -7, 'pending', 'overdue'), o('q4-2026', 54), o('return-2026', 175)]
    expect(nextDeadline(list)?.id).toBe('q4-2026')
  })
  it('ignores done and dismissed items; today counts', () => {
    expect(nextDeadline([o('a', 0, 'done'), o('b', 3, 'dismissed'), o('c', 0)])?.id).toBe('c')
    expect(nextDeadline([o('a', -1)])).toBeUndefined()
    expect(nextDeadline(undefined)).toBeUndefined()
  })
})
