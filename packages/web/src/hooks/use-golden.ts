/**
 * The golden view of one return year (GET /api/golden/:entity_id?year=):
 * every box with its value from each source — filed return, the IRS's record,
 * stored returns, the books, scenarios — on one key. Types mirror the API's
 * src/schema/golden.ts and src/routes/golden.ts.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type GoldenValue = number | string | boolean | null
export interface Cell { value: GoldenValue; where: string }
export type RowStatus = 'agrees' | 'differs' | 'irs_only' | 'filed_only' | 'irs_recomputed' | 'returns_only'

export interface GoldenRow {
  form: string
  key: string
  instance?: string
  label: string
  section: string
  line: string
  col?: string
  filed?: Cell
  irs?: Cell
  irs_computed?: Cell
  returns?: Record<string, Cell>
  books?: Cell & { summed?: boolean; accounts?: Array<{ account: string; amount: number; rule: string }> }
  documents?: Cell & { sources?: string[] }
  documents_differs?: boolean
  scenarios?: Record<string, Cell>
  books_differs?: boolean
  golden?: GoldenValue
  golden_from?: 'irs' | 'filed' | 'return'
  status: RowStatus
  headline?: boolean
  /** one of the lines a reader checks first (the "Key lines" view) */
  key_line?: boolean
}

export interface GoldenView {
  entity: { id: string; name: string; form_type: string }
  year: number
  sources: {
    filed_return: { catalog_id: string; filename: string | null } | null
    irs_return_transcript: { catalog_id: string; type: string; as_of: string | null; holds_return_of?: number; note?: string } | null
    returns: Array<{ id: string; label: string }>
    books: ({ pnl_as_of?: string | null; lines?: number; unplaced?: Array<{ field: string; amount: number }>; dropped?: number; warnings?: string[]; available?: false; why?: string }) | null
    scenarios: Array<{ id: string; label: string }>
    documents?: { count: number; types: string[]; lines: number; k1s_from_group_returns: string[]; unplaced: Array<{ field: string; value: number }>; notes: string[] }
  }
  summary: { keys: number; agrees: number; differs: number; irs_only: number; filed_only: number; irs_recomputed: number; returns_only: number; headline_differs: number; books_lines: number; books_differ_from_golden: number; documents_lines?: number; documents_differ_from_golden?: number }
  rows: GoldenRow[]
}

export function useGolden(entityId: string | undefined, year: number | null) {
  const [data, setData] = useState<GoldenView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!entityId || !year) { setData(null); return }
    setLoading(true); setError(null)
    try {
      setData(await api<GoldenView>(`/api/golden/${entityId}?year=${year}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the comparison')
    }
    setLoading(false)
  }, [entityId, year])
  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}
