// Pins the created_gte/created_lte contract: the MCP tool doc promised
// "Unix ts or YYYY-MM-DD" from day one, but date strings reached Stripe
// verbatim and bounced. toStripeTs is the single coercion point.
import { describe, it, expect } from 'vitest'
import { toStripeTs } from './stripe.js'

describe('toStripeTs', () => {
  it('converts YYYY-MM-DD to Unix seconds at UTC midnight', () => {
    expect(toStripeTs('2026-08-01')).toBe(String(Date.UTC(2026, 7, 1) / 1000))
    expect(toStripeTs('1970-01-01')).toBe('0')
  })

  it('passes Unix timestamps through untouched', () => {
    expect(toStripeTs('1754006400')).toBe('1754006400')
  })

  it('leaves non-date strings alone for Stripe to reject with its own error', () => {
    expect(toStripeTs('last-month')).toBe('last-month')
    expect(toStripeTs('2026-8-1')).toBe('2026-8-1')
  })
})
