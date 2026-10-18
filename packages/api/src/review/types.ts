/**
 * Review framework — the contract every check follows.
 *
 * Why (2026-10-17): for six months, errors in the Edgewater returns surfaced
 * one conversation at a time — NIIT charged on nonpassive S-corp income,
 * distributions above basis never reported, a 2021 suspended loss, loans
 * misdescribed — each only when someone happened to ask a nearby question.
 * The owner's requirement: every return type is put through a FIXED framework
 * of checks, every time, and the results are stored, so the next run reports
 * what changed and why instead of rediscovering things.
 *
 * A check reads only the catalog (src/catalog), the recorded facts, and other
 * entities' catalogs that a return itself links to (a Schedule E row naming an
 * S-corp's EIN). It never reads a PDF.
 */
import type { CatalogEntry, CatalogCoverage } from '../catalog/types.js'

export type FormType = '1040' | '1120' | '1120S' | '1065'

export type Area =
  | 'catalog' | 'corporate' | 'income' | 'k1' | 'balance_sheet' | 'basis' | 'niit'
  | 'qbi' | 'loans' | 'carryovers' | 'intercompany' | 'state' | 'irs_account'
  | 'statute' | 'facts' | 'preparation' | 'entity_map'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** finding = something is wrong or at risk; gap = the check could not be
 *  decided because a fact or document is missing; pass; n/a; error = the
 *  check itself failed (a bug — reported, never swallowed). */
export type Status = 'finding' | 'gap' | 'pass' | 'n/a' | 'error'

export interface Evidence {
  /** Human citation: "2023 Form 1120-S, Schedule L, line 19, column (d) (page 4)" */
  where: string
  entry_id?: string
  catalog_id?: string
  value?: unknown
  /** fact key, when the evidence is a recorded fact */
  fact?: string
}

export interface CheckResult {
  check: string
  status: Status
  severity: Severity
  title: string
  /** Plain-English explanation: what is wrong, why it matters, what to do */
  detail: string
  /** Disambiguates several results of one check (a line, a K-1, a year) */
  key?: string
  evidence: Evidence[]
  /** Estimated tax effect in dollars: positive = more tax owed, negative = refund */
  dollar_effect?: number
  /** ISO date by which something must happen (a statute, a filing) */
  deadline?: string
  /** Fact keys to ask the owner (all at once) */
  asks?: string[]
}

export interface CatalogView {
  id: string
  kind: 'filed_return' | 'computed_return' | 'irs_transcript' | 'irs_notice' | 'other'
  tax_year: number | null
  source_filename?: string | null
  status: string
  coverage?: CatalogCoverage
  entries: CatalogEntry[]
}

export interface FactValue {
  value: unknown
  status: 'answered' | 'unknown' | 'not_applicable'
  source?: string
  recorded_at?: string
}

export interface FactView {
  get(key: string, opts?: { year?: number; subject?: string }): FactValue | undefined
}

export interface EntityInfo {
  id: string
  name: string
  form_type: FormType
  entity_type: string
  date_incorporated?: string | null
  meta?: Record<string, unknown>
}

export interface LinkedEntity {
  entity: EntityInfo
  /** k1_issuer: an S-corp/partnership whose K-1 this return reports;
   *  k1_recipient: an individual return reporting this entity's K-1 */
  relation: 'k1_issuer' | 'k1_recipient'
  /** Where the link is documented, e.g. "2024 Form 1040 Schedule E line 28 row A" */
  evidence: string
  catalogs: CatalogView[]
}

export type LinkKind = 'owns' | 'disregarded' | 'intercompany'
export type LinkNature = 'services' | 'loan' | 'rent' | 'settlement' | 'other'
export type LinkSource = 'owner' | 'filed_return' | 'fact' | 'entity_record'

/** One recorded relationship in the entity map (table entity_link; see
 *  services/entity_map.ts for the write path and review/map.ts for how
 *  evidence is read against it). */
export interface EntityLink {
  link_key: string
  kind: LinkKind
  /** owns: the owner's return; disregarded: the parent; intercompany: the side that pays or owes */
  from_entity_id: string
  to_entity_id: string | null
  /** A party with no return in this account */
  to_name: string | null
  /** owns from a joint 1040: which person holds the interest */
  subject: string | null
  pct: number | null
  nature: LinkNature | null
  from_year: number | null
  to_year: number | null
  source: LinkSource
  evidence: string | null
  detail: string | null
  /** A link recorded in error, retired (kept so the evidence is not re-suggested) */
  removed: boolean
}

export interface DocumentFact {
  id: string
  doc_type: string
  tax_year: number | null
  key_values: Record<string, unknown>
  summary?: string
}

export interface ReviewContext {
  entity: EntityInfo
  year: number
  /** Every current catalog of this entity, all years */
  catalogs: CatalogView[]
  linked: LinkedEntity[]
  facts: FactView
  /** Third-party source documents recorded for this entity (1099s, W-2s…) */
  documents: DocumentFact[]
  /** Fact gaps from the registry for this return type/year, when available */
  factGaps?: Array<{ key: string; question: string; status: string }>
  /** The account's entity map: recorded links (current versions, removed
   *  ones included), what the evidence suggests, and every entity with its
   *  catalogs. Absent when the caller did not load it. */
  map?: {
    links: EntityLink[]
    suggestions: import('./map.js').LinkSuggestion[]
    bundles: Array<{ entity: EntityInfo; catalogs: CatalogView[] }>
    /** Every entity's current facts, so a check can read the other side's answer */
    facts: Map<string, import('./map.js').FactLike[]>
  }
  today: Date
}

export interface Check {
  id: string
  version: number
  area: Area
  title: string
  applies: FormType[]
  kind: 'rule' | 'ai' | 'fact'
  /** A tie: one figure must agree with another (within a return, year to
   *  year, or across returns). Its findings are BREAKS, and the tie checks
   *  are what every version set is held to (review/versions.ts). */
  tie?: boolean
  /** What it tests and why — this text IS the framework documentation */
  description: string
  run(ctx: ReviewContext): CheckResult[] | Promise<CheckResult[]>
}
