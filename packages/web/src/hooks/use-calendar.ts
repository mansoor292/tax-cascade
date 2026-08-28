import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type Urgency = 'overdue' | 'unverified' | 'due_soon' | 'upcoming' | 'done' | 'dismissed'

export interface Obligation {
  id: string
  entity_id: string
  kind: 'return' | 'extension' | 'estimated_payment' | 'annual_report' | 'state_return' | 'other'
  source: 'generated' | 'custom'
  title: string
  due_date: string
  tax_year?: number
  period?: string
  jurisdiction?: string
  form?: string | null
  extended?: boolean
  status: 'pending' | 'done' | 'dismissed'
  amount?: number | null
  notes?: string | null
  meta?: { note?: string }
  days_until: number
  urgency: Urgency
  tax_entity?: { name: string; form_type: string }
}

export interface CalendarResponse {
  today: string
  count: number
  overdue: number
  due_soon: number
  obligations: Obligation[]
}

export function useCalendar(entityId?: string, withinDays?: number) {
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (entityId) qs.set('entity_id', entityId)
      if (withinDays) qs.set('within_days', String(withinDays))
      const q = qs.toString()
      setData(await api<CalendarResponse>(`/api/calendar${q ? `?${q}` : ''}`))
    } catch {
      setData(null)
    }
    setLoading(false)
  }, [entityId, withinDays])

  useEffect(() => { load() }, [load])

  const update = useCallback(async (id: string, patch: Partial<Pick<Obligation, 'status' | 'amount' | 'notes'>>) => {
    await api(`/api/calendar/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    await load()
  }, [load])

  return { data, loading, reload: load, update }
}
