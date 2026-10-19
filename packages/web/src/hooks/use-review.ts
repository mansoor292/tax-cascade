import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * The review framework's results (packages/api/src/routes/review.ts summary)
 * and the version sets' breaks (routes/versions.ts GET /:label/breaks). Both
 * READ the latest stored runs; nothing here starts a review. Types are
 * hand-written against those routes; check them before adding a field.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Evidence {
  where: string
  value?: unknown
}

export interface ReviewItem {
  entity: string
  entity_id: string
  form_type: string
  fingerprint: string
  check: string
  area?: string
  kind?: 'rule' | 'ai' | 'fact'
  tax_year: number
  status: 'finding' | 'gap' | 'error'
  severity: Severity
  title: string
  detail: string
  /** A tie: figures that must agree within a return, year to year or across returns */
  tie?: boolean
  /** Set on a draft version set's new breaks */
  version_set?: string
  dollar_effect?: number | null
  deadline?: string | null
  asks?: string[]
  evidence?: Evidence[] | null
  change?: 'new' | 'changed' | 'unchanged' | 'resolved'
}

export interface ReturnNote {
  note_key: string
  entity: string | undefined
  entity_id: string
  form_type: string | undefined
  tax_year: number | null
  status: 'open' | 'info' | 'closed'
  waiting_on: string | null
  title: string
  body: string | null
  due_date: string | null
  recorded_at: string
}

export interface SetSummary {
  set: string
  title: string | null
  ties: boolean
  reviewed_returns: number
  new_breaks: number
  inherited_breaks: number
  fixes: Array<{ entity: string; tax_year: number; title: string }>
}

export interface ReviewSummary {
  count: number
  items: ReviewItem[]
  facts_to_ask: string[]
  open_notes_count: number
  open_notes: ReturnNote[]
  breaks: { filed: number; sets: SetSummary[] }
}

export interface BreakItem {
  entity: string
  entity_id: string
  form_type: string
  tax_year: number
  fingerprint: string
  check: string
  severity: Severity
  title: string
  detail: string
  dollar_effect?: number
  evidence: Evidence[] | null
  in_filed?: boolean
}

/** 'filed' answers breaks; a draft set answers new / inherited / fixes. */
export interface BreaksReport {
  set: string
  reviewed_returns: number
  breaks_count: number
  ties: boolean
  breaks?: BreakItem[]
  new_breaks?: BreakItem[]
  inherited_breaks?: BreakItem[]
  fixes?: BreakItem[]
}

export interface VersionSet {
  label: string
  title: string | null
  description: string | null
  status: 'draft' | 'filed' | 'abandoned'
  filed_on: string | null
  versions: Array<{ entity_id: string; entity: string | null; tax_year: number; form: string | null }>
}

function useLoad<T>(path: string | null, what: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    setError(null)
    try {
      setData(await api<T>(path))
    } catch (e: unknown) {
      setData(null)
      setError(e instanceof Error ? e.message : `Failed to load ${what}`)
    }
    setLoading(false)
  }, [path, what])

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

export function useReviewSummary() {
  return useLoad<ReviewSummary>('/api/review/summary', 'the open items')
}

export function useVersionSets() {
  const r = useLoad<{ sets: VersionSet[] }>('/api/version-sets', 'the version sets')
  return { ...r, sets: r.data?.sets ?? [] }
}

export function useBreaks(view: string) {
  return useLoad<BreaksReport>(`/api/version-sets/${encodeURIComponent(view)}/breaks`, 'the breaks')
}
