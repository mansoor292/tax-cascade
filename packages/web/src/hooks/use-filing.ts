import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { EntityFiling } from '@/lib/filing'

export type { EntityFiling, YearFiling } from '@/lib/filing'

/** Filed and accepted per year — every entity, or one. */
export function useFiling(entityId?: string) {
  const [entities, setEntities] = useState<EntityFiling[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const q = entityId ? `?entity_id=${encodeURIComponent(entityId)}` : ''
      const data = await api<{ entities: EntityFiling[] }>(`/api/review/filing${q}`)
      setEntities(data.entities || [])
    } catch (e: unknown) {
      setEntities([])
      setError(e instanceof Error ? e.message : 'Failed to load filing status')
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { load() }, [load])
  return { entities, loading, error, reload: load }
}
