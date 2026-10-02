/**
 * Paging and customer lookup on the Stripe routes.
 *
 * Three things were missing and they compounded into "you cannot get from an
 * invoice to the customer it belongs to":
 *
 *  - Invoice rows carried customer_name and customer_email but NOT the cus_
 *    id, which is what every write is keyed by. The only route to an id was
 *    to list customers and match on the name.
 *  - That list returned one page. Every route accepted `starting_after` but
 *    no tool exposed it, so a response said has_more: true with nothing the
 *    caller could do; only the revenue summary, which loops internally, ever
 *    saw page two.
 *  - And there was no name search, so the name you had to match on could only
 *    be found by walking the pages you could not walk.
 *
 * `limit` made it worse: it went to Stripe verbatim while the MCP tool allowed
 * 200, and Stripe 400s above 100 — so asking for a big page returned an error
 * instead of a page.
 */
import { describe, it, expect } from 'vitest'
import { pageParams, nextCursor, customerQuery, customerCursor, STRIPE_PAGE_MAX } from './stripe.js'

const q = (query: Record<string, any>) => ({ query } as any)

describe('pageParams', () => {
  it('defaults to 25 rows and no cursor', () => {
    expect(pageParams(q({}))).toEqual({ limit: '25' })
  })

  it('clamps to Stripe\'s ceiling of 100 rather than letting it 400', () => {
    expect(STRIPE_PAGE_MAX).toBe(100)
    expect(pageParams(q({ limit: '200' })).limit).toBe('100')
    expect(pageParams(q({ limit: '101' })).limit).toBe('100')
    expect(pageParams(q({ limit: '100' })).limit).toBe('100')
    expect(pageParams(q({ limit: '50' })).limit).toBe('50')
  })

  it('ignores a limit that is not a usable number', () => {
    for (const bad of ['', 'all', '0', '-5', 'NaN']) {
      expect(pageParams(q({ limit: bad })).limit, `limit=${bad}`).toBe('25')
    }
  })

  it('accepts cursor, and starting_after as the older spelling', () => {
    expect(pageParams(q({ cursor: 'in_123' })).starting_after).toBe('in_123')
    expect(pageParams(q({ starting_after: 'in_456' })).starting_after).toBe('in_456')
    // cursor wins when both are sent
    expect(pageParams(q({ cursor: 'in_new', starting_after: 'in_old' })).starting_after).toBe('in_new')
  })
})

describe('nextCursor', () => {
  it('is the last id on the page when more remain', () => {
    expect(nextCursor({ has_more: true, data: [{ id: 'a' }, { id: 'b' }] })).toBe('b')
  })

  it('is null on the last page, so the caller knows to stop', () => {
    expect(nextCursor({ has_more: false, data: [{ id: 'a' }] })).toBeNull()
  })

  it('is null when has_more is set but the page is empty', () => {
    // Would otherwise hand back undefined and loop forever on the same page.
    expect(nextCursor({ has_more: true, data: [] })).toBeNull()
    expect(nextCursor({})).toBeNull()
    expect(nextCursor(null)).toBeNull()
  })
})

describe('customerQuery', () => {
  it('lists when no name is given', () => {
    const { path, params, byName } = customerQuery({})
    expect(path).toBe('/customers')
    expect(byName).toBe(false)
    expect(params).toEqual({ limit: '25' })
  })

  it('filters the list by exact email', () => {
    const { path, params } = customerQuery({ email: 'a@example.invalid' })
    expect(path).toBe('/customers')
    expect(params.email).toBe('a@example.invalid')
  })

  it('switches to the search API for a name, as a substring match', () => {
    const { path, params, byName } = customerQuery({ name: 'acme' })
    expect(path).toBe('/customers/search')
    expect(byName).toBe(true)
    expect(params.query).toBe('name~"acme"')
  })

  it('ignores a name that is only whitespace', () => {
    expect(customerQuery({ name: '   ' }).path).toBe('/customers')
  })

  it('escapes quotes and backslashes so a name cannot break the query', () => {
    // An unescaped quote would terminate the query string early and Stripe
    // would reject the whole call.
    expect(customerQuery({ name: 'Jo "JJ" Smith' }).params.query).toBe('name~"Jo \\"JJ\\" Smith"')
    expect(customerQuery({ name: 'a\\b' }).params.query).toBe('name~"a\\\\b"')
  })

  it('sends the cursor to the parameter each endpoint actually uses', () => {
    // Search paginates by page token, list by object id. One knob in, two
    // parameters out.
    expect(customerQuery({ cursor: 'cus_123' }).params.starting_after).toBe('cus_123')
    expect(customerQuery({ cursor: 'cus_123' }).params.page).toBeUndefined()
    expect(customerQuery({ name: 'acme', cursor: 'pg_abc' }).params.page).toBe('pg_abc')
    expect(customerQuery({ name: 'acme', cursor: 'pg_abc' }).params.starting_after).toBeUndefined()
  })

  it('clamps the search limit too', () => {
    expect(customerQuery({ name: 'acme', limit: '500' }).params.limit).toBe('100')
  })
})

describe('customerCursor', () => {
  it('uses the search page token when the lookup was a name search', () => {
    expect(customerCursor({ has_more: true, next_page: 'pg_2', data: [{ id: 'cus_a' }] }, true)).toBe('pg_2')
  })

  it('uses the last customer id when the lookup was a list', () => {
    expect(customerCursor({ has_more: true, data: [{ id: 'cus_a' }, { id: 'cus_b' }] }, false)).toBe('cus_b')
  })

  it('stops at the end of either', () => {
    expect(customerCursor({ has_more: false, data: [{ id: 'cus_a' }] }, false)).toBeNull()
    expect(customerCursor({ has_more: false, next_page: 'pg_2', data: [] }, true)).toBeNull()
  })

  it('does not invent a token when search says more but gives none', () => {
    expect(customerCursor({ has_more: true, data: [{ id: 'cus_a' }] }, true)).toBeNull()
  })
})
