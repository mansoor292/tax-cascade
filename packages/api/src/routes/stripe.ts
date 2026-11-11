/**
 * Stripe routes — Connect API key, query invoices, payments, balance transactions
 *
 * Users provide their Stripe secret key (sk_live_... or sk_test_...).
 * The key is stored per-entity and used to make Stripe API calls.
 */
import { Router, type Request } from 'express'
import { getDek, encrypt, decryptString } from '../lib/crypto.js'
import { encryptionEnabled } from '../lib/row_crypto.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { sendError, sendDbError } from '../lib/http_error.js'
import { requireWrite } from '../lib/scopes.js'

const supabase = lazyServiceClient()


/**
 * The stripe_key_encrypted column is text (no *_enc bytea twin), so the
 * ciphertext lives in the column itself behind an `enc1:` prefix:
 * enc1:<base64 of AES-256-GCM envelope from lib/crypto>. Rows written
 * before encryption landed hold the raw sk_/rk_ key and are still readable
 * here; they get re-encrypted the next time the entity reconnects.
 */
const STRIPE_KEY_ENC_PREFIX = 'enc1:'

/** Stripe's hard ceiling on `limit` for list and search endpoints alike. */
export const STRIPE_PAGE_MAX = 100

async function sealStripeKey(userId: string, plainKey: string): Promise<string> {
  if (!encryptionEnabled()) return plainKey
  const dek = await getDek(supabase, userId)
  return STRIPE_KEY_ENC_PREFIX + encrypt(dek, plainKey).toString('base64')
}

async function getStripeKey(entityId: string): Promise<string | null> {
  const { data } = await supabase.from('stripe_connection')
    .select('stripe_key_encrypted, user_id')
    .eq('entity_id', entityId).eq('is_active', true).single()
  const stored = data?.stripe_key_encrypted
  if (!stored) return null
  if (!stored.startsWith(STRIPE_KEY_ENC_PREFIX)) return stored
  try {
    const dek = await getDek(supabase, data.user_id)
    return decryptString(dek, Buffer.from(stored.slice(STRIPE_KEY_ENC_PREFIX.length), 'base64'))
  } catch (e: any) {
    console.error(`getStripeKey: decrypt failed for entity ${entityId}: ${e.message}`)
    return null
  }
}

/**
 * Minimum Stripe API version that serves the Search endpoints.
 *
 * Requests carry no Stripe-Version header, so they run on whatever version the
 * connected ACCOUNT is pinned to — and a long-lived account can be pinned
 * years back. The first live name search returned "Search is not supported on
 * api version 2019-03-14", which no unit test could have caught: the account
 * version is not in this repo.
 *
 * Only the search call overrides it. Raising the version for every call would
 * silently change response shapes on the endpoints that already work, across
 * seven years of Stripe releases, to fix one of them.
 */
const STRIPE_SEARCH_VERSION = '2020-08-27'

/**
 * `extraHeaders` exists for Stripe's `Idempotency-Key`: the billing worker
 * retries, and a retried invoice create without one is a second invoice.
 * Stripe replays the first response for the same key + same parameters and
 * rejects the same key with different parameters, which is the behaviour
 * the caller wants on both counts.
 */
async function stripeFetch(
  stripeKey: string, path: string, params?: Record<string, string>,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  apiVersion?: string,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  const encoded = params ? new URLSearchParams(params) : undefined
  const qs = method === 'GET' && encoded ? '?' + encoded.toString() : ''
  const resp = await fetch(`https://api.stripe.com/v1${path}${qs}`, {
    method,
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      ...(apiVersion ? { 'Stripe-Version': apiVersion } : {}),
      ...(method !== 'GET' && encoded ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(extraHeaders || {}),
    },
    ...(method !== 'GET' && encoded ? { body: encoded.toString() } : {}),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as any
    throw new StripeApiError(err?.error?.message || `Stripe API ${resp.status}`, resp.status, err?.error?.code)
  }
  return resp.json()
}

/**
 * A Stripe rejection keeps Stripe's status. Before this every failure became a
 * 500: a missing invoice ("No such invoice") read as our server breaking, so
 * the billing worker could not tell "that draft is gone" (404, stop looking)
 * from "tax-api is down" (retry later). errorOutcome passes a 4xx through.
 */
export class StripeApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'StripeApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Stripe's created[gte]/[lte] accept Unix seconds ONLY, but the MCP tool
 * doc always promised "Unix ts or YYYY-MM-DD" — a date string sailed
 * through to Stripe and bounced with a cryptic parameter error. Coerce
 * here so both spellings work for every caller.
 */
export function toStripeTs(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return String(Math.floor(Date.parse(v + 'T00:00:00Z') / 1000))
  return v
}

/**
 * Limit and cursor for the Stripe list routes.
 *
 * Two things were wrong and they compounded. `limit` went to Stripe verbatim
 * while the MCP tool allowed up to 200 — Stripe 400s above 100, so any caller
 * asking for a big page got an error instead of a page. And `starting_after`
 * was accepted by every route but exposed by no tool, so responses said
 * `has_more: true` with nothing the caller could do about it; only the revenue
 * summary, which loops internally, ever saw past the first page.
 *
 * `cursor` is the one name callers use, echoed back as `next_cursor`, so the
 * loop is: call, read next_cursor, pass it as cursor, repeat until null.
 */
export function pageParams(req: Pick<Request, 'query'>): Record<string, string> {
  const requested = parseInt(req.query.limit as string, 10)
  const params: Record<string, string> = {
    limit: String(Math.min(Number.isFinite(requested) && requested > 0 ? requested : 25, STRIPE_PAGE_MAX)),
  }
  const cursor = (req.query.cursor || req.query.starting_after) as string | undefined
  if (cursor) params.starting_after = cursor
  return params
}

/** The cursor for the NEXT call, or null when this was the last page. */
export function nextCursor(data: any): string | null {
  const rows = data?.data || []
  return data?.has_more && rows.length ? rows[rows.length - 1].id : null
}

/**
 * Which Stripe endpoint serves a customer lookup, and with what parameters.
 *
 * `name` searches; everything else lists. Stripe's /customers list filters by
 * email only — there is no name filter — so a name lookup has to go through
 * the Search API, which also paginates differently: a `page` token instead of
 * a `starting_after` object id. Callers see ONE knob, `cursor`, echoed back as
 * `next_cursor`, because a model picking between two cursor parameters by
 * endpoint is a thing that will go wrong. `starting_after` and `page` are both
 * still accepted as older spellings.
 */
export function customerQuery(q: Record<string, any>): {
  path: string; params: Record<string, string>; byName: boolean
} {
  const byName = typeof q.name === 'string' && q.name.trim() !== ''
  const cursor = (q.cursor || q.starting_after || q.page) as string | undefined
  const limit = pageParams({ query: q } as Pick<Request, 'query'>).limit

  if (byName) {
    // `~` is substring match. Quote the term and escape embedded backslashes
    // and quotes, or a name containing either breaks the query syntax.
    const term = String(q.name).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const params: Record<string, string> = { limit, query: `name~"${term}"` }
    if (cursor) params.page = cursor
    return { path: '/customers/search', params, byName }
  }

  const params: Record<string, string> = { limit }
  if (q.email) params.email = String(q.email)
  if (cursor) params.starting_after = cursor
  return { path: '/customers', params, byName }
}

/** Search returns a page token; list wants the last id on the page. */
export function customerCursor(data: any, byName: boolean): string | null {
  if (!data?.has_more) return null
  if (byName) return data.next_page ?? null
  return nextCursor(data)
}

const router = Router()

// Ownership gate for every :entity_id route — same hole, same fix as qbo.ts:
// connection status and Stripe data were readable by any authenticated user
// who knew an entity UUID. Found by the cross-tenant e2e matrix.
router.param('entity_id', async (req, res, next, entityId) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const { data } = await supabase.from('tax_entity')
    .select('id').eq('id', entityId).eq('user_id', userId).single()
  if (!data) return res.status(404).json({ error: 'Entity not found' })
  next()
})

// ─── Connect Stripe ───
router.post('/:entity_id/connect', requireWrite, async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { stripe_key } = req.body
  if (!stripe_key || (!stripe_key.startsWith('sk_live_') && !stripe_key.startsWith('sk_test_') && !stripe_key.startsWith('rk_live_') && !stripe_key.startsWith('rk_test_'))) {
    return res.status(400).json({ error: 'Invalid Stripe key. Must start with sk_live_, sk_test_, rk_live_, or rk_test_' })
  }

  // Verify the key works
  let accountName = ''
  let accountId = ''
  try {
    const account = await stripeFetch(stripe_key, '/account')
    accountName = account.business_profile?.name || account.settings?.dashboard?.display_name || ''
    accountId = account.id || ''
  } catch (e: any) {
    return res.status(400).json({ error: `Stripe key verification failed: ${e.message}` })
  }

  const { error } = await supabase.from('stripe_connection').upsert({
    entity_id: req.params.entity_id,
    user_id: userId,
    stripe_key_encrypted: await sealStripeKey(userId, stripe_key),
    account_name: accountName,
    account_id: accountId,
    connected_at: new Date().toISOString(),
    is_active: true,
  }, { onConflict: 'entity_id' })

  if (error) return sendDbError(res, error)

  res.json({ connected: true, account_name: accountName, account_id: accountId })
})

// ─── Status ───
router.get('/:entity_id/status', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data } = await supabase.from('stripe_connection')
    .select('account_name, account_id, connected_at, is_active')
    .eq('entity_id', req.params.entity_id).single()

  if (!data) return res.json({ connected: false })
  res.json({ connected: data.is_active, ...data })
})

// ─── Disconnect ───
router.delete('/:entity_id/disconnect', requireWrite, async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  await supabase.from('stripe_connection').update({ is_active: false })
    .eq('entity_id', req.params.entity_id)
  res.json({ disconnected: true })
})

// ─── Invoices ───
router.get('/:entity_id/invoices', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = pageParams(req)
  if (req.query.status) params.status = req.query.status as string
  if (req.query.customer) params.customer = req.query.customer as string
  if (req.query.created_gte) params['created[gte]'] = toStripeTs(req.query.created_gte as string)
  if (req.query.created_lte) params['created[lte]'] = toStripeTs(req.query.created_lte as string)

  try {
    const data = await stripeFetch(stripeKey, '/invoices', params)
    await supabase.from('stripe_connection').update({ last_used_at: new Date().toISOString() })
      .eq('entity_id', req.params.entity_id)

    res.json({
      count: data.data?.length || 0,
      has_more: Boolean(data.has_more),
      next_cursor: nextCursor(data),
      invoices: (data.data || []).map(invoiceRow),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// ─── Payments (charges) ───
router.get('/:entity_id/payments', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = pageParams(req)
  if (req.query.created_gte) params['created[gte]'] = toStripeTs(req.query.created_gte as string)
  if (req.query.created_lte) params['created[lte]'] = toStripeTs(req.query.created_lte as string)

  try {
    const data = await stripeFetch(stripeKey, '/charges', params)
    res.json({
      count: data.data?.length || 0,
      has_more: Boolean(data.has_more),
      next_cursor: nextCursor(data),
      payments: (data.data || []).map((ch: any) => ({
        id: ch.id,
        amount: ch.amount / 100,
        currency: ch.currency,
        status: ch.status,
        description: ch.description,
        // `customer` has always been the display name; the raw cus_ id rides
        // next to it so a payment can be tied back to the invoice's customer
        // without a name match.
        customer: ch.billing_details?.name || ch.billing_details?.email,
        customer_id: idOf(ch.customer),
        invoice: idOf(ch.invoice),
        payment_intent: idOf(ch.payment_intent),
        paid: Boolean(ch.paid),
        refunded: Boolean(ch.refunded),
        failure_code: ch.failure_code ?? null,
        failure_message: ch.failure_message ?? null,
        balance_transaction: idOf(ch.balance_transaction),
        created: new Date(ch.created * 1000).toISOString().split('T')[0],
        receipt_url: ch.receipt_url,
      })),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// ─── Balance Transactions ───
router.get('/:entity_id/balance-transactions', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = pageParams(req)
  if (req.query.type) params.type = req.query.type as string
  if (req.query.created_gte) params['created[gte]'] = toStripeTs(req.query.created_gte as string)
  if (req.query.created_lte) params['created[lte]'] = toStripeTs(req.query.created_lte as string)

  try {
    const data = await stripeFetch(stripeKey, '/balance_transactions', params)
    res.json({
      count: data.data?.length || 0,
      has_more: Boolean(data.has_more),
      next_cursor: nextCursor(data),
      transactions: (data.data || []).map((bt: any) => ({
        id: bt.id,
        amount: bt.amount / 100,
        fee: bt.fee / 100,
        net: bt.net / 100,
        currency: bt.currency,
        type: bt.type,
        description: bt.description,
        created: new Date(bt.created * 1000).toISOString().split('T')[0],
        status: bt.status,
      })),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// ─── Payouts ───
router.get('/:entity_id/payouts', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = pageParams(req)

  try {
    const data = await stripeFetch(stripeKey, '/payouts', params)
    res.json({
      count: data.data?.length || 0,
      has_more: Boolean(data.has_more),
      next_cursor: nextCursor(data),
      payouts: (data.data || []).map((p: any) => ({
        id: p.id,
        amount: p.amount / 100,
        currency: p.currency,
        status: p.status,
        arrival_date: new Date(p.arrival_date * 1000).toISOString().split('T')[0],
        created: new Date(p.created * 1000).toISOString().split('T')[0],
        description: p.description,
      })),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// ─── Customers ───
router.get('/:entity_id/customers', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const { path, params, byName } = customerQuery(req.query)

  try {
    // Search needs a modern API version; the list path keeps the account's.
    const data = await stripeFetch(
      stripeKey, path, params, 'GET', byName ? STRIPE_SEARCH_VERSION : undefined,
    )
    const rows = data.data || []

    res.json({
      count: rows.length,
      has_more: Boolean(data.has_more),
      next_cursor: customerCursor(data, byName),
      matched_by: byName ? 'name_search' : 'list',
      customers: rows.map((c: any) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        created: new Date(c.created * 1000).toISOString().split('T')[0],
        balance: c.balance / 100,
        currency: c.currency,
      })),
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// ─── Revenue summary (for tax purposes) ───
router.get('/:entity_id/revenue', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const year = req.query.year as string || new Date().getFullYear().toString()
  const startTs = Math.floor(new Date(`${year}-01-01`).getTime() / 1000).toString()
  const endTs = Math.floor(new Date(`${parseInt(year) + 1}-01-01`).getTime() / 1000).toString()

  try {
    // Get all balance transactions for the year (paginate)
    const allTxns: any[] = []
    let hasMore = true
    let startingAfter: string | undefined

    while (hasMore) {
      const params: Record<string, string> = {
        limit: '100', 'created[gte]': startTs, 'created[lt]': endTs,
      }
      if (startingAfter) params.starting_after = startingAfter

      const data = await stripeFetch(stripeKey, '/balance_transactions', params)
      allTxns.push(...(data.data || []))
      hasMore = data.has_more
      if (data.data?.length) startingAfter = data.data[data.data.length - 1].id

      // Safety: cap at 10k transactions
      if (allTxns.length >= 10000) break
    }

    // Summarize by type
    const summary: Record<string, { count: number; gross: number; fees: number; net: number }> = {}
    for (const txn of allTxns) {
      const type = txn.type || 'other'
      if (!summary[type]) summary[type] = { count: 0, gross: 0, fees: 0, net: 0 }
      summary[type].count++
      summary[type].gross += txn.amount / 100
      summary[type].fees += txn.fee / 100
      summary[type].net += txn.net / 100
    }

    // Round
    for (const s of Object.values(summary)) {
      s.gross = Math.round(s.gross * 100) / 100
      s.fees = Math.round(s.fees * 100) / 100
      s.net = Math.round(s.net * 100) / 100
    }

    const totalGross = Object.values(summary).reduce((s, v) => s + v.gross, 0)
    const totalFees = Object.values(summary).reduce((s, v) => s + v.fees, 0)
    const totalNet = Object.values(summary).reduce((s, v) => s + v.net, 0)

    res.json({
      year: parseInt(year),
      transaction_count: allTxns.length,
      total_gross: Math.round(totalGross * 100) / 100,
      total_fees: Math.round(totalFees * 100) / 100,
      total_net: Math.round(totalNet * 100) / 100,
      by_type: summary,
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

// ─── Invoice reads and writes: get / create / finalize / pay / void / delete ───
// Real-money surface. Amounts cross this boundary in DOLLARS (matching the
// read routes, which divide Stripe's cents by 100) and convert to cents
// exactly once, here. `pay` charges the customer's default payment method
// immediately — the MCP tool carries the confirm-with-the-user rule
// in-band; this layer only guarantees ownership, shape, and honest errors.

const INVOICE_ID_RE = /^in_[A-Za-z0-9]+$/

/** A Stripe expandable field as its id — string, expanded object, or absent. */
function idOf(v: any): string | null {
  if (typeof v === 'string') return v
  return v?.id ?? null
}

function dateOf(ts: any): string | null {
  return ts ? new Date(ts * 1000).toISOString().split('T')[0] : null
}

function isoOf(ts: any): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null
}

/** One list row. Every field a caller needs to act on the invoice. */
function invoiceRow(inv: any) {
  return {
    id: inv.id,
    number: inv.number,
    // The customer ID, not just the display name. Every write route
    // (invoice create, and the `customer` filter on the list) is keyed by
    // cus_..., so without it on the row there was no way to get from an
    // invoice you can see to an action you can take — the caller had to go
    // list customers and match on name, which only works if the name is
    // unique and the customer is on the first page.
    customer: idOf(inv.customer),
    customer_name: inv.customer_name,
    customer_email: inv.customer_email,
    status: inv.status,
    amount_due: inv.amount_due / 100,
    amount_paid: inv.amount_paid / 100,
    currency: inv.currency,
    collection_method: inv.collection_method,
    created: dateOf(inv.created),
    due_date: dateOf(inv.due_date),
    description: inv.description,
    // The billing worker stamps its own ids here and reads them back to
    // reconcile, so metadata and the printed custom fields ride on every row.
    metadata: inv.metadata ?? {},
    custom_fields: inv.custom_fields ?? null,
    charge: idOf(inv.charge),
  }
}

/** The row plus everything a single-invoice read or a write answer carries. */
function invoiceDetail(inv: any) {
  const t = inv.status_transitions || {}
  return {
    ...invoiceRow(inv),
    payment_intent: idOf(inv.payment_intent),
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    status_transitions: {
      finalized_at: isoOf(t.finalized_at),
      paid_at: isoOf(t.paid_at),
      voided_at: isoOf(t.voided_at),
      marked_uncollectible_at: isoOf(t.marked_uncollectible_at),
    },
  }
}

// ─── Pure input shaping for invoice create ───
// Exported so the rules are tested without a network: which line shapes are
// accepted, how dollars become cents, and the ceilings Stripe enforces on
// custom_fields and metadata — caught here with a message that names the
// field, instead of Stripe's parameter error after the draft already exists.

export class InvoiceInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvoiceInputError'
  }
}

/**
 * Dollars → integer cents, half up. `Math.round(x * 100)` alone gets 1.005
 * wrong (100.49999…) because the product is not exact in binary; trimming
 * the product to 12 significant digits first puts it back on the half.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toPrecision(12)))
}

export interface NormalizedLine {
  description: string
  /** Cents, for a flat line. */
  amount?: number
  /** Whole units, for a qty line. */
  quantity?: number
  /** Cents per unit, for a qty line. Stripe computes quantity × unit_amount. */
  unit_amount?: number
}

/**
 * Each line is EITHER { description, amount } (dollars, as it always was) OR
 * { description, quantity, unit_amount } (units × dollars per unit), so the
 * invoice shows "3 × $117.00" instead of a flat $351.00. Never both, never
 * neither, never a negative or zero amount.
 */
export function normalizeInvoiceLines(lines: unknown): NormalizedLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InvoiceInputError('lines must be a non-empty array of { description, amount } or { description, quantity, unit_amount } (dollars)')
  }
  return lines.map((line: any, i: number) => {
    const at = `lines[${i}]`
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw new InvoiceInputError(`${at} must be an object`)
    }
    if (typeof line.description !== 'string' || !line.description.trim()) {
      throw new InvoiceInputError(`${at}.description is required`)
    }
    const hasAmount = line.amount !== undefined && line.amount !== null
    const hasQty = line.quantity !== undefined && line.quantity !== null
    const hasUnit = line.unit_amount !== undefined && line.unit_amount !== null
    if (hasAmount && (hasQty || hasUnit)) {
      throw new InvoiceInputError(`${at}: use either amount or quantity + unit_amount, not both`)
    }
    if (hasAmount) {
      if (typeof line.amount !== 'number' || !isFinite(line.amount) || line.amount <= 0) {
        throw new InvoiceInputError(`${at}.amount must be a positive dollar amount`)
      }
      return { description: line.description, amount: dollarsToCents(line.amount) }
    }
    if (!hasQty || !hasUnit) {
      throw new InvoiceInputError(`${at}: give amount, or both quantity and unit_amount`)
    }
    if (typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new InvoiceInputError(`${at}.quantity must be a whole number of at least 1`)
    }
    if (typeof line.unit_amount !== 'number' || !isFinite(line.unit_amount) || line.unit_amount <= 0) {
      throw new InvoiceInputError(`${at}.unit_amount must be a positive dollar amount per unit`)
    }
    return {
      description: line.description,
      quantity: line.quantity,
      unit_amount: dollarsToCents(line.unit_amount),
    }
  })
}

export const CUSTOM_FIELDS_MAX = 4
export const CUSTOM_FIELD_NAME_MAX = 40
export const CUSTOM_FIELD_VALUE_MAX = 140
export const METADATA_KEYS_MAX = 50
export const METADATA_KEY_MAX = 40
export const METADATA_VALUE_MAX = 500
export const IDEMPOTENCY_KEY_MAX = 255

/** Stripe's invoice custom_fields, as the form parameters it expects. */
export function customFieldParams(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {}
  if (!Array.isArray(input)) throw new InvoiceInputError('custom_fields must be an array of { name, value }')
  if (input.length > CUSTOM_FIELDS_MAX) {
    throw new InvoiceInputError(`custom_fields allows at most ${CUSTOM_FIELDS_MAX} entries`)
  }
  const params: Record<string, string> = {}
  input.forEach((cf: any, i: number) => {
    const at = `custom_fields[${i}]`
    if (!cf || typeof cf !== 'object') throw new InvoiceInputError(`${at} must be { name, value }`)
    if (typeof cf.name !== 'string' || !cf.name.trim()) throw new InvoiceInputError(`${at}.name is required`)
    if (typeof cf.value !== 'string' || !cf.value.trim()) throw new InvoiceInputError(`${at}.value is required`)
    if (cf.name.length > CUSTOM_FIELD_NAME_MAX) {
      throw new InvoiceInputError(`${at}.name is over ${CUSTOM_FIELD_NAME_MAX} characters`)
    }
    if (cf.value.length > CUSTOM_FIELD_VALUE_MAX) {
      throw new InvoiceInputError(`${at}.value is over ${CUSTOM_FIELD_VALUE_MAX} characters`)
    }
    params[`${at}[name]`] = cf.name
    params[`${at}[value]`] = cf.value
  })
  return params
}

/** Stripe metadata (string → string), as form parameters. */
export function metadataParams(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvoiceInputError('metadata must be an object of string values')
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > METADATA_KEYS_MAX) {
    throw new InvoiceInputError(`metadata allows at most ${METADATA_KEYS_MAX} keys`)
  }
  const params: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (!k || k.length > METADATA_KEY_MAX) {
      throw new InvoiceInputError(`metadata key ${JSON.stringify(k)} must be 1-${METADATA_KEY_MAX} characters`)
    }
    if (typeof v !== 'string') throw new InvoiceInputError(`metadata.${k} must be a string`)
    if (v.length > METADATA_VALUE_MAX) {
      throw new InvoiceInputError(`metadata.${k} is over ${METADATA_VALUE_MAX} characters`)
    }
    params[`metadata[${k}]`] = v
  }
  return params
}

/**
 * The caller's idempotency key, or null when none was sent. `lineCount` is
 * how many `:line:N` suffixes will be derived from it — those have to fit
 * under Stripe's 255 too, or the invoice is created and the lines bounce.
 */
export function idempotencyKey(input: unknown, lineCount = 0): string | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string' || !input.trim()) {
    throw new InvoiceInputError('idempotency_key must be a non-empty string')
  }
  if (input.length > IDEMPOTENCY_KEY_MAX) {
    throw new InvoiceInputError(`idempotency_key is over ${IDEMPOTENCY_KEY_MAX} characters`)
  }
  const longest = lineCount > 0 ? lineIdempotencyKey(input, lineCount - 1).length : input.length
  if (longest > IDEMPOTENCY_KEY_MAX) {
    throw new InvoiceInputError(`idempotency_key is too long once the per-line suffix (:line:${lineCount - 1}) is added — keep it under ${IDEMPOTENCY_KEY_MAX - lineIdempotencyKey('', lineCount - 1).length} characters`)
  }
  return input
}

export function lineIdempotencyKey(key: string, i: number): string {
  return `${key}:line:${i}`
}

export interface ParsedInvoiceCreate {
  customer: string
  currency: string
  /** Form parameters for POST /v1/invoices. */
  invoice: Record<string, string>
  /** Form parameters for each POST /v1/invoiceitems; the route adds `invoice`. */
  lines: Record<string, string>[]
  idempotency_key: string | null
}

/** The whole create body, validated and shaped for Stripe. Throws InvoiceInputError. */
export function parseInvoiceCreate(body: any): ParsedInvoiceCreate {
  const {
    customer, lines, currency = 'usd', description, footer,
    collection_method = 'send_invoice', days_until_due,
    metadata, custom_fields, idempotency_key,
  } = body || {}
  if (typeof customer !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(customer)) {
    throw new InvoiceInputError('customer must be a Stripe customer id (cus_...)')
  }
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new InvoiceInputError('currency must be a 3-letter ISO code')
  }
  if (collection_method !== 'send_invoice' && collection_method !== 'charge_automatically') {
    throw new InvoiceInputError("collection_method must be 'send_invoice' or 'charge_automatically'")
  }
  if (days_until_due !== undefined && days_until_due !== null
    && (typeof days_until_due !== 'number' || !isFinite(days_until_due) || days_until_due < 0)) {
    throw new InvoiceInputError('days_until_due must be a non-negative number of days')
  }
  for (const [name, v] of [['description', description], ['footer', footer]] as const) {
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new InvoiceInputError(`${name} must be a string`)
    }
  }

  const normalized = normalizeInvoiceLines(lines)
  const cur = currency.toLowerCase()
  const invoice: Record<string, string> = {
    customer,
    currency: cur,
    collection_method,
    auto_advance: 'false',
    // Only the lines passed here may land on this invoice — never whatever
    // pending items happen to exist on the customer.
    pending_invoice_items_behavior: 'exclude',
    ...(collection_method === 'send_invoice'
      ? { days_until_due: String(Math.round(Number(days_until_due ?? 30))) } : {}),
    ...(description ? { description } : {}),
    ...(footer ? { footer } : {}),
    ...metadataParams(metadata),
    ...customFieldParams(custom_fields),
  }
  const lineParams = normalized.map(l => ({
    customer,
    currency: cur,
    description: l.description,
    ...(l.amount !== undefined
      ? { amount: String(l.amount) }
      : { quantity: String(l.quantity), unit_amount: String(l.unit_amount) }),
  }))
  return {
    customer, currency: cur, invoice, lines: lineParams,
    idempotency_key: idempotencyKey(idempotency_key, normalized.length),
  }
}

/**
 * Why an invoice may not be deleted, or null when it may. Stripe only
 * deletes drafts; anything finalized is voided instead, and the message
 * says so rather than relaying Stripe's error after a wasted call.
 */
export function deleteRefusal(inv: { status?: string } | null | undefined): string | null {
  const status = inv?.status
  if (status === 'draft') return null
  if (!status) return 'invoice has no status; refusing to delete'
  return `only a draft invoice can be deleted; this one is '${status}' — void it instead`
}

// Single invoice. The list route answers rows; this answers the row plus the
// payment linkage (charge, payment_intent) and the lifecycle timestamps the
// billing worker reconciles against.
router.get('/:entity_id/invoices/:invoice_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const invoiceId = req.params.invoice_id
  if (!INVOICE_ID_RE.test(invoiceId)) {
    return res.status(400).json({ error: 'invoice_id must be a Stripe invoice id (in_...)' })
  }

  try {
    const inv = await stripeFetch(stripeKey, `/invoices/${invoiceId}`)
    res.json({ invoice: invoiceDetail(inv) })
  } catch (e: any) {
    sendError(res, e)
  }
})

// Create a DRAFT invoice from explicit line items. Nothing is sent or
// charged at this stage; the draft must be finalized to become payable.
router.post('/:entity_id/invoices', requireWrite, async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  let parsed: ParsedInvoiceCreate
  try {
    parsed = parseInvoiceCreate(req.body)
  } catch (e: any) {
    if (e instanceof InvoiceInputError) return res.status(400).json({ error: e.message })
    throw e
  }

  try {
    const key = parsed.idempotency_key
    const invoice = await stripeFetch(
      stripeKey, '/invoices', parsed.invoice, 'POST', undefined,
      key ? { 'Idempotency-Key': key } : undefined,
    )

    for (const [i, line] of parsed.lines.entries()) {
      await stripeFetch(
        stripeKey, '/invoiceitems', { ...line, invoice: invoice.id }, 'POST', undefined,
        key ? { 'Idempotency-Key': lineIdempotencyKey(key, i) } : undefined,
      )
    }

    const withLines = await stripeFetch(stripeKey, `/invoices/${invoice.id}`)
    res.json({ created: true, invoice: invoiceDetail(withLines) })
  } catch (e: any) {
    sendError(res, e)
  }
})

// Shared handler shape for the three id-addressed actions.
function invoiceAction(action: 'finalize' | 'pay' | 'void') {
  return async (req: any, res: any) => {
    const userId = await getUser(req)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const stripeKey = await getStripeKey(req.params.entity_id)
    if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

    const invoiceId = req.params.invoice_id
    if (!INVOICE_ID_RE.test(invoiceId)) {
      return res.status(400).json({ error: 'invoice_id must be a Stripe invoice id (in_...)' })
    }

    let key: string | null
    try {
      key = idempotencyKey(req.body?.idempotency_key)
    } catch (e: any) {
      if (e instanceof InvoiceInputError) return res.status(400).json({ error: e.message })
      throw e
    }

    try {
      const inv = await stripeFetch(
        stripeKey, `/invoices/${invoiceId}/${action}`,
        action === 'finalize' ? { auto_advance: 'false' } : {},
        'POST', undefined,
        key ? { 'Idempotency-Key': key } : undefined,
      )
      const doneFlag = { finalize: 'finalized', pay: 'paid', void: 'voided' }[action]
      res.json({ [doneFlag]: true, invoice: invoiceDetail(inv) })
    } catch (e: any) {
      sendError(res, e)
    }
  }
}

// Finalize: locks the draft, assigns a number, mints hosted_invoice_url.
// auto_advance stays false — finalizing here never emails or auto-charges.
router.post('/:entity_id/invoices/:invoice_id/finalize', requireWrite, invoiceAction('finalize'))
// Pay: charges the customer's default payment method for the amount due, NOW.
router.post('/:entity_id/invoices/:invoice_id/pay', requireWrite, invoiceAction('pay'))
// Void: permanently cancels a finalized invoice. Not undoable.
router.post('/:entity_id/invoices/:invoice_id/void', requireWrite, invoiceAction('void'))

// Delete: drafts only. Read first and refuse with 409 when the invoice has
// been finalized — Stripe would refuse too, but with a generic parameter
// error, and the caller's next move (void) belongs in the message.
router.delete('/:entity_id/invoices/:invoice_id', requireWrite, async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const invoiceId = req.params.invoice_id
  if (!INVOICE_ID_RE.test(invoiceId)) {
    return res.status(400).json({ error: 'invoice_id must be a Stripe invoice id (in_...)' })
  }

  try {
    const inv = await stripeFetch(stripeKey, `/invoices/${invoiceId}`)
    const refusal = deleteRefusal(inv)
    if (refusal) return res.status(409).json({ error: refusal, status: inv.status })
    const gone = await stripeFetch(stripeKey, `/invoices/${invoiceId}`, undefined, 'DELETE')
    res.json({ deleted: Boolean(gone?.deleted), id: gone?.id ?? invoiceId })
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
