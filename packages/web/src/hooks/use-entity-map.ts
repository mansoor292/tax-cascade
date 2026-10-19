import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * The entity map (GET /api/entity-map — packages/api/src/services/entity_map.ts
 * assembleMap): how the entities in the account depend on each other.
 * Types are hand-written against that function; check it before adding a field.
 */

export type LinkKind = 'owns' | 'disregarded' | 'intercompany'
export type LinkNature = 'services' | 'loan' | 'rent' | 'settlement' | 'other'
export type LinkSource = 'owner' | 'filed_return' | 'fact' | 'entity_record'

export interface MapLink {
  link_key: string
  kind: LinkKind
  from_entity_id: string
  to_entity_id: string | null
  to_name: string | null
  subject: string | null
  pct: number | null
  nature: LinkNature | null
  from_year: number | null
  to_year: number | null
  source: LinkSource
  evidence: string | null
  detail: string | null
  recorded_at: string
  from_entity_name: string | null
  to_entity_name: string | null
}

export interface Touch {
  entity_id: string | null
  name: string | null
  via: string
  effect: string
  link_key: string
}

export interface MapEntity {
  id: string
  name: string
  form_type: string
  /** Years with a filed return catalogued */
  years: number[]
  /** What a change to this entity's return reaches, by link */
  touches: Touch[]
}

export interface Owner {
  owner: string
  files_on: { entity_id: string; name: string | null }
  holds: Array<{ entity_id: string | null; name: string | null; form_type: string | null; pct: number | null; from_year: number | null; to_year: number | null; link_key: string }>
}

/** A relationship the returns show that no recorded link answers yet. */
export interface LinkSuggestion {
  kind: LinkKind
  from_entity_id: string
  to_entity_id: string | null
  to_name: string | null
  subject: string | null
  pct: number | null
  nature: LinkNature | null
  years: number[]
  source: LinkSource
  evidence: string[]
  from_entity_name: string | null
  to_entity_name: string | null
}

export interface EntityMap {
  entities: MapEntity[]
  links: MapLink[]
  removed_links: Array<{ link_key: string; kind: LinkKind; from_entity_name: string | null; to_entity_name: string | null; detail: string | null }>
  owners: Owner[]
  unrecorded: LinkSuggestion[]
}

/** The POST body that records a suggestion as it stands (routes/entity_map.ts
 *  checkLinkFields + checkLinkComplete: a non-owner source needs evidence). */
export function suggestionToLink(s: LinkSuggestion) {
  return {
    kind: s.kind,
    from_entity_id: s.from_entity_id,
    ...(s.to_entity_id ? { to_entity_id: s.to_entity_id } : { to_name: s.to_name }),
    ...(s.kind === 'owns' ? { subject: s.subject, pct: s.pct } : {}),
    ...(s.kind === 'intercompany' ? { nature: s.nature } : {}),
    from_year: s.years.length ? Math.min(...s.years) : null,
    source: s.source,
    evidence: s.evidence.join('; ').slice(0, 2000) || null,
  }
}

export function useEntityMap() {
  const [data, setData] = useState<EntityMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api<EntityMap>('/api/entity-map'))
    } catch (e: unknown) {
      setData(null)
      setError(e instanceof Error ? e.message : 'Failed to load the entity map')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const record = useCallback(async (s: LinkSuggestion) => {
    await api('/api/entity-map/links', { method: 'POST', body: JSON.stringify(suggestionToLink(s)) })
    await load()
  }, [load])

  return { data, loading, error, reload: load, record }
}
