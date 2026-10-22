/**
 * Filed and accepted, per entity and year — the shape of GET /api/review/filing
 * (packages/api/src/review/filing.ts) and the counts the pages show.
 *
 * Filed: a filed return is on file — a catalogued filed PDF or an imported
 * row. Accepted: the IRS's transcript confirms it; false until a transcript
 * does (Mansoor, 2026-10-22).
 */
export interface YearFiling {
  tax_year: number
  filed: null | { via: 'catalog' | 'import'; catalog_id?: string; filename?: string | null; return_id?: string }
  accepted: boolean
  accepted_why: string
  transcript_as_of?: string | null
  posted_in?: number
  holds_return_of?: number
  extended: boolean
  due: string
  extended_due: string
}

export interface EntityFiling {
  entity_id: string
  name: string
  form_type: string
  years: YearFiling[]
}

/** Filed and accepted entity-years. */
export function filingCounts(entities: Array<Pick<EntityFiling, 'years'>>): { filed: number; accepted: number } {
  const ys = entities.flatMap(e => e.years).filter(y => y.filed)
  return { filed: ys.length, accepted: ys.filter(y => y.accepted).length }
}
