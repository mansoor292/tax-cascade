import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type ReturnSource = 'filed_import' | 'amendment' | 'proforma' | 'extension'

export interface TaxReturn {
  id: string
  entity_id: string
  tax_year: number
  form_type: string
  status: string
  source?: ReturnSource
  supersedes_id?: string | null
  is_amended?: boolean
  input_data?: Record<string, unknown>
  computed_data?: {
    computed?: Record<string, number>
    [k: string]: unknown
  }
  field_values?: Record<string, number | string | null>
  verification?: {
    mapper_stats?: { mapped?: number; total_input_keys?: number; high_confidence?: number; medium_confidence?: number; low_confidence?: number }
    gemini_gap_fill?: { gaps_total?: number; gaps_filled?: number; model?: string; error?: string }
    extracted_count?: number
    unmapped_count?: number
    [k: string]: unknown
  }
  pdf_s3_path?: string
  pdf_generated_at?: string
  computed_at?: string
  created_at?: string
}

export interface CompareReturnsResponse {
  entity: { name: string }
  years: number[]
  returns: TaxReturn[]
  all_rows: TaxReturn[]
  matrix: Record<string, Record<string | number, number>>
  changes: Record<string, Record<string | number, { value: number; prev: number; delta: number; pct: number }>>
}

export function useReturns(entityId?: string) {
  const [returns, setReturns] = useState<TaxReturn[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<{ returns: TaxReturn[] }>('/api/returns')
      const filtered = entityId
        ? (data.returns || []).filter(r => r.entity_id === entityId)
        : data.returns || []
      setReturns(filtered)
    } catch {
      setReturns([])
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { load() }, [load])

  const compute = async (body: {
    entity_id: string
    tax_year: number
    form_type: string
    inputs: Record<string, unknown>
    amend_of?: string
    return_id?: string
    new_row?: boolean
  }) => {
    const data = await api<any>('/api/returns/compute', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await load()
    return data
  }

  /** Create an amendment that supersedes a filed_import (or another amendment). */
  const createAmendment = async (
    filedReturn: TaxReturn,
    inputOverrides: Record<string, unknown> = {},
  ) => {
    return compute({
      entity_id: filedReturn.entity_id,
      tax_year: filedReturn.tax_year,
      form_type: filedReturn.form_type,
      amend_of: filedReturn.id,
      inputs: inputOverrides,
    })
  }

  const validate = async (body: {
    form_type: string
    tax_year: number
    inputs: Record<string, unknown>
  }) => {
    return api<{ valid: boolean; errors?: string[]; warnings?: string[] }>('/api/returns/validate', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  const getPdf = async (returnId: string) => {
    return api<{ pdf_url: string }>(`/api/returns/${returnId}/pdf?regenerate=true`)
  }

  const compare = async (entityId: string) => {
    return api<CompareReturnsResponse>(`/api/returns/compare/${entityId}`)
  }

  const remove = async (returnId: string) => {
    await api(`/api/returns/${returnId}`, { method: 'DELETE' })
    await load()
  }

  /** Re-run Gemini gap-fill on a filed_import row and persist the new values. */
  const fillGaps = async (returnId: string) => {
    return api<{ gaps_total: number; gaps_filled: number; model: string; persisted: boolean }>('/api/intake/gap-fill', {
      method: 'POST',
      body: JSON.stringify({ return_id: returnId, persist: true }),
    })
  }

  return { returns, loading, reload: load, compute, createAmendment, validate, getPdf, compare, remove, fillGaps }
}

/** Dedicated hook for the compare_returns endpoint — used by the Compare page. */
export function useCompareReturns(entityId: string | undefined) {
  const [data, setData] = useState<CompareReturnsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!entityId) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const resp = await api<CompareReturnsResponse>(`/api/returns/compare/${entityId}`)
      setData(resp)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load comparison')
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { load() }, [load])

  return { data, loading, error, reload: load }
}
