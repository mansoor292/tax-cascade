import type { Obligation } from '@/hooks/use-calendar'

/**
 * The next deadline still ahead. Both the Dashboard card and the Calendar's
 * "Next up" took the first PENDING obligation, which is the oldest
 * unconfirmed one — the demo group's Dashboard read "Next deadline −311d"
 * (a December estimated payment) while the Calendar's own Overdue card said 0
 * (UI audit, 2026-10-22). Past dates are counted where they belong: overdue,
 * or needs confirming.
 */
export function nextDeadline(obligations: Obligation[] | undefined): Obligation | undefined {
  return (obligations ?? [])
    .filter(o => o.status === 'pending' && o.days_until >= 0)
    .sort((a, b) => a.days_until - b.days_until)[0]
}
