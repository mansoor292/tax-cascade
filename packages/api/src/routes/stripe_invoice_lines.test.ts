/**
 * Invoice create input, shaped for Stripe without a network.
 *
 * Why these rules exist (2026-11-10): the catalogs.com billing worker builds
 * invoices from quantity × unit price — "117 leads × $0.75" — and wants the
 * customer to SEE that, not a flat $87.75. Stripe does that arithmetic when
 * the invoiceitem carries quantity + unit_amount (integer cents); we only
 * convert the unit price. The same worker retries, so it sends an
 * idempotency_key; and it stamps its own ids into metadata and prints a
 * reference in custom_fields, both of which Stripe caps hard. Catching a bad
 * shape here, by field name, beats Stripe's parameter error after the draft
 * already exists.
 */
import { describe, it, expect } from 'vitest'
import {
  dollarsToCents, normalizeInvoiceLines, customFieldParams, metadataParams,
  idempotencyKey, lineIdempotencyKey, parseInvoiceCreate, deleteRefusal,
  InvoiceInputError, CUSTOM_FIELDS_MAX, METADATA_KEYS_MAX, IDEMPOTENCY_KEY_MAX,
} from './stripe.js'

describe('dollarsToCents', () => {
  it('converts a unit price to integer cents, half up', () => {
    expect(dollarsToCents(0.75)).toBe(75)
    expect(dollarsToCents(0.685)).toBe(69)
    expect(dollarsToCents(349.5)).toBe(34950)
    expect(dollarsToCents(117)).toBe(11700)
  })

  it('does not fall into the binary-float trap on an exact half', () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE 754; a bare Math.round gives 100.
    expect(dollarsToCents(1.005)).toBe(101)
    expect(dollarsToCents(2.675)).toBe(268)
  })
})

describe('normalizeInvoiceLines', () => {
  it('keeps a flat dollar amount as cents, as it always did', () => {
    expect(normalizeInvoiceLines([{ description: 'Setup', amount: 349.5 }]))
      .toEqual([{ description: 'Setup', amount: 34950 }])
  })

  it('passes quantity through and converts only the unit price', () => {
    // 117 × $0.75 = $87.75 is Stripe's arithmetic (8775 on the line total);
    // the line we send carries 117 and 75.
    expect(normalizeInvoiceLines([{ description: 'Leads', quantity: 117, unit_amount: 0.75 }]))
      .toEqual([{ description: 'Leads', quantity: 117, unit_amount: 75 }])
    expect(normalizeInvoiceLines([{ description: 'Leads', quantity: 3, unit_amount: 0.685 }])[0].unit_amount).toBe(69)
  })

  it('refuses a line that mixes amount with quantity or unit_amount', () => {
    expect(() => normalizeInvoiceLines([{ description: 'x', amount: 5, quantity: 2, unit_amount: 2.5 }]))
      .toThrow(/lines\[0\].*not both/)
    expect(() => normalizeInvoiceLines([{ description: 'x', amount: 5, quantity: 2 }]))
      .toThrow(/not both/)
    expect(() => normalizeInvoiceLines([{ description: 'x', amount: 5, unit_amount: 2.5 }]))
      .toThrow(/not both/)
  })

  it('refuses half a quantity line', () => {
    expect(() => normalizeInvoiceLines([{ description: 'x', quantity: 2 }])).toThrow(/both quantity and unit_amount/)
    expect(() => normalizeInvoiceLines([{ description: 'x', unit_amount: 2 }])).toThrow(/both quantity and unit_amount/)
    expect(() => normalizeInvoiceLines([{ description: 'x' }])).toThrow(/give amount/)
  })

  it('refuses negative, zero, and non-numeric amounts', () => {
    for (const amount of [-1, 0, NaN, Infinity, '5' as any]) {
      expect(() => normalizeInvoiceLines([{ description: 'x', amount }]), `amount=${amount}`)
        .toThrow(/lines\[0\]\.amount must be a positive/)
    }
    for (const unit_amount of [-0.5, 0, NaN, '0.75' as any]) {
      expect(() => normalizeInvoiceLines([{ description: 'x', quantity: 1, unit_amount }]), `unit_amount=${unit_amount}`)
        .toThrow(/unit_amount must be a positive/)
    }
  })

  it('wants a whole, positive quantity', () => {
    for (const quantity of [0, -3, 1.5, '2' as any]) {
      expect(() => normalizeInvoiceLines([{ description: 'x', quantity, unit_amount: 1 }]), `quantity=${quantity}`)
        .toThrow(/quantity must be a whole number/)
    }
  })

  it('wants a description on every line and names the offending index', () => {
    expect(() => normalizeInvoiceLines([{ description: 'ok', amount: 1 }, { description: '  ', amount: 1 }]))
      .toThrow(/lines\[1\]\.description/)
    expect(() => normalizeInvoiceLines([{ amount: 1 }])).toThrow(/lines\[0\]\.description/)
  })

  it('refuses an empty or non-array lines value', () => {
    expect(() => normalizeInvoiceLines([])).toThrow(/non-empty array/)
    expect(() => normalizeInvoiceLines(undefined)).toThrow(/non-empty array/)
    expect(() => normalizeInvoiceLines('lines')).toThrow(/non-empty array/)
    expect(() => normalizeInvoiceLines([null])).toThrow(/lines\[0\] must be an object/)
  })

  it('throws the typed error the route turns into a 400', () => {
    expect(() => normalizeInvoiceLines([])).toThrow(InvoiceInputError)
  })
})

describe('customFieldParams', () => {
  it('encodes up to four fields the way Stripe wants them', () => {
    expect(CUSTOM_FIELDS_MAX).toBe(4)
    const four = [1, 2, 3, 4].map(i => ({ name: `Ref ${i}`, value: `v${i}` }))
    const params = customFieldParams(four)
    expect(params['custom_fields[0][name]']).toBe('Ref 1')
    expect(params['custom_fields[0][value]']).toBe('v1')
    expect(params['custom_fields[3][name]']).toBe('Ref 4')
    expect(Object.keys(params)).toHaveLength(8)
  })

  it('is empty when none are given', () => {
    expect(customFieldParams(undefined)).toEqual({})
    expect(customFieldParams(null)).toEqual({})
  })

  it('refuses a fifth field', () => {
    const five = [1, 2, 3, 4, 5].map(i => ({ name: `n${i}`, value: `v${i}` }))
    expect(() => customFieldParams(five)).toThrow(/at most 4/)
  })

  it('holds the name to 40 and the value to 140 characters', () => {
    expect(() => customFieldParams([{ name: 'n'.repeat(41), value: 'v' }])).toThrow(/name is over 40/)
    expect(() => customFieldParams([{ name: 'n', value: 'v'.repeat(141) }])).toThrow(/value is over 140/)
    expect(customFieldParams([{ name: 'n'.repeat(40), value: 'v'.repeat(140) }])['custom_fields[0][name]']).toHaveLength(40)
  })

  it('wants both halves of every field', () => {
    expect(() => customFieldParams([{ name: 'PO' }])).toThrow(/custom_fields\[0\]\.value/)
    expect(() => customFieldParams([{ value: '123' }])).toThrow(/custom_fields\[0\]\.name/)
    expect(() => customFieldParams([{ name: 'PO', value: 7 }])).toThrow(/custom_fields\[0\]\.value/)
    expect(() => customFieldParams({ name: 'PO', value: '1' })).toThrow(/must be an array/)
  })
})

describe('metadataParams', () => {
  it('encodes a string map as metadata[key]', () => {
    expect(metadataParams({ catalog_id: '1747', period: '2026-10' }))
      .toEqual({ 'metadata[catalog_id]': '1747', 'metadata[period]': '2026-10' })
    expect(metadataParams(undefined)).toEqual({})
  })

  it('refuses anything that is not a string → string map', () => {
    expect(() => metadataParams({ catalog_id: 1747 })).toThrow(/metadata\.catalog_id must be a string/)
    expect(() => metadataParams(['a'])).toThrow(/must be an object/)
    expect(() => metadataParams('a=b')).toThrow(/must be an object/)
  })

  it('stops at Stripe\'s 50-key ceiling', () => {
    expect(METADATA_KEYS_MAX).toBe(50)
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']))
    expect(Object.keys(metadataParams(fifty))).toHaveLength(50)
    expect(() => metadataParams({ ...fifty, extra: 'v' })).toThrow(/at most 50 keys/)
  })

  it('holds keys to 40 and values to 500 characters', () => {
    expect(() => metadataParams({ ['k'.repeat(41)]: 'v' })).toThrow(/1-40 characters/)
    expect(() => metadataParams({ k: 'v'.repeat(501) })).toThrow(/over 500/)
  })
})

describe('idempotencyKey', () => {
  it('is null when the caller sent none', () => {
    expect(idempotencyKey(undefined)).toBeNull()
    expect(idempotencyKey(null)).toBeNull()
  })

  it('passes a sane key through', () => {
    expect(idempotencyKey('catalogs:invoice:1747:2026-10', 3)).toBe('catalogs:invoice:1747:2026-10')
  })

  it('derives one key per line', () => {
    expect(lineIdempotencyKey('abc', 0)).toBe('abc:line:0')
    expect(lineIdempotencyKey('abc', 12)).toBe('abc:line:12')
  })

  it('refuses an empty, non-string, or over-long key', () => {
    expect(IDEMPOTENCY_KEY_MAX).toBe(255)
    expect(() => idempotencyKey('')).toThrow(/non-empty string/)
    expect(() => idempotencyKey('   ')).toThrow(/non-empty string/)
    expect(() => idempotencyKey(42)).toThrow(/non-empty string/)
    expect(() => idempotencyKey('k'.repeat(256))).toThrow(/over 255/)
    expect(idempotencyKey('k'.repeat(255))).toHaveLength(255)
  })

  it('refuses a key whose per-line suffix would push past 255', () => {
    // The invoice create would succeed and then every line would bounce.
    expect(() => idempotencyKey('k'.repeat(250), 2)).toThrow(/per-line suffix/)
    expect(idempotencyKey('k'.repeat(248), 2)).toHaveLength(248)
  })
})

describe('parseInvoiceCreate', () => {
  const body = {
    customer: 'cus_123',
    lines: [
      { description: 'Leads', quantity: 117, unit_amount: 0.75 },
      { description: 'Setup', amount: 25 },
    ],
    metadata: { catalog_id: '1747' },
    custom_fields: [{ name: 'Catalog', value: 'PFI Westernwear' }],
    description: 'October 2026',
    footer: 'Thank you',
    idempotency_key: 'catalogs:1747:2026-10',
  }

  it('shapes the invoice and its lines for Stripe', () => {
    const p = parseInvoiceCreate(body)
    expect(p.customer).toBe('cus_123')
    expect(p.currency).toBe('usd')
    expect(p.invoice).toEqual({
      customer: 'cus_123',
      currency: 'usd',
      collection_method: 'send_invoice',
      auto_advance: 'false',
      pending_invoice_items_behavior: 'exclude',
      days_until_due: '30',
      description: 'October 2026',
      footer: 'Thank you',
      'metadata[catalog_id]': '1747',
      'custom_fields[0][name]': 'Catalog',
      'custom_fields[0][value]': 'PFI Westernwear',
    })
    expect(p.lines).toEqual([
      { customer: 'cus_123', currency: 'usd', description: 'Leads', quantity: '117', unit_amount: '75' },
      { customer: 'cus_123', currency: 'usd', description: 'Setup', amount: '2500' },
    ])
    expect(p.idempotency_key).toBe('catalogs:1747:2026-10')
  })

  it('keeps the draft-only safety parameters no matter what is sent', () => {
    const p = parseInvoiceCreate({ ...body, auto_advance: true, pending_invoice_items_behavior: 'include' })
    expect(p.invoice.auto_advance).toBe('false')
    expect(p.invoice.pending_invoice_items_behavior).toBe('exclude')
  })

  it('drops days_until_due for charge_automatically and honours it for send_invoice', () => {
    expect(parseInvoiceCreate({ ...body, collection_method: 'charge_automatically' }).invoice.days_until_due).toBeUndefined()
    expect(parseInvoiceCreate({ ...body, days_until_due: 14 }).invoice.days_until_due).toBe('14')
    expect(() => parseInvoiceCreate({ ...body, days_until_due: -1 })).toThrow(/days_until_due/)
  })

  it('lower-cases the currency and refuses a non-ISO one', () => {
    expect(parseInvoiceCreate({ ...body, currency: 'USD' }).currency).toBe('usd')
    expect(parseInvoiceCreate({ ...body, currency: 'USD' }).lines[0].currency).toBe('usd')
    expect(() => parseInvoiceCreate({ ...body, currency: 'dollars' })).toThrow(/currency/)
  })

  it('needs a customer id and a known collection method', () => {
    expect(() => parseInvoiceCreate({ ...body, customer: 'acme' })).toThrow(/cus_/)
    expect(() => parseInvoiceCreate({ ...body, customer: undefined })).toThrow(/cus_/)
    expect(() => parseInvoiceCreate({ ...body, collection_method: 'email' })).toThrow(/collection_method/)
    expect(() => parseInvoiceCreate(undefined)).toThrow(/cus_/)
  })

  it('leaves optional text out when it is absent and refuses it when it is not text', () => {
    const p = parseInvoiceCreate({ customer: 'cus_1', lines: [{ description: 'x', amount: 1 }] })
    expect(p.invoice.description).toBeUndefined()
    expect(p.invoice.footer).toBeUndefined()
    expect(p.idempotency_key).toBeNull()
    expect(Object.keys(p.invoice).some(k => k.startsWith('metadata['))).toBe(false)
    expect(() => parseInvoiceCreate({ ...body, description: { text: 'x' } })).toThrow(/description must be a string/)
  })

  it('surfaces line and field errors unchanged', () => {
    expect(() => parseInvoiceCreate({ ...body, lines: [{ description: 'x', amount: -5 }] })).toThrow(/lines\[0\]\.amount/)
    expect(() => parseInvoiceCreate({ ...body, custom_fields: Array(5).fill({ name: 'n', value: 'v' }) })).toThrow(/at most 4/)
    expect(() => parseInvoiceCreate({ ...body, metadata: { n: 1 } })).toThrow(/metadata\.n/)
  })
})

describe('deleteRefusal', () => {
  it('lets a draft go', () => {
    expect(deleteRefusal({ status: 'draft' })).toBeNull()
  })

  it('refuses anything finalized and points at void', () => {
    for (const status of ['open', 'paid', 'void', 'uncollectible']) {
      const why = deleteRefusal({ status })
      expect(why, status).toMatch(/only a draft/)
      expect(why, status).toContain(`'${status}'`)
      expect(why, status).toMatch(/void it instead/)
    }
  })

  it('refuses when there is no status to judge by', () => {
    expect(deleteRefusal(null)).toMatch(/refusing/)
    expect(deleteRefusal({})).toMatch(/refusing/)
  })
})
