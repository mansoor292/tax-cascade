import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface QboStatus {
  connected: boolean
  company_name?: string
  last_synced_at?: string
  realm_id?: string
  accounting_method?: string | null
}

export interface Financials {
  profit_and_loss?: Record<string, unknown>
  balance_sheet?: Record<string, unknown>
  year?: number
}

export interface Transaction {
  date: string
  type: string
  name: string
  memo?: string
  account: string
  amount: number
}

export interface Account {
  id: string
  name: string
  type: string
  balance?: number
}

export function useQbo(entityId: string | undefined) {
  const [status, setStatus] = useState<QboStatus>({ connected: false })
  const [loading, setLoading] = useState(true)

  const loadStatus = useCallback(async () => {
    if (!entityId) return
    setLoading(true)
    try {
      const data = await api<QboStatus>(`/api/qbo/${entityId}/status`)
      setStatus(data)
    } catch {
      setStatus({ connected: false })
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { loadStatus() }, [loadStatus])

  const connect = async () => {
    if (!entityId) return
    const data = await api<{ auth_url: string }>(`/api/qbo/connect/${entityId}`)
    window.open(data.auth_url, '_blank')
  }

  const getFinancials = async (year?: number, refresh?: boolean) => {
    if (!entityId) return null
    const params = new URLSearchParams()
    if (year) params.set('year', String(year))
    if (refresh) params.set('refresh', 'true')
    return api<Financials>(`/api/qbo/${entityId}/financials?${params}`)
  }

  const getReport = async (report: string, year?: number, refresh?: boolean) => {
    if (!entityId) return null
    const params = new URLSearchParams()
    if (year) params.set('year', String(year))
    if (refresh) params.set('refresh', 'true')
    return api(`/api/qbo/${entityId}/reports/${report}?${params}`)
  }

  const getTransactions = async (filters?: {
    year?: number
    account?: string
    start_date?: string
    end_date?: string
  }) => {
    if (!entityId) return []
    const params = new URLSearchParams()
    if (filters?.year) params.set('year', String(filters.year))
    if (filters?.account) params.set('account', filters.account)
    if (filters?.start_date) params.set('start_date', filters.start_date)
    if (filters?.end_date) params.set('end_date', filters.end_date)
    const data = await api<{ transactions: Transaction[] }>(`/api/qbo/${entityId}/transactions?${params}`)
    return data.transactions || []
  }

  const getAccounts = async () => {
    if (!entityId) return []
    const data = await api<{ accounts: Account[] }>(`/api/qbo/${entityId}/accounts`)
    return data.accounts || []
  }

  const getMapping = async (formType: string) => {
    return api(`/api/schema/${formType}/qbo-mapping`)
  }

  return { status, loading, reloadStatus: loadStatus, connect, getFinancials, getReport, getTransactions, getAccounts, getMapping }
}
