import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface TaxReturn {
  id: string
  entity_id: string
  tax_year: number
  form_type: string
  status: string
  is_amended?: boolean
  input_data?: Record<string, unknown>
  computed_data?: Record<string, unknown>
  pdf_s3_path?: string
  pdf_generated_at?: string
  created_at?: string
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
  }) => {
    const data = await api<{ return: TaxReturn }>('/api/returns/compute', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await load()
    return data
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
    return api(`/api/returns/compare/${entityId}`)
  }

  return { returns, loading, reload: load, compute, validate, getPdf, compare }
}
