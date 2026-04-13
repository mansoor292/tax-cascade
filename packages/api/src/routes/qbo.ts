/**
 * QuickBooks Online routes — OAuth, reports, financial views
 *
 * OAuth flow:
 *   1. GET /api/qbo/connect/:entity_id — redirects to Intuit consent screen
 *   2. GET /api/qbo/callback — Intuit redirects back, we store tokens
 *   3. Tokens auto-refresh on each API call
 *
 * Data:
 *   GET /api/qbo/:entity_id/reports/:report — P&L, BalanceSheet, TrialBalance, GeneralLedger
 *   GET /api/qbo/:entity_id/financials — unified view for Claude
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

const QBO_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID || ''
const QBO_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET || ''
const QBO_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'production'
const QBO_BASE = QBO_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com'

async function getUser(req: Request): Promise<string | null> {
  if ((req as any).userId) return (req as any).userId
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token)
    return user?.id || null
  }
  return null
}

// ─── Token management ───

async function refreshTokens(connectionId: string, refreshToken: string): Promise<{
  access_token: string; refresh_token: string; expires_in: number
} | null> {
  const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!resp.ok) {
    console.error('QBO token refresh failed:', resp.status, await resp.text())
    return null
  }

  const data = await resp.json() as any
  const expiresAt = new Date(Date.now() + data.expires_in * 1000)

  // Persist new tokens
  await supabase.from('qbo_connection').update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    access_token_expires_at: expiresAt.toISOString(),
  }).eq('id', connectionId)

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }
}

async function getAccessToken(entityId: string): Promise<{
  token: string; realmId: string
} | null> {
  const { data: conn } = await supabase.from('qbo_connection')
    .select('*').eq('entity_id', entityId).eq('is_active', true).single()
  if (!conn) return null

  // Check if access token is still valid (with 5-min buffer)
  const expiresAt = new Date(conn.access_token_expires_at)
  if (expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
    return { token: conn.access_token, realmId: conn.realm_id }
  }

  // Refresh
  const refreshed = await refreshTokens(conn.id, conn.refresh_token)
  if (!refreshed) return null
  return { token: refreshed.access_token, realmId: conn.realm_id }
}

async function qboFetch(entityId: string, path: string, query?: Record<string, string>): Promise<any> {
  const auth = await getAccessToken(entityId)
  if (!auth) throw new Error('No active QBO connection for this entity')

  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const url = `${QBO_BASE}/v3/company/${auth.realmId}${path}${qs}`

  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json',
    },
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`QBO API ${resp.status}: ${text}`)
  }

  return resp.json()
}

const router = Router()

// ─── OAuth: Start connection ───
router.get('/connect/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  if (!QBO_CLIENT_ID) return res.status(500).json({ error: 'QUICKBOOKS_CLIENT_ID not configured' })

  // Verify entity belongs to user
  const { data: entity } = await supabase.from('tax_entity')
    .select('id').eq('id', req.params.entity_id).eq('user_id', userId).single()
  if (!entity) return res.status(404).json({ error: 'Entity not found' })

  // Build the redirect URI — callback comes back to this API
  const apiBase = `${req.protocol}://${req.get('host')}`
  const redirectUri = `${apiBase}/api/qbo/callback`

  // State encodes entity_id + user_id so callback can link them
  const state = Buffer.from(JSON.stringify({
    entity_id: req.params.entity_id,
    user_id: userId,
  })).toString('base64url')

  const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2')
  authUrl.searchParams.set('client_id', QBO_CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'com.intuit.quickbooks.accounting')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('state', state)

  res.json({ auth_url: authUrl.toString(), redirect_uri: redirectUri })
})

// ─── OAuth: Callback from Intuit ───
router.get('/callback', async (req, res) => {
  const { code, state, realmId, error: oauthError } = req.query as Record<string, string>

  if (oauthError) {
    return res.status(400).send(`<h2>QBO Connection Failed</h2><p>${oauthError}</p>`)
  }

  if (!code || !state || !realmId) {
    return res.status(400).send('<h2>Missing OAuth parameters</h2>')
  }

  // Decode state
  let stateData: { entity_id: string; user_id: string }
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString())
  } catch {
    return res.status(400).send('<h2>Invalid state parameter</h2>')
  }

  // Exchange code for tokens
  const apiBase = `${req.protocol}://${req.get('host')}`
  const redirectUri = `${apiBase}/api/qbo/callback`

  const tokenResp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenResp.ok) {
    const err = await tokenResp.text()
    console.error('QBO token exchange failed:', err)
    return res.status(500).send(`<h2>Token Exchange Failed</h2><pre>${err}</pre>`)
  }

  const tokens = await tokenResp.json() as any

  // Get company info
  let companyName = ''
  try {
    const base = QBO_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com'
    const infoResp = await fetch(`${base}/v3/company/${realmId}/companyinfo/${realmId}`, {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Accept': 'application/json',
      },
    })
    if (infoResp.ok) {
      const info = await infoResp.json() as any
      companyName = info.CompanyInfo?.CompanyName || ''
    }
  } catch {}

  // Upsert connection
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  const { error } = await supabase.from('qbo_connection').upsert({
    entity_id: stateData.entity_id,
    user_id: stateData.user_id,
    realm_id: realmId,
    company_name: companyName,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: expiresAt.toISOString(),
    connected_at: new Date().toISOString(),
    is_active: true,
  }, { onConflict: 'entity_id' })

  if (error) {
    console.error('Failed to save QBO connection:', error)
    return res.status(500).send(`<h2>Failed to Save Connection</h2><p>${error.message}</p>`)
  }

  res.send(`
    <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#f8faf8;">
      <h2 style="color:#2e8b57;">Connected to QuickBooks</h2>
      <p><strong>${companyName}</strong> (Realm ${realmId})</p>
      <p>You can close this window.</p>
    </body></html>
  `)
})

// ─── Connection status ───
router.get('/:entity_id/status', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data: conn } = await supabase.from('qbo_connection')
    .select('realm_id, company_name, connected_at, last_synced_at, is_active')
    .eq('entity_id', req.params.entity_id).single()

  if (!conn) return res.json({ connected: false })
  res.json({ connected: conn.is_active, ...conn })
})

// ─── Disconnect ───
router.delete('/:entity_id/disconnect', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  await supabase.from('qbo_connection').update({ is_active: false })
    .eq('entity_id', req.params.entity_id)

  res.json({ disconnected: true })
})

// ─── Reports ───
const REPORT_MAP: Record<string, string> = {
  'profit-and-loss': 'ProfitAndLoss',
  'balance-sheet': 'BalanceSheet',
  'trial-balance': 'TrialBalance',
  'general-ledger': 'GeneralLedger',
  'cash-flow': 'CashFlow',
}

router.get('/:entity_id/reports/:report', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const reportName = REPORT_MAP[req.params.report]
  if (!reportName) {
    return res.status(400).json({
      error: `Unknown report: ${req.params.report}`,
      available: Object.keys(REPORT_MAP),
    })
  }

  // Pass through query params as QBO report options
  const query: Record<string, string> = {}
  if (req.query.start_date) query.start_date = req.query.start_date as string
  if (req.query.end_date) query.end_date = req.query.end_date as string
  if (req.query.date_macro) query.date_macro = req.query.date_macro as string
  if (req.query.accounting_method) query.accounting_method = req.query.accounting_method as string
  if (req.query.summarize_column_by) query.summarize_column_by = req.query.summarize_column_by as string

  try {
    const data = await qboFetch(req.params.entity_id, `/reports/${reportName}`, query)

    // Update last_synced_at
    await supabase.from('qbo_connection').update({ last_synced_at: new Date().toISOString() })
      .eq('entity_id', req.params.entity_id)

    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Unified financial view for Claude ───
// Pulls P&L + Balance Sheet and flattens into a structured summary
router.get('/:entity_id/financials', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const year = req.query.year as string || new Date().getFullYear().toString()
  const startDate = `${year}-01-01`
  const endDate = `${year}-12-31`

  try {
    const [pnl, bs] = await Promise.all([
      qboFetch(req.params.entity_id, '/reports/ProfitAndLoss', {
        start_date: startDate, end_date: endDate, accounting_method: 'Accrual',
      }),
      qboFetch(req.params.entity_id, '/reports/BalanceSheet', {
        date: endDate, accounting_method: 'Accrual',
      }),
    ])

    // Flatten QBO report rows into key-value summaries
    const flattenReport = (report: any): Record<string, number> => {
      const result: Record<string, number> = {}
      const walk = (rows: any[], prefix = '') => {
        if (!rows) return
        for (const row of rows) {
          if (row.type === 'Section' && row.group) {
            const sectionName = row.group
            walk(row.Rows?.Row || [], prefix ? `${prefix} > ${sectionName}` : sectionName)
            if (row.Summary?.ColData) {
              const name = prefix ? `${prefix} > ${sectionName}` : sectionName
              const val = parseFloat(row.Summary.ColData[1]?.value || '0')
              if (!isNaN(val)) result[`${name} (Total)`] = val
            }
          } else if (row.type === 'Data' && row.ColData) {
            const name = row.ColData[0]?.value
            const val = parseFloat(row.ColData[1]?.value || '0')
            if (name && !isNaN(val)) {
              result[prefix ? `${prefix} > ${name}` : name] = val
            }
          }
          // Recurse into nested rows
          if (row.Rows?.Row) walk(row.Rows.Row, prefix)
        }
      }
      walk(report?.Rows?.Row || [])
      return result
    }

    const pnlFlat = flattenReport(pnl)
    const bsFlat = flattenReport(bs)

    // Extract key totals from headers
    const pnlHeader = pnl?.Header || {}
    const bsHeader = bs?.Header || {}

    await supabase.from('qbo_connection').update({ last_synced_at: new Date().toISOString() })
      .eq('entity_id', req.params.entity_id)

    res.json({
      entity_id: req.params.entity_id,
      year: parseInt(year),
      period: { start: startDate, end: endDate },
      profit_and_loss: {
        title: pnlHeader.ReportName,
        currency: pnlHeader.Currency || 'USD',
        items: pnlFlat,
      },
      balance_sheet: {
        title: bsHeader.ReportName,
        currency: bsHeader.Currency || 'USD',
        as_of: endDate,
        items: bsFlat,
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Query endpoint — run any QBO query ───
router.get('/:entity_id/query', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const q = req.query.q as string
  if (!q) return res.status(400).json({ error: 'q parameter required (e.g. "SELECT * FROM Account")' })

  try {
    const data = await qboFetch(req.params.entity_id, '/query', { query: q })
    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
