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

const API_BASE_URL = process.env.API_BASE_URL || 'https://tax-api.catalogshub.com'
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

// Cache of entity → accounting method so we don't hit QBO Preferences on every call
const accountingMethodCache: Record<string, string> = {}

async function getAccountingMethod(entityId: string): Promise<string> {
  if (accountingMethodCache[entityId]) return accountingMethodCache[entityId]
  try {
    const data = await qboFetch(entityId, '/query', { query: 'SELECT * FROM Preferences' })
    const prefs = data?.QueryResponse?.Preferences?.[0]
    const basis = prefs?.ReportPrefs?.ReportBasis || 'Accrual'
    accountingMethodCache[entityId] = basis
    return basis
  } catch {
    return 'Accrual'
  }
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

async function qboPost(entityId: string, path: string, body: any, query?: Record<string, string>): Promise<any> {
  const auth = await getAccessToken(entityId)
  if (!auth) throw new Error('No active QBO connection for this entity')

  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const url = `${QBO_BASE}/v3/company/${auth.realmId}${path}${qs}`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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

  // "new" = auto-create entity from QBO company info during callback
  if (req.params.entity_id !== 'new') {
    const { data: entity } = await supabase.from('tax_entity')
      .select('id').eq('id', req.params.entity_id).eq('user_id', userId).single()
    if (!entity) return res.status(404).json({ error: 'Entity not found' })
  }

  // Build the redirect URI — callback comes back to this API
  const redirectUri = `${API_BASE_URL}/api/qbo/callback`

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
  const redirectUri = `${API_BASE_URL}/api/qbo/callback`

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

  // Get company info from QBO
  let companyInfo: any = {}
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
      companyInfo = info.CompanyInfo || {}
    }
  } catch {}

  const companyName = companyInfo.CompanyName || ''
  const companyEin = companyInfo.EIN || ''
  const companyAddr = companyInfo.CompanyAddr || {}

  // If no entity_id was provided, auto-create the entity from QBO company info
  let entityId = stateData.entity_id
  if (!entityId || entityId === 'new') {
    // Check if entity already exists for this user with matching name or EIN
    let existing = null
    if (companyEin) {
      const { data } = await supabase.from('tax_entity')
        .select('id').eq('user_id', stateData.user_id).eq('ein', companyEin).single()
      existing = data
    }
    if (!existing && companyName) {
      const { data } = await supabase.from('tax_entity')
        .select('id').eq('user_id', stateData.user_id).ilike('name', companyName).single()
      existing = data
    }

    if (existing) {
      entityId = existing.id
    } else {
      // Create new entity from QBO data
      const { data: newEntity, error: createErr } = await supabase.from('tax_entity').insert({
        user_id: stateData.user_id,
        name: companyName,
        ein: companyEin || null,
        entity_type: companyInfo.CompanyType === 'SoleProprietor' ? 'individual'
          : companyInfo.LegalName?.includes('LLC') ? 'llc' : 'c_corp',
        form_type: companyInfo.CompanyType === 'SoleProprietor' ? '1040' : '1120',
        address: [companyAddr.Line1, companyAddr.Line2].filter(Boolean).join(' ') || null,
        city: companyAddr.City || null,
        state: companyAddr.CountrySubDivisionCode || null,
        zip: companyAddr.PostalCode || null,
        fiscal_year_end: '12/31',
        meta: {
          qbo_realm_id: realmId,
          qbo_company_type: companyInfo.CompanyType,
        },
      }).select().single()

      if (createErr) {
        console.error('Failed to create entity:', createErr)
        return res.status(500).send(`<h2>Failed to Create Entity</h2><p>${createErr.message}</p>`)
      }
      entityId = newEntity.id
    }
  }

  // Upsert connection
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  const { error } = await supabase.from('qbo_connection').upsert({
    entity_id: entityId,
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

  const appUrl = process.env.APP_URL || 'https://tax-api.catalogshub.com'
  res.send(`
    <html><head>
      <meta http-equiv="refresh" content="3;url=${appUrl}">
    </head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#f8faf8;">
      <h2 style="color:#2e8b57;">Connected to QuickBooks</h2>
      <p><strong>${companyName}</strong> (Realm ${realmId})</p>
      ${companyEin ? `<p>EIN: ${companyEin}</p>` : ''}
      <p style="color:#999;font-size:0.9rem;">Redirecting to app...</p>
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

// ─── Report helpers ───

const REPORT_MAP: Record<string, string> = {
  'profit-and-loss': 'ProfitAndLoss',
  'profit-and-loss-detail': 'ProfitAndLossDetail',
  'balance-sheet': 'BalanceSheet',
  'balance-sheet-detail': 'BalanceSheetDetail',
  'trial-balance': 'TrialBalance',
  'general-ledger': 'GeneralLedger',
  'cash-flow': 'CashFlow',
  'transaction-list': 'TransactionList',
  'accounts-receivable': 'AgedReceivableDetail',
  'accounts-payable': 'AgedPayableDetail',
  'vendor-balance': 'VendorBalanceDetail',
  'customer-balance': 'CustomerBalanceDetail',
}

function flattenReport(report: any): Record<string, number> {
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
      if (row.Rows?.Row) walk(row.Rows.Row, prefix)
    }
  }
  walk(report?.Rows?.Row || [])
  return result
}

/** Fetch a report from QBO, store in DB, return both raw and summary. */
async function fetchAndStoreReport(
  entityId: string,
  reportType: string,
  qboReportName: string,
  periodStart: string,
  periodEnd: string,
  accountingMethod: string,
  extraQuery?: Record<string, string>,
): Promise<{ raw: any; summary: Record<string, number>; fetched_at: string }> {
  const query: Record<string, string> = { accounting_method: accountingMethod, ...extraQuery }
  // BalanceSheet is point-in-time — QBO treats end_date as the "as of" date.
  // We also pass start_date (same year) because QBO otherwise defaults to
  // DateMacro=this-calendar-year-to-date, which ignores our end_date entirely.
  query.start_date = periodStart
  query.end_date = periodEnd

  const raw = await qboFetch(entityId, `/reports/${qboReportName}`, query)
  const summary = flattenReport(raw)
  const now = new Date().toISOString()

  await supabase.from('qbo_report').upsert({
    entity_id: entityId,
    report_type: reportType,
    period_start: periodStart,
    period_end: periodEnd,
    accounting_method: accountingMethod,
    raw_data: raw,
    summary,
    fetched_at: now,
  }, { onConflict: 'entity_id,report_type,period_start,period_end,accounting_method' })

  await supabase.from('qbo_connection').update({ last_synced_at: now })
    .eq('entity_id', entityId)

  return { raw, summary, fetched_at: now }
}

// ─── Reports (cached in DB, refresh on demand) ───

router.get('/:entity_id/reports/:report', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const reportType = req.params.report
  const qboReportName = REPORT_MAP[reportType]
  if (!qboReportName) {
    return res.status(400).json({
      error: `Unknown report: ${reportType}`,
      available: Object.keys(REPORT_MAP),
    })
  }

  const refresh = req.query.refresh === 'true'
  const year = (req.query.year as string) || new Date().getFullYear().toString()
  const startDate = (req.query.start_date as string) || `${year}-01-01`
  const endDate = (req.query.end_date as string) || `${year}-12-31`
  const accountingMethod = (req.query.accounting_method as string) || await getAccountingMethod(req.params.entity_id)

  // Check DB cache first — invalidate after 1 day so data stays fresh during filing
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 1 day
  if (!refresh) {
    const { data: cached } = await supabase.from('qbo_report')
      .select('*')
      .eq('entity_id', req.params.entity_id)
      .eq('report_type', reportType)
      .eq('period_start', startDate)
      .eq('period_end', endDate)
      .eq('accounting_method', accountingMethod)
      .single()

    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime()
      if (ageMs < CACHE_TTL_MS) {
        return res.json({ ...cached, source: 'cache', cache_age_hours: Math.round(ageMs / 3600000) })
      }
      // Stale — fall through to fetch
    }
  }

  // Fetch from QBO
  try {
    const extraQuery: Record<string, string> = {}
    // Passthrough to QBO Reports API — only the ones we actively support.
    // TransactionList supports: cleared_status (All/Cleared/Uncleared/Deposited/Reconciled),
    // accounts (plural, comma-separated IDs), columns, name, transaction_type.
    const PASSTHROUGH = ['summarize_column_by', 'cleared_status', 'accounts', 'columns', 'name', 'transaction_type', 'account']
    for (const key of PASSTHROUGH) {
      const v = req.query[key]
      if (typeof v === 'string' && v) extraQuery[key] = v
    }

    const result = await fetchAndStoreReport(
      req.params.entity_id, reportType, qboReportName,
      startDate, endDate, accountingMethod, extraQuery,
    )

    res.json({
      entity_id: req.params.entity_id,
      report_type: reportType,
      period_start: startDate,
      period_end: endDate,
      accounting_method: accountingMethod,
      raw_data: result.raw,
      summary: result.summary,
      fetched_at: result.fetched_at,
      source: 'qbo',
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── List cached reports for an entity ───
router.get('/:entity_id/reports', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data, error } = await supabase.from('qbo_report')
    .select('id, report_type, period_start, period_end, accounting_method, fetched_at')
    .eq('entity_id', req.params.entity_id)
    .order('fetched_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ reports: data || [] })
})

// ─── Unified financial view (cached, refresh on demand) ───
router.get('/:entity_id/financials', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const refresh = req.query.refresh === 'true'
  const year = (req.query.year as string) || new Date().getFullYear().toString()
  const startDate = `${year}-01-01`
  const endDate = `${year}-12-31`

  // Try cache first for both reports
  let pnlData: { summary: Record<string, number>; raw: any; fetched_at: string } | null = null
  let bsData: { summary: Record<string, number>; raw: any; fetched_at: string } | null = null
  let source = 'cache'

  if (!refresh) {
    const [{ data: pnlCached }, { data: bsCached }] = await Promise.all([
      supabase.from('qbo_report')
        .select('*')
        .eq('entity_id', req.params.entity_id)
        .eq('report_type', 'profit-and-loss')
        .eq('period_start', startDate)
        .eq('period_end', endDate)
        .single(),
      supabase.from('qbo_report')
        .select('*')
        .eq('entity_id', req.params.entity_id)
        .eq('report_type', 'balance-sheet')
        .eq('period_start', startDate)
        .eq('period_end', endDate)
        .single(),
    ])

    // Respect 1-day TTL — older cache entries are treated as missing so we re-fetch
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000
    const fresh = (row: any) => row && (Date.now() - new Date(row.fetched_at).getTime()) < CACHE_TTL_MS
    if (fresh(pnlCached)) pnlData = { summary: pnlCached.summary, raw: pnlCached.raw_data, fetched_at: pnlCached.fetched_at }
    if (fresh(bsCached))  bsData  = { summary: bsCached.summary,  raw: bsCached.raw_data,  fetched_at: bsCached.fetched_at }
  }

  // Use entity's preferred accounting method
  const acctMethod = await getAccountingMethod(req.params.entity_id)

  // Fetch missing reports from QBO
  try {
    if (!pnlData) {
      pnlData = await fetchAndStoreReport(
        req.params.entity_id, 'profit-and-loss', 'ProfitAndLoss',
        startDate, endDate, acctMethod,
      )
      source = 'qbo'
    }
    if (!bsData) {
      bsData = await fetchAndStoreReport(
        req.params.entity_id, 'balance-sheet', 'BalanceSheet',
        startDate, endDate, acctMethod,
      )
      source = 'qbo'
    }

    const pnlHeader = pnlData.raw?.Header || {}
    const bsHeader = bsData.raw?.Header || {}

    res.json({
      entity_id: req.params.entity_id,
      year: parseInt(year),
      period: { start: startDate, end: endDate },
      accounting_method: acctMethod,
      source,
      profit_and_loss: {
        title: pnlHeader.ReportName || 'Profit and Loss',
        currency: pnlHeader.Currency || 'USD',
        items: pnlData.summary,
        fetched_at: pnlData.fetched_at,
      },
      balance_sheet: {
        title: bsHeader.ReportName || 'Balance Sheet',
        currency: bsHeader.Currency || 'USD',
        as_of: endDate,
        items: bsData.summary,
        fetched_at: bsData.fetched_at,
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── QBO → tax inputs packet (inspection + override) ───
// Exposes the buildCorporateInputsFromQbo mapping as a standalone endpoint
// so the caller can inspect per-field classifications and confidence
// before invoking compute_return. Intended usage:
//   GET  /api/qbo-to-tax-inputs/:entity_id?tax_year=YYYY&form_type=1120S
//   → { inputs, audit, warnings, sources: {pnl_as_of, bs_as_of, business_code} }
// Caller edits inputs in place, passes back via /api/returns/compute.
router.get('/:entity_id/qbo-to-tax-inputs', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const entityId = req.params.entity_id
  const taxYear = parseInt(req.query.tax_year as string, 10)
  const formType = (req.query.form_type as string) || '1120S'
  if (!taxYear || isNaN(taxYear)) {
    return res.status(400).json({ error: 'tax_year (numeric) required' })
  }
  if (formType !== '1120' && formType !== '1120S') {
    return res.status(400).json({ error: 'form_type must be 1120 or 1120S' })
  }

  try {
    // Pull current + prior year financials in parallel, plus entity meta.
    const base = `${req.protocol}://${req.get('host')}`
    const hdrs = {
      'Authorization': req.headers.authorization || '',
      'x-api-key': (req.headers['x-api-key'] as string) || '',
    }
    const [finResp, priorFinResp, entityRow] = await Promise.all([
      fetch(`${base}/api/qbo/${entityId}/financials?year=${taxYear}`, { headers: hdrs })
        .then(r => r.json()).catch(() => null),
      fetch(`${base}/api/qbo/${entityId}/financials?year=${taxYear - 1}`, { headers: hdrs })
        .then(r => r.json()).catch(() => null),
      (async () => {
        try {
          const r = await supabase.from('tax_entity').select('meta').eq('id', entityId).eq('user_id', userId).single()
          return r.data
        } catch { return null }
      })(),
    ])

    const pnl = finResp?.profit_and_loss?.items
    const bs = finResp?.balance_sheet?.items
    const priorBs = priorFinResp?.balance_sheet?.items
    if (!pnl) {
      return res.status(404).json({
        error: 'QBO P&L not available — entity may not be connected or no data for this year',
        hint: 'Run /api/qbo/:entity_id/status to check connection.',
      })
    }

    const { buildCorporateInputsFromQbo } = await import('../maps/qbo_to_inputs.js')
    const packet = buildCorporateInputsFromQbo({
      pnl, bs, priorBs,
      form_type: formType as '1120' | '1120S',
      business_code: entityRow?.meta?.business_code,
    })

    res.json({
      entity_id: entityId,
      tax_year: taxYear,
      form_type: formType,
      inputs: packet.inputs,
      audit: packet.audit,
      warnings: packet.warnings,
      sources: {
        pnl_as_of: finResp?.profit_and_loss?.fetched_at || null,
        bs_as_of: finResp?.balance_sheet?.fetched_at || null,
        prior_bs_as_of: priorFinResp?.balance_sheet?.fetched_at || null,
        business_code: entityRow?.meta?.business_code || null,
      },
      note: 'Inspect audit entries to see per-field provenance + confidence. Edit inputs in place and pass the entire packet to POST /api/returns/compute as `inputs` (the extra audit/warnings/sources keys are ignored by compute).',
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Chart of Accounts ───
router.get('/:entity_id/accounts', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const data = await qboFetch(req.params.entity_id, '/query', {
      query: 'SELECT * FROM Account ORDERBY Name MAXRESULTS 500',
    })
    const accounts = data?.QueryResponse?.Account || []
    res.json({
      count: accounts.length,
      accounts: accounts.map((a: any) => ({
        id: a.Id,
        name: a.Name,
        full_name: a.FullyQualifiedName,
        type: a.AccountType,
        sub_type: a.AccountSubType,
        balance: a.CurrentBalance,
        active: a.Active,
      })),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Transactions for an account ───
router.get('/:entity_id/transactions', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { account, start_date, end_date, type, limit: maxResults } = req.query as Record<string, string>
  const year = req.query.year as string

  // Build the TransactionList report query
  const query: Record<string, string> = {}
  if (year) {
    query.start_date = `${year}-01-01`
    query.end_date = `${year}-12-31`
  }
  if (start_date) query.start_date = start_date
  if (end_date) query.end_date = end_date
  if (account) query.account = account
  if (type) query.transaction_type = type

  try {
    const data = await qboFetch(req.params.entity_id, '/reports/TransactionList', query)

    // Flatten the report rows into a transaction list
    const transactions: any[] = []
    const rows = data?.Rows?.Row || []
    for (const row of rows) {
      if (row.type === 'Data' && row.ColData) {
        const cols = row.ColData
        transactions.push({
          date: cols[0]?.value,
          type: cols[1]?.value,
          num: cols[2]?.value,
          name: cols[3]?.value,
          memo: cols[4]?.value,
          account: cols[5]?.value,
          amount: parseFloat(cols[6]?.value || '0') || 0,
        })
      }
    }

    // Store in qbo_report cache
    const periodStart = query.start_date || `${year || new Date().getFullYear()}-01-01`
    const periodEnd = query.end_date || `${year || new Date().getFullYear()}-12-31`
    await supabase.from('qbo_report').upsert({
      entity_id: req.params.entity_id,
      report_type: `transactions${account ? `-${account}` : ''}`,
      period_start: periodStart,
      period_end: periodEnd,
      accounting_method: await getAccountingMethod(req.params.entity_id),
      raw_data: data,
      summary: { count: transactions.length, total: transactions.reduce((s, t) => s + t.amount, 0) },
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'entity_id,report_type,period_start,period_end,accounting_method' })

    res.json({
      count: transactions.length,
      period: { start: periodStart, end: periodEnd },
      account_filter: account || 'all',
      transactions,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Generic CRUD for any QBO resource ───
const QBO_RESOURCES = [
  'Account', 'Bill', 'BillPayment', 'Budget', 'Class', 'CreditMemo',
  'Customer', 'Department', 'Deposit', 'Employee', 'Estimate',
  'Invoice', 'Item', 'JournalEntry', 'Payment', 'PaymentMethod',
  'Purchase', 'PurchaseOrder', 'RefundReceipt', 'SalesReceipt',
  'TaxCode', 'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit',
]

// Read: GET /api/qbo/:entity_id/resource/:resource/:id
router.get('/:entity_id/resource/:resource/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const resource = req.params.resource.toLowerCase()
  const matched = QBO_RESOURCES.find(r => r.toLowerCase() === resource)
  if (!matched) return res.status(400).json({ error: `Unknown resource: ${resource}`, available: QBO_RESOURCES })

  try {
    const data = await qboFetch(req.params.entity_id, `/${resource}/${req.params.id}`)
    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Search: GET /api/qbo/:entity_id/resource/:resource?where=...&orderby=...&limit=...
router.get('/:entity_id/resource/:resource', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const resource = req.params.resource.toLowerCase()
  const matched = QBO_RESOURCES.find(r => r.toLowerCase() === resource)
  if (!matched) return res.status(400).json({ error: `Unknown resource: ${resource}`, available: QBO_RESOURCES })

  const where = req.query.where as string || ''
  const orderby = req.query.orderby as string || ''
  const limit = req.query.limit as string || '100'

  let sql = `SELECT * FROM ${matched}`
  if (where) sql += ` WHERE ${where}`
  if (orderby) sql += ` ORDERBY ${orderby}`
  sql += ` MAXRESULTS ${limit}`

  try {
    const data = await qboFetch(req.params.entity_id, '/query', { query: sql })
    const items = data?.QueryResponse?.[matched] || []
    res.json({ count: items.length, resource: matched, items })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Create: POST /api/qbo/:entity_id/resource/:resource
router.post('/:entity_id/resource/:resource', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const resource = req.params.resource.toLowerCase()
  const matched = QBO_RESOURCES.find(r => r.toLowerCase() === resource)
  if (!matched) return res.status(400).json({ error: `Unknown resource: ${resource}`, available: QBO_RESOURCES })

  try {
    const data = await qboPost(req.params.entity_id, `/${resource}`, req.body)
    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Update: PUT /api/qbo/:entity_id/resource/:resource
router.put('/:entity_id/resource/:resource', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const resource = req.params.resource.toLowerCase()
  const matched = QBO_RESOURCES.find(r => r.toLowerCase() === resource)
  if (!matched) return res.status(400).json({ error: `Unknown resource: ${resource}`, available: QBO_RESOURCES })

  try {
    const data = await qboPost(req.params.entity_id, `/${resource}`, req.body, { operation: 'update' })
    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Batch post: POST /api/qbo/:entity_id/transactions_batch
// Body: { transactions: [{ type: 'JournalEntry'|'Purchase'|..., data: {...} }],
//         rollback_on_error?: boolean }
// Serial posts each transaction through qboPost. QBO v3 has no native
// batch API for arbitrary entities so we loop. With rollback_on_error,
// any successful posts prior to the first failure are voided / deleted
// via /<resource>?operation=delete (best-effort) so partial state is
// reversed. Reversals are tagged PrivateNote:'auto-reversed on batch error'
// for auditability.
router.post('/:entity_id/transactions_batch', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const transactions: Array<{ type: string; data: any }> = req.body?.transactions
  const rollbackOnError: boolean = !!req.body?.rollback_on_error
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'transactions[] (non-empty array) required' })
  }

  const results: Array<{
    index: number
    type: string
    ok: boolean
    id?: string
    doc_number?: string
    error?: string
    rolled_back?: boolean
  }> = []
  const toRollback: Array<{ type: string; id: string; syncToken: string; index: number }> = []

  for (let i = 0; i < transactions.length; i++) {
    const { type, data } = transactions[i]
    const matchedType = QBO_RESOURCES.find(r => r.toLowerCase() === (type || '').toLowerCase())
    if (!matchedType) {
      results.push({ index: i, type, ok: false, error: `Unknown resource type: ${type}` })
      if (rollbackOnError) break
      continue
    }
    try {
      const resp = await qboPost(req.params.entity_id, `/${matchedType.toLowerCase()}`, data)
      const created = resp?.[matchedType] || resp
      const id = created?.Id
      const syncToken = created?.SyncToken
      results.push({ index: i, type: matchedType, ok: true, id, doc_number: created?.DocNumber })
      if (id && syncToken !== undefined) {
        toRollback.push({ type: matchedType, id, syncToken, index: i })
      }
    } catch (e: any) {
      results.push({ index: i, type: matchedType, ok: false, error: e.message })
      if (rollbackOnError) break
    }
  }

  // If we hit a failure and rollback is on, void everything we created so far
  let rollback_summary: { attempted: number; succeeded: number; failed: number } | null = null
  const anyFailed = results.some(r => !r.ok)
  if (rollbackOnError && anyFailed && toRollback.length > 0) {
    let succeeded = 0, failed = 0
    for (const tx of toRollback) {
      try {
        // Try delete first (most resources support operation=delete)
        await qboPost(req.params.entity_id, `/${tx.type.toLowerCase()}?operation=delete`, {
          Id: tx.id,
          SyncToken: tx.syncToken,
          PrivateNote: 'auto-reversed on batch error',
        })
        succeeded++
        const r = results[tx.index]
        if (r) r.rolled_back = true
      } catch {
        // Fall back to void for JournalEntry / Invoice / etc.
        try {
          await qboPost(req.params.entity_id, `/${tx.type.toLowerCase()}?operation=void`, {
            Id: tx.id,
            SyncToken: tx.syncToken,
            PrivateNote: 'auto-voided on batch error',
          })
          succeeded++
          const r = results[tx.index]
          if (r) r.rolled_back = true
        } catch {
          failed++
        }
      }
    }
    rollback_summary = { attempted: toRollback.length, succeeded, failed }
  }

  const status = anyFailed ? 207 : 200  // 207 Multi-Status when partial
  res.status(status).json({
    total: transactions.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
    rollback_on_error: rollbackOnError,
    rollback_summary,
  })
})

// Delete: DELETE /api/qbo/:entity_id/resource/:resource
router.delete('/:entity_id/resource/:resource', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const resource = req.params.resource.toLowerCase()
  const matched = QBO_RESOURCES.find(r => r.toLowerCase() === resource)
  if (!matched) return res.status(400).json({ error: `Unknown resource: ${resource}`, available: QBO_RESOURCES })

  try {
    const data = await qboPost(req.params.entity_id, `/${resource}?operation=delete`, req.body)
    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Recategorize transactions out of Uncategorized / Ask-My-Accountant ───
// QBO's API doesn't expose the bank-feed "match" workflow, so the common
// pattern is: bulk-post bank txns to Uncategorized (fast, no decisions),
// then run this endpoint to move each into its proper account based on
// the chart of accounts + Gemini classification.
//
// POST /api/qbo/:entity_id/recategorize
// Body:
//   source_account_ids?: string[]   // defaults to Active accounts whose
//                                    // name/full_name starts with "Uncategorized"
//                                    // or "Ask My Accountant"
//   start_date?, end_date?           // date window (defaults: all time)
//   min_confidence?: number          // default 0.80 (for apply path only)
//   dry_run?: boolean                // default true — classify but don't update
//
// Response:
//   { queried_from_accounts, total, classified, auto_applied, review_queue,
//     suggestions: [{txn_id, txn_type, date, amount, description, from,
//                    suggested_to, confidence, reasoning}] }
router.post('/:entity_id/recategorize', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const {
    source_account_ids: srcIds,
    start_date,
    end_date,
    min_confidence = 0.80,
    dry_run = true,
  } = req.body || {}

  const entityId = req.params.entity_id

  try {
    // ── 1. Fetch COA ──
    const coaResp = await qboFetch(entityId, '/query', {
      query: 'SELECT Id, Name, FullyQualifiedName, AccountType, AccountSubType FROM Account WHERE Active=true ORDERBY Name MAXRESULTS 500',
    })
    const accounts = (coaResp?.QueryResponse?.Account || []).map((a: any) => ({
      id: a.Id,
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      sub_type: a.AccountSubType,
    }))
    const validIds = new Set(accounts.map((a: any) => a.id))

    // ── 2. Resolve source accounts ──
    let sourceAccounts: string[] = Array.isArray(srcIds) && srcIds.length > 0 ? srcIds : []
    if (sourceAccounts.length === 0) {
      for (const a of accounts) {
        const n = (a.name || '').toLowerCase()
        if (n.startsWith('uncategorized') || n.startsWith('ask my account')) {
          sourceAccounts.push(a.id)
        }
      }
    }
    if (sourceAccounts.length === 0) {
      return res.status(404).json({ error: 'no Uncategorized / Ask-My-Accountant accounts found for this entity' })
    }

    // ── 3. Pull transactions in source accounts via GeneralLedger sections ──
    // QBO's TransactionList `accounts` filter is unreliable across minorversions.
    // The GeneralLedger report has per-account sections we can walk — more
    // robust. Pulls the full year by default since GL already groups txns.
    type Row = { txn_id: string; txn_type: string; date: string; name: string; memo: string; amount: number; account_from: string }
    const rows: Row[] = []
    const startQ = start_date || '2020-01-01'
    const endQ = end_date || new Date().toISOString().slice(0, 10)
    const sourceNameSet = new Set(sourceAccounts.map(id => (accounts.find((a: any) => a.id === id)?.name || '')).filter(Boolean))
    const gl = await qboFetch(entityId, '/reports/GeneralLedger', {
      start_date: startQ, end_date: endQ, minorversion: '65',
    })
    const walkGl = (sections: any[]) => {
      for (const sec of sections) {
        if (sec.type === 'Section') {
          const hdrCells = sec.Header?.ColData || []
          const secName = hdrCells[0]?.value || ''
          const isTargetSection = sourceNameSet.has(secName)
            || Array.from(sourceNameSet).some(n => n && secName.includes(n))
          if (isTargetSection) {
            const rowsIn = sec.Rows?.Row || []
            for (const r of rowsIn) {
              if (r.type === 'Section') continue
              const cd = r.ColData || []
              // GL columns: Date | Type | Num | Name | Memo/Description | Split | Amount | Balance
              const date = cd[0]?.value
              const ttype = cd[1]?.value
              const id = cd[1]?.id || ''
              const name = cd[3]?.value || ''
              const memo = cd[4]?.value || ''
              const amountStr = cd[6]?.value
              const amount = parseFloat(String(amountStr || '0').replace(/[,$]/g, ''))
              if (id && date && !isNaN(amount) && amount !== 0) {
                rows.push({ txn_id: id, txn_type: ttype || 'Unknown', date, name, memo, amount, account_from: secName })
              }
            }
          }
          walkGl(sec.Rows?.Row || [])
        }
      }
    }
    walkGl(gl?.Rows?.Row || [])

    if (rows.length === 0) {
      return res.json({
        queried_from_accounts: sourceAccounts.map(id => ({ id, name: accounts.find((a: any) => a.id === id)?.name })),
        total: 0,
        classified: 0,
        dry_run,
        note: 'No transactions found in the specified source accounts for the given date range.',
      })
    }

    // ── 4. Classify via Gemini ──
    const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
    if (!GEMINI_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY not configured on the server',
        rows_found: rows.length,
      })
    }

    // Batch rows for the prompt. Gemini Flash Lite handles ~200 rows comfortably in one call.
    // For bigger batches, chunk into passes of 150.
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    const genAI = new GoogleGenerativeAI(GEMINI_KEY)
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })

    // Build COA prompt once
    const coaList = accounts.map((a: any) =>
      `  ${a.id}: ${a.name} [${a.type}/${a.sub_type}]`
    ).join('\n')

    const CHUNK = 150
    const allSuggestions: Array<any> = []
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK)
      const rowsList = batch.map((r, idx) => {
        const desc = `${r.name}${r.memo ? ' | ' + r.memo : ''}`.replace(/"/g, '\\"').slice(0, 180)
        return `  ${idx}: date=${r.date} amount=${r.amount} txn_type=${r.txn_type} "${desc}"`
      }).join('\n')

      const prompt = `You are recategorizing QBO transactions that are currently sitting in an Uncategorized account. For each row, pick the best destination account from the chart of accounts below. These are real posted transactions that need to move into their proper category.

Chart of accounts (ID: name [type/subtype]):
${coaList}

Transactions to recategorize:
${rowsList}

For each row, return a JSON object with:
  row_index: integer (0-indexed within this batch)
  account_id: string (MUST be one of the IDs above — picks the destination account)
  confidence: number 0..1
  reasoning: short string (one sentence)

Rules:
- Pick the MOST SPECIFIC matching account in the chart (e.g. "Software & apps" over generic "Other Expense" when the description is "Dropbox").
- Avoid picking the source account back (don't suggest "Uncategorized" as the destination).
- Confidence: 0.9+ for clear merchant patterns (Dropbox, Facebook Ads, Gusto); 0.7-0.9 for probable; 0.5-0.7 for guesses; <0.5 for "no idea" (in that case pick an "Ask My Accountant" / unresolved account if available, else a generic bucket).
- Negative amount = credit/refund. Treat accordingly (e.g. "Adobe refund" at -89.99 → same account as the original Adobe charge).
- Loan payments (PETERLoan, etc.) → loan liability + interest split; suggest the PRIMARY loan balance account here, flag reasoning so caller can make it a JE later.
- Personal-looking charges (zoo, golf, pharmacy) → "Personal Expense" / "Owner's Draw" / "Partner distributions" if present, with confidence ≤ 0.7.

Return ONLY a JSON array, no prose, no markdown fences.`

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      })
      const text = result.response.text()
      let parsed: any[] = []
      try { parsed = JSON.parse(text) } catch { parsed = [] }

      for (const entry of parsed) {
        const idx = Number(entry?.row_index)
        if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue
        const row = batch[idx]
        const suggestedId = String(entry?.account_id || '')
        const valid = validIds.has(suggestedId)
        const destName = valid ? accounts.find((a: any) => a.id === suggestedId)?.name : null
        const conf = Number(entry?.confidence) || 0
        allSuggestions.push({
          txn_id: row.txn_id,
          txn_type: row.txn_type,
          date: row.date,
          amount: row.amount,
          description: `${row.name}${row.memo ? ' | ' + row.memo : ''}`.slice(0, 160),
          from: row.account_from,
          suggested_to: destName,
          suggested_to_id: suggestedId,
          suggested_to_valid: valid,
          confidence: conf,
          reasoning: String(entry?.reasoning || ''),
          would_apply: valid && conf >= min_confidence,
        })
      }
    }

    // ── 5. Apply path (non-dry-run) ──
    // Not implemented yet — return dry-run result only. Future: fetch each
    // transaction via /<resource>/<id>, modify Line[0].*LineDetail.AccountRef,
    // PUT back via /<resource>?operation=update with SyncToken.
    const auto_applied = dry_run ? 0 : 0  // placeholder
    const review_queue = allSuggestions.filter(s => !s.would_apply).length

    res.json({
      entity_id: entityId,
      dry_run,
      queried_from_accounts: sourceAccounts.map(id => ({ id, name: accounts.find((a: any) => a.id === id)?.name })),
      date_range: { start: startQ, end: endQ },
      min_confidence,
      total: rows.length,
      classified: allSuggestions.length,
      auto_applied,
      review_queue,
      suggestions: allSuggestions,
      note: dry_run
        ? 'Dry-run — no QBO updates applied. Review `suggestions[]` and re-call with dry_run:false to apply (apply path pending implementation).'
        : 'Apply path not yet implemented — this dry-run result is returned as-is.',
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Apply recategorizations (AI-curated batch) ───
// Takes an array of decisions — typically the output of dry-run
// recategorize with edits/filters applied by the caller — and loops
// them into QBO. For each entry: GET the transaction, find the line
// currently hitting an Uncategorized/Ask-My-Accountant account, swap
// its AccountRef to the new account, PUT back with SyncToken.
//
// POST /api/qbo/:entity_id/recategorize/apply
// Body: {
//   entries: [
//     { txn_id, txn_type, new_account_id, memo?: string },
//     ...
//   ],
//   confirm: true   // safety: server refuses without it
// }
router.post('/:entity_id/recategorize/apply', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { entries, confirm } = req.body || {}
  if (confirm !== true) {
    return res.status(400).json({
      error: 'CONFIRM_REQUIRED',
      message: 'Pass confirm:true in the body to acknowledge you intend to modify QBO transactions. This endpoint is destructive-by-design.',
    })
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries[] (non-empty array) required' })
  }

  const entityId = req.params.entity_id

  try {
    // Pull COA so we can identify Uncategorized accounts and validate new_account_ids
    const coaResp = await qboFetch(entityId, '/query', {
      query: 'SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE Active=true MAXRESULTS 500',
    })
    const allAccounts: any[] = coaResp?.QueryResponse?.Account || []
    const validAcctIds = new Set(allAccounts.map((a: any) => a.Id))
    const uncategorizedIds = new Set(
      allAccounts
        .filter((a: any) => {
          const n = (a.FullyQualifiedName || a.Name || '').toLowerCase()
          return n.startsWith('uncategorized') || n.startsWith('ask my account')
        })
        .map((a: any) => a.Id),
    )

    // Map TransactionList txn_type → QBO resource path
    const typeMap: Record<string, string> = {
      'Expense': 'purchase',
      'Check': 'purchase',
      'Credit Card Expense': 'purchase',
      'Credit Card Credit': 'purchase',
      'Cash Expense': 'purchase',
      'Deposit': 'deposit',
      'Journal Entry': 'journalentry',
      'Bill': 'bill',
      'Bill Payment': 'billpayment',
      'Transfer': 'transfer',
      'Credit Memo': 'creditmemo',
      'Sales Receipt': 'salesreceipt',
      'Payment': 'payment',
    }

    type EntryResult = {
      txn_id: string
      txn_type: string
      new_account_id: string
      ok: boolean
      old_account_id?: string
      old_account_name?: string
      new_account_name?: string
      error?: string
    }
    const results: EntryResult[] = []

    for (const entry of entries) {
      const out: EntryResult = {
        txn_id: String(entry?.txn_id || ''),
        txn_type: String(entry?.txn_type || ''),
        new_account_id: String(entry?.new_account_id || ''),
        ok: false,
      }
      try {
        if (!out.txn_id || !out.txn_type || !out.new_account_id) {
          out.error = 'Missing required field (txn_id / txn_type / new_account_id)'
          results.push(out); continue
        }
        if (!validAcctIds.has(out.new_account_id)) {
          out.error = `new_account_id ${out.new_account_id} is not a valid active account in this entity's COA`
          results.push(out); continue
        }
        const resource = typeMap[out.txn_type]
        if (!resource) {
          out.error = `Unsupported txn_type "${out.txn_type}" — supported: ${Object.keys(typeMap).join(', ')}`
          results.push(out); continue
        }

        // 1. Fetch the full transaction
        const txnResp = await qboFetch(entityId, `/${resource}/${out.txn_id}`, {})
        const capResource = resource[0].toUpperCase() + resource.slice(1)
        // QBO sometimes returns TitleCase, sometimes lowercase — try both
        const txn: any = txnResp?.[capResource] || txnResp?.[resource] || txnResp
        if (!txn || !txn.Line) {
          out.error = `Transaction not found or has no Line[] — QBO response shape unexpected`
          results.push(out); continue
        }

        // 2. Find the line(s) hitting an Uncategorized account and swap AccountRef
        let modifiedLines = 0
        for (const line of txn.Line) {
          const detail = line.AccountBasedExpenseLineDetail
                      || line.DepositLineDetail
                      || line.JournalEntryLineDetail
                      || line.AccountRef ? line : null
          // Handle AccountBasedExpenseLineDetail (Purchase/Bill)
          if (line.AccountBasedExpenseLineDetail?.AccountRef) {
            const curId = line.AccountBasedExpenseLineDetail.AccountRef.value
            if (uncategorizedIds.has(curId)) {
              if (!out.old_account_id) {
                out.old_account_id = curId
                out.old_account_name = allAccounts.find((a: any) => a.Id === curId)?.FullyQualifiedName
              }
              line.AccountBasedExpenseLineDetail.AccountRef = { value: out.new_account_id }
              if (entry?.memo) line.Description = entry.memo
              modifiedLines++
            }
          }
          // DepositLineDetail (Deposit)
          else if (line.DepositLineDetail?.AccountRef) {
            const curId = line.DepositLineDetail.AccountRef.value
            if (uncategorizedIds.has(curId)) {
              if (!out.old_account_id) {
                out.old_account_id = curId
                out.old_account_name = allAccounts.find((a: any) => a.Id === curId)?.FullyQualifiedName
              }
              line.DepositLineDetail.AccountRef = { value: out.new_account_id }
              if (entry?.memo) line.Description = entry.memo
              modifiedLines++
            }
          }
          // JournalEntryLineDetail
          else if (line.JournalEntryLineDetail?.AccountRef) {
            const curId = line.JournalEntryLineDetail.AccountRef.value
            if (uncategorizedIds.has(curId)) {
              if (!out.old_account_id) {
                out.old_account_id = curId
                out.old_account_name = allAccounts.find((a: any) => a.Id === curId)?.FullyQualifiedName
              }
              line.JournalEntryLineDetail.AccountRef = { value: out.new_account_id }
              if (entry?.memo) line.Description = entry.memo
              modifiedLines++
            }
          }
        }

        if (modifiedLines === 0) {
          out.error = 'No line in this transaction hits an Uncategorized / Ask-My-Accountant account — nothing to change'
          results.push(out); continue
        }

        // 3. PUT back with operation=update
        const updateResp = await qboPost(entityId, `/${resource}?operation=update`, txn)
        const updated = updateResp?.[capResource] || updateResp
        if (updated?.Id) {
          out.ok = true
          out.new_account_name = allAccounts.find((a: any) => a.Id === out.new_account_id)?.FullyQualifiedName
        } else {
          out.error = 'Update response did not include a new Id — unknown QBO error'
        }
      } catch (e: any) {
        out.error = e.message
      }
      results.push(out)
    }

    const applied = results.filter(r => r.ok).length
    const failed = results.length - applied
    const status = failed > 0 ? 207 : 200
    res.status(status).json({
      entity_id: entityId,
      total: results.length,
      applied,
      failed,
      results,
      note: failed > 0
        ? 'Partial success — check results[].error for per-item failure reasons.'
        : 'All entries applied successfully.',
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Bank CSV reconciliation ───
// Inputs (body):
//   { document_id, qbo_account_id, date_range? }            // CSV already uploaded
//   { csv_data_b64, qbo_account_id, date_range? }            // inline CSV
//
// Pipeline:
//   1. Parse CSV via lightweight heuristic column detector (bank_csv_parser.ts)
//   2. Pull QBO transactions for the account + date range via TransactionList report
//   3. Three-tier deterministic match (reconciler.ts)
//   4. For unmatched CSV rows, ask Gemini Flash Lite to classify each against
//      the entity's chart of accounts; validate suggested account_ids server-side
//
// Response:
//   { summary, matched, missing_in_qbo: [{row, suggested_posting, confidence}],
//     missing_in_bank, parser_issues, gemini_used }
router.post('/:entity_id/reconcile_bank', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { csv_data_b64, qbo_account_id, date_range } = req.body || {}
  if (!qbo_account_id) return res.status(400).json({ error: 'qbo_account_id required' })
  if (!csv_data_b64) return res.status(400).json({ error: 'csv_data_b64 required (base64-encoded CSV text). document_id fetch path not yet implemented — upload the CSV content directly.' })

  try {
    // ── 1. Load CSV text ──
    const csvText = Buffer.from(csv_data_b64, 'base64').toString('utf-8')

    // ── 2. Parse CSV ──
    const { parseBankCsv } = await import('../lib/bank_csv_parser.js')
    const parsed = parseBankCsv(csvText)
    if (parsed.rows.length === 0) {
      return res.status(422).json({
        error: 'CSV_PARSE_FAILED',
        parser_issues: parsed.issues,
        hint: 'The heuristic column detector could not map date/amount/description. Pass csv_data_b64 with a cleaned-up header, or fall back to manual categorization.',
      })
    }

    // ── 3. Determine date range for QBO pull ──
    const dates = parsed.rows.map(r => r.date).sort()
    const start_date = date_range?.start || dates[0]
    const end_date = date_range?.end || dates[dates.length - 1]

    // ── 4. Pull QBO transactions for this account ──
    // Use TransactionList report which returns all txn types filtered by account.
    const reportResp = await qboFetch(req.params.entity_id, '/reports/TransactionList', {
      start_date, end_date, account: qbo_account_id, minorversion: '65',
    })
    // Flatten the report rows into QboTxn shape
    const qboRows: Array<{ id: string; date: string; amount: number; description: string; txn_type: string }> = []
    const walk = (rows: any[]) => {
      for (const r of rows) {
        if (r.type === 'Section' && r.Rows?.Row) walk(r.Rows.Row)
        else if (r.ColData) {
          const cd = r.ColData
          // TransactionList columns: Date, Type, Num, Name, Memo/Description, Account, Split, Amount (signed), Balance
          const date = cd[0]?.value
          const type = cd[1]?.value
          const name = cd[3]?.value || ''
          const memo = cd[4]?.value || ''
          const amountStr = cd[7]?.value
          const id = cd[1]?.id || cd[0]?.id || ''
          const amount = parseFloat(String(amountStr || '0').replace(/[,$]/g, ''))
          if (date && !isNaN(amount) && amount !== 0) {
            qboRows.push({
              id, date, amount,
              description: `${name}${memo ? ' | ' + memo : ''}`.trim(),
              txn_type: type || 'Unknown',
            })
          }
        }
      }
    }
    walk(reportResp?.Rows?.Row || [])

    // ── 5. Reconcile ──
    const { reconcile } = await import('../lib/reconciler.js')
    const recon = reconcile(parsed.rows, qboRows)

    // ── 6. Classify unmatched via Gemini (if key set + there are unmatched rows) ──
    let gemini_used = false
    let suggested_postings: Array<{ row: any; suggested_posting: any; confidence: number; reasoning?: string }> = []
    const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
    if (GEMINI_KEY && recon.missing_in_qbo.length > 0) {
      try {
        // Fetch entity's chart of accounts so Gemini routes to real account IDs
        const coaResp = await qboFetch(req.params.entity_id, '/query', {
          query: 'SELECT Id, Name, FullyQualifiedName, AccountType, AccountSubType FROM Account WHERE Active=true ORDERBY Name MAXRESULTS 500',
        })
        const accounts = (coaResp?.QueryResponse?.Account || []).map((a: any) => ({
          id: a.Id,
          name: a.FullyQualifiedName || a.Name,
          type: a.AccountType,
          sub_type: a.AccountSubType,
        }))
        const validIds = new Set(accounts.map((a: any) => a.id))

        const { GoogleGenerativeAI } = await import('@google/generative-ai')
        const genAI = new GoogleGenerativeAI(GEMINI_KEY)
        const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })

        // Shape of the prompt: pass COA once + batch of unmatched rows.
        // Ask for strict JSON array keyed by row_index.
        const coaList = accounts.map((a: any) => `  ${a.id}: ${a.name} [${a.type}/${a.sub_type}]`).join('\n')
        const rowsList = recon.missing_in_qbo.map((r, i) => `  ${i}: date=${r.date} amount=${r.amount} "${r.description.replace(/"/g, '\\"')}"`).join('\n')
        const prompt = `You are categorizing bank transactions for an S-Corp / C-Corp entity that uses QuickBooks Online. For each bank transaction not yet booked in QBO, suggest how it should be posted.

Chart of accounts (ID: name [type/subtype]):
${coaList}

Unmatched bank transactions:
${rowsList}

For each row, return one JSON object with these fields:
  row_index: integer
  type: one of "Purchase" | "Deposit" | "Transfer" | "JournalEntry" | "Payment" | "BillPayment" | "CreditCardPayment"
  account_id: string — MUST be one of the IDs from the chart above; picks the expense/income/equity account to offset against the bank
  memo: short string describing what this is
  confidence: number 0..1
  reasoning: short string (one sentence) explaining the classification

Rules:
- Bank account is the one paying/receiving (paid via account id ${qbo_account_id}). The suggested account_id is the OFFSETTING account.
- Negative bank amount = money out (Purchase or Transfer/JE). Positive = money in (Deposit).
- "STRIPE*" descriptions → type:"Deposit", pair with the Stripe clearing / A/R account if present.
- "ORIG CO NAME:*PAYROLL*" / "GUSTO" → type:"Purchase", pair with payroll clearing / payroll expense.
- "CITI AUTOPAY" / "*CARD PAYMENT*" → type:"CreditCardPayment" or "Transfer" to the credit card liability account.
- Loan payments → type:"JournalEntry" (split principal vs interest).
- "ZELLE TO:<name>" or check → type:"Purchase", pick a plausible expense account.
- If you genuinely don't know, use an "Uncategorized Expense" / "Ask My Accountant" / "Uncategorized Asset" account if present in the chart; set confidence ≤ 0.5.

Return ONLY a JSON array of objects, no prose, no markdown fences.`

        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        })
        const text = result.response.text()
        let parsedJson: any[] = []
        try { parsedJson = JSON.parse(text) } catch { parsedJson = [] }

        for (const entry of parsedJson) {
          const idx = Number(entry?.row_index)
          if (!Number.isInteger(idx) || idx < 0 || idx >= recon.missing_in_qbo.length) continue
          const row = recon.missing_in_qbo[idx]
          const suggestedAcctId = String(entry?.account_id || '')
          const accountValid = validIds.has(suggestedAcctId)
          const amt = row.amount
          // Build a minimal QBO posting payload matching the suggested type.
          const type = String(entry?.type || 'Purchase')
          let data: any = null
          if (type === 'Deposit') {
            data = {
              TxnDate: row.date,
              DepositToAccountRef: { value: qbo_account_id },
              Line: [{
                Amount: Math.abs(amt),
                DetailType: 'DepositLineDetail',
                Description: entry.memo || row.description,
                DepositLineDetail: {
                  AccountRef: accountValid ? { value: suggestedAcctId } : undefined,
                },
              }],
              PrivateNote: `Auto-suggested from bank reconciliation | ${entry.reasoning || ''}`.slice(0, 240),
            }
          } else if (type === 'Purchase') {
            data = {
              TxnDate: row.date,
              PaymentType: 'Check',
              AccountRef: { value: qbo_account_id },
              Line: [{
                Amount: Math.abs(amt),
                DetailType: 'AccountBasedExpenseLineDetail',
                Description: entry.memo || row.description,
                AccountBasedExpenseLineDetail: {
                  AccountRef: accountValid ? { value: suggestedAcctId } : undefined,
                },
              }],
              PrivateNote: `Auto-suggested from bank reconciliation | ${entry.reasoning || ''}`.slice(0, 240),
            }
          } else if (type === 'Transfer') {
            data = {
              TxnDate: row.date,
              Amount: Math.abs(amt),
              FromAccountRef: { value: amt < 0 ? qbo_account_id : (accountValid ? suggestedAcctId : qbo_account_id) },
              ToAccountRef:   { value: amt < 0 ? (accountValid ? suggestedAcctId : qbo_account_id) : qbo_account_id },
              PrivateNote: `Auto-suggested from bank reconciliation | ${entry.reasoning || ''}`.slice(0, 240),
            }
          } else if (type === 'JournalEntry') {
            // Basic single-split JE — caller can add more lines manually
            data = {
              TxnDate: row.date,
              Line: [
                {
                  Amount: Math.abs(amt),
                  DetailType: 'JournalEntryLineDetail',
                  Description: entry.memo || row.description,
                  JournalEntryLineDetail: {
                    PostingType: amt < 0 ? 'Debit' : 'Credit',
                    AccountRef: accountValid ? { value: suggestedAcctId } : undefined,
                  },
                },
                {
                  Amount: Math.abs(amt),
                  DetailType: 'JournalEntryLineDetail',
                  Description: entry.memo || row.description,
                  JournalEntryLineDetail: {
                    PostingType: amt < 0 ? 'Credit' : 'Debit',
                    AccountRef: { value: qbo_account_id },
                  },
                },
              ],
              PrivateNote: `Auto-suggested from bank reconciliation | ${entry.reasoning || ''}`.slice(0, 240),
            }
          }
          suggested_postings.push({
            row,
            suggested_posting: { type, data, account_valid: accountValid, suggested_account_id: suggestedAcctId, suggested_account_name: accountValid ? accounts.find((a: any) => a.id === suggestedAcctId)?.name : null },
            confidence: Number(entry.confidence) || 0,
            reasoning: entry.reasoning,
          })
        }
        gemini_used = true
      } catch (e: any) {
        // Non-fatal — fall back to returning missing_in_qbo without suggestions
        parsed.issues.push(`Gemini classification failed: ${e.message}`)
      }
    }

    const totalMatchedAmount = recon.matched.reduce((s, m) => s + Math.abs(m.bank_row.amount), 0)
    const totalMissingQboAmount = recon.missing_in_qbo.reduce((s, r) => s + Math.abs(r.amount), 0)
    const totalMissingBankAmount = recon.missing_in_bank.reduce((s, q) => s + Math.abs(q.amount), 0)

    res.json({
      summary: {
        csv_rows: parsed.rows.length,
        qbo_rows: qboRows.length,
        matched: recon.matched.length,
        missing_in_qbo: recon.missing_in_qbo.length,
        missing_in_bank: recon.missing_in_bank.length,
        matched_dollars: Math.round(totalMatchedAmount * 100) / 100,
        missing_qbo_dollars: Math.round(totalMissingQboAmount * 100) / 100,
        missing_bank_dollars: Math.round(totalMissingBankAmount * 100) / 100,
        match_rate_pct: parsed.rows.length ? Math.round((recon.matched.length / parsed.rows.length) * 100) : 0,
        format_detected: parsed.format_detected,
        date_range: { start: start_date, end: end_date },
      },
      matched: recon.matched,
      missing_in_qbo: suggested_postings.length > 0 ? suggested_postings : recon.missing_in_qbo.map(r => ({ row: r, suggested_posting: null, confidence: 0 })),
      missing_in_bank: recon.missing_in_bank,
      parser_issues: parsed.issues,
      gemini_used,
      note: gemini_used
        ? 'Suggested postings come from Gemini Flash Lite with the entity chart of accounts as context. Each carries a confidence score and an account_valid flag — verify before piping into post_transactions_batch.'
        : 'Gemini classifier not used (no GEMINI_API_KEY or no unmatched rows). Unmatched rows returned without suggestions.',
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Loan amortization → JournalEntry schedule ───
// Pure-math helper that takes loan terms and returns a full amortization
// schedule plus balanced JournalEntry payloads ready to feed into
// /transactions_batch. Does NOT post anything. Typical usage:
//   1. POST /:entity_id/loan-amortization-schedule {principal, annual_rate, ...}
//   2. Review summary + schedule
//   3. Post schedule[i].journal_entries to /:entity_id/transactions_batch
//      (or to qbo_resource one-at-a-time).
router.post('/:entity_id/loan-amortization-schedule', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { amortizationSchedule } = await import('../lib/amortization.js')
    const required = ['principal', 'annual_rate', 'term_months', 'first_payment_date',
      'interest_account_id', 'principal_account_id', 'from_account_id']
    for (const k of required) {
      if (req.body?.[k] === undefined || req.body[k] === null) {
        return res.status(400).json({ error: `${k} is required`, required })
      }
    }
    const result = amortizationSchedule(req.body)
    res.json(result)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
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
