import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface Scenario {
  id: string
  entity_id?: string
  base_return_id?: string
  name: string
  description?: string
  tax_year: number
  status: string
  adjustments?: Record<string, unknown>
  computed_result?: Record<string, unknown>
  diff?: Record<string, unknown>
  ai_analysis?: string
  created_at?: string
}

export function useScenarios(entityId?: string) {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<{ scenarios: Scenario[] }>('/api/scenarios')
      const filtered = entityId
        ? (data.scenarios || []).filter(s => s.entity_id === entityId)
        : data.scenarios || []
      setScenarios(filtered)
    } catch {
      setScenarios([])
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { load() }, [load])

  const create = async (body: {
    entity_id?: string
    name: string
    description?: string
    tax_year: number
    adjustments: Record<string, unknown>
    base_return_id?: string
  }) => {
    const data = await api<{ scenario: Scenario }>('/api/scenarios', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return data.scenario
  }

  const compute = async (id: string) => {
    const data = await api(`/api/scenarios/${id}/compute`, { method: 'POST' })
    await load()
    return data
  }

  const analyze = async (id: string) => {
    const data = await api(`/api/scenarios/${id}/analyze`, { method: 'POST' })
    await load()
    return data
  }

  const promote = async (id: string) => {
    const data = await api(`/api/scenarios/${id}/promote`, { method: 'POST' })
    await load()
    return data
  }

  const getPdf = async (id: string) => {
    return api<{ pdf_url: string }>(`/api/scenarios/${id}/pdf`, { method: 'POST' })
  }

  const compareScenarios = async (ids: string[]) => {
    return api('/api/scenarios/compare', {
      method: 'POST',
      body: JSON.stringify({ scenario_ids: ids }),
    })
  }

  return { scenarios, loading, reload: load, create, compute, analyze, promote, getPdf, compareScenarios }
}
