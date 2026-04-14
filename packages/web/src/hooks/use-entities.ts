import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface Entity {
  id: string
  name: string
  form_type: string
  ein?: string
  address?: string
  city?: string
  state?: string
  zip?: string
  entity_type?: string
  meta?: Record<string, unknown>
  return_count?: number
  scenario_count?: number
  created_at?: string
}

export function useEntities() {
  const [entities, setEntities] = useState<Entity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api<{ entities: Entity[] }>('/api/entities')
      setEntities(data.entities || [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load entities')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const create = async (body: { name: string; form_type: string; ein?: string }) => {
    const data = await api<{ entity: Entity }>('/api/entities', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await load()
    return data.entity
  }

  const update = async (id: string, body: Partial<Entity>) => {
    await api(`/api/entities/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    await load()
  }

  return { entities, loading, error, reload: load, create, update }
}

export function useEntity(id: string | undefined) {
  const [entity, setEntity] = useState<Entity | null>(null)
  const [returns, setReturns] = useState<unknown[]>([])
  const [scenarios, setScenarios] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const data = await api<{ entity: Entity; returns: unknown[]; scenarios: unknown[] }>(`/api/entities/${id}`)
      setEntity(data.entity)
      setReturns(data.returns || [])
      setScenarios(data.scenarios || [])
    } catch {
      setEntity(null)
    }
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  return { entity, returns, scenarios, loading, reload: load }
}
