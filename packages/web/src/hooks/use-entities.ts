import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Entity } from '@taxengine/shared'

export type { Entity }

/**
 * Every useEntities() is its own fetch, so creating an entity on the Entities
 * page left the sidebar's copy stale: a new account still read "Create your
 * first entity" beside the entity it had just made (UI audit, 2026-10-22).
 * Anything that adds, edits or deletes an entity calls entitiesChanged(), and
 * every mounted list reloads.
 */
const CHANGED = 'catipult:entities-changed'
export function entitiesChanged() {
  window.dispatchEvent(new Event(CHANGED))
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
  useEffect(() => {
    const onChange = () => { load() }
    window.addEventListener(CHANGED, onChange)
    return () => window.removeEventListener(CHANGED, onChange)
  }, [load])

  const create = async (body: { name: string; form_type: string; ein?: string; legal_form?: string }) => {
    const data = await api<{ entity: Entity }>('/api/entities', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    entitiesChanged()
    return data.entity
  }

  const update = async (id: string, body: Partial<Entity>) => {
    await api(`/api/entities/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    entitiesChanged()
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
