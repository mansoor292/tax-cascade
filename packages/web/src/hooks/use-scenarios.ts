import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Scenario } from '@taxengine/shared'

export type { Scenario }

export function useScenarios(entityId?: string) {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api<{ scenarios: Scenario[] }>('/api/scenarios')
      const filtered = entityId
        ? (data.scenarios || []).filter(s => s.entity_id === entityId)
        : data.scenarios || []
      setScenarios(filtered)
    } catch (e: unknown) {
      setScenarios([])
      setError(e instanceof Error ? e.message : 'Failed to load scenarios')
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

  // GET, and the response field is `url` — this endpoint once shipped as a
  // POST reading `pdf_url` (copied from use-returns' different route) and the
  // PDF button silently did nothing.
  const getPdf = async (id: string) => {
    return api<{ url: string }>(`/api/scenarios/${id}/pdf`)
  }

  const compareScenarios = async (ids: string[]) => {
    return api('/api/scenarios/compare', {
      method: 'POST',
      body: JSON.stringify({ scenario_ids: ids }),
    })
  }

  return { scenarios, loading, error, reload: load, create, compute, analyze, promote, getPdf, compareScenarios }
}
