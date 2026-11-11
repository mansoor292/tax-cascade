/**
 * A Stripe rejection keeps Stripe's status (2026-11-11). GET /invoices/in_none
 * on production answered 500 "No such invoice", so the billing worker could
 * not tell a vanished draft (stop looking) from tax-api being down (retry).
 */
import { describe, it, expect } from 'vitest'
import { errorOutcome } from './http_error.js'
import { StripeApiError } from '../routes/stripe.js'

describe('errorOutcome with a StripeApiError', () => {
  it('passes a 404 through, with Stripe\'s code', () => {
    const out = errorOutcome(new StripeApiError("No such invoice: 'in_none'", 404, 'resource_missing'))
    expect(out.status).toBe(404)
    expect(out.body).toEqual({ error: "No such invoice: 'in_none'", code: 'resource_missing' })
  })

  it('passes a declined card (402) through', () => {
    expect(errorOutcome(new StripeApiError('Your card was declined.', 402, 'card_declined')).status).toBe(402)
  })

  it('still treats a Stripe 5xx as our failure', () => {
    expect(errorOutcome(new StripeApiError('Stripe API 503', 503)).status).toBe(500)
  })

  it('leaves a plain Error on the old path', () => {
    expect(errorOutcome(new Error("No such invoice: 'in_none'")).status).toBe(500)
  })
})
