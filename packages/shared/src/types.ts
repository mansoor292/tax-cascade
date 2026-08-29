/**
 * API response shapes shared by server and web. These were hand-declared in
 * the web hooks and shadow-declared again in pages (Scenario existed three
 * times); one drift already shipped a silent bug (the scenario-PDF field
 * mismatch). The web hooks re-export from here; the API treats these as the
 * public response contract.
 */

export type ReturnSource = 'filed_import' | 'amendment' | 'proforma' | 'extension'

export interface Entity {
  id: string
  name: string
  form_type: string
  /** Legal form of organisation, independent of tax treatment. */
  legal_form?: string | null
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

export interface Scenario {
  id: string
  entity_id?: string
  base_return_id?: string
  name: string
  description?: string
  tax_year: number
  status: string
  adjustments?: Record<string, unknown>
  computed_result?: Record<string, unknown>
  diff?: Record<string, unknown>
  ai_analysis?: string
  created_at?: string
  tax_entity?: { name: string; form_type: string }
}
