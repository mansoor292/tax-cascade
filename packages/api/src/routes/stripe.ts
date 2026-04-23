/**
 * Stripe routes — Connect API key, query invoices, payments, balance transactions
 *
 * Users provide their Stripe secret key (sk_live_... or sk_test_...).
 * The key is stored per-entity and used to make Stripe API calls.
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function getUser(req: Request): Promise<string | null> {
  if ((req as any).userId) return (req as any).userId
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token)
    return user?.id || null
  }
  return null
}

async function getStripeKey(entityId: string): Promise<string | null> {
  const { data } = await supabase.from('stripe_connection')
    .select('stripe_key_encrypted')
    .eq('entity_id', entityId).eq('is_active', true).single()
  return data?.stripe_key_encrypted || null
}

async function stripeFetch(
  stripeKey: string, path: string, params?: Record<string, string>,
): Promise<any> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  const resp = await fetch(`https://api.stripe.com/v1${path}${qs}`, {
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
    },
  })
  if (!resp.ok) {
    const err = await resp.json() as any
    throw new Error(err?.error?.message || `Stripe API ${resp.status}`)
  }
  return resp.json()
}

const router = Router()

// ─── Connect Stripe ───
router.post('/:entity_id/connect', async (req, res) => {
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
    stripe_key_encrypted: stripe_key,
    account_name: accountName,
    account_id: accountId,
    connected_at: new Date().toISOString(),
    is_active: true,
  }, { onConflict: 'entity_id' })

  if (error) return res.status(500).json({ error: error.message })

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
router.delete('/:entity_id/disconnect', async (req, res) => {
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

  const params: Record<string, string> = { limit: req.query.limit as string || '25' }
  if (req.query.status) params.status = req.query.status as string
  if (req.query.customer) params.customer = req.query.customer as string
  if (req.query.starting_after) params.starting_after = req.query.starting_after as string
  if (req.query.created_gte) params['created[gte]'] = req.query.created_gte as string
  if (req.query.created_lte) params['created[lte]'] = req.query.created_lte as string

  try {
    const data = await stripeFetch(stripeKey, '/invoices', params)
    await supabase.from('stripe_connection').update({ last_used_at: new Date().toISOString() })
      .eq('entity_id', req.params.entity_id)

    res.json({
      count: data.data?.length || 0,
      has_more: data.has_more,
      invoices: (data.data || []).map((inv: any) => ({
        id: inv.id,
        number: inv.number,
        customer_name: inv.customer_name,
        customer_email: inv.customer_email,
        status: inv.status,
        amount_due: inv.amount_due / 100,
        amount_paid: inv.amount_paid / 100,
        currency: inv.currency,
        created: new Date(inv.created * 1000).toISOString().split('T')[0],
        due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString().split('T')[0] : null,
        description: inv.description,
      })),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Payments (charges) ───
router.get('/:entity_id/payments', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = { limit: req.query.limit as string || '25' }
  if (req.query.starting_after) params.starting_after = req.query.starting_after as string
  if (req.query.created_gte) params['created[gte]'] = req.query.created_gte as string
  if (req.query.created_lte) params['created[lte]'] = req.query.created_lte as string

  try {
    const data = await stripeFetch(stripeKey, '/charges', params)
    res.json({
      count: data.data?.length || 0,
      has_more: data.has_more,
      payments: (data.data || []).map((ch: any) => ({
        id: ch.id,
        amount: ch.amount / 100,
        currency: ch.currency,
        status: ch.status,
        description: ch.description,
        customer: ch.billing_details?.name || ch.billing_details?.email,
        created: new Date(ch.created * 1000).toISOString().split('T')[0],
        receipt_url: ch.receipt_url,
      })),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Balance Transactions ───
router.get('/:entity_id/balance-transactions', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = { limit: req.query.limit as string || '25' }
  if (req.query.type) params.type = req.query.type as string
  if (req.query.starting_after) params.starting_after = req.query.starting_after as string
  if (req.query.created_gte) params['created[gte]'] = req.query.created_gte as string
  if (req.query.created_lte) params['created[lte]'] = req.query.created_lte as string

  try {
    const data = await stripeFetch(stripeKey, '/balance_transactions', params)
    res.json({
      count: data.data?.length || 0,
      has_more: data.has_more,
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
    res.status(500).json({ error: e.message })
  }
})

// ─── Payouts ───
router.get('/:entity_id/payouts', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = { limit: req.query.limit as string || '25' }
  if (req.query.starting_after) params.starting_after = req.query.starting_after as string

  try {
    const data = await stripeFetch(stripeKey, '/payouts', params)
    res.json({
      count: data.data?.length || 0,
      has_more: data.has_more,
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
    res.status(500).json({ error: e.message })
  }
})

// ─── Customers ───
router.get('/:entity_id/customers', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const stripeKey = await getStripeKey(req.params.entity_id)
  if (!stripeKey) return res.status(400).json({ error: 'No Stripe connection for this entity' })

  const params: Record<string, string> = { limit: req.query.limit as string || '25' }
  if (req.query.email) params.email = req.query.email as string
  if (req.query.starting_after) params.starting_after = req.query.starting_after as string

  try {
    const data = await stripeFetch(stripeKey, '/customers', params)
    res.json({
      count: data.data?.length || 0,
      has_more: data.has_more,
      customers: (data.data || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        created: new Date(c.created * 1000).toISOString().split('T')[0],
        balance: c.balance / 100,
        currency: c.currency,
      })),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
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
    let allTxns: any[] = []
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
    res.status(500).json({ error: e.message })
  }
})

export default router
