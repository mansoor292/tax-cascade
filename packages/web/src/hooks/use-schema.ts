import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface FieldDef {
  key: string
  label: string
  type: string
  section?: string
  default?: unknown
  description?: string
}

export interface FormSchema {
  form_type: string
  year: number
  fields: FieldDef[]
  sections?: string[]
}

export function useSchema(formType?: string, year?: number) {
  const [schema, setSchema] = useState<FormSchema | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!formType || !year) { setSchema(null); return }
    setLoading(true)
    try {
      const data = await api<FormSchema>(`/api/schema/${formType}/${year}`)
      setSchema(data)
    } catch {
      setSchema(null)
    }
    setLoading(false)
  }, [formType, year])

  useEffect(() => { load() }, [load])

  return { schema, loading }
}

export function useTaxTables(year?: number) {
  const [tables, setTables] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!year) return
    setLoading(true)
    try {
      const data = await api<Record<string, unknown>>(`/api/tax-tables/${year}`)
      setTables(data)
    } catch {
      setTables(null)
    }
    setLoading(false)
  }, [year])

  useEffect(() => { load() }, [load])

  return { tables, loading }
}

export function useApiSchema() {
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<Record<string, unknown>>('/api/schema')
      .then(setSchema)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { schema, loading }
}
