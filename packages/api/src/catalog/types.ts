/**
 * Return catalog — data contract.
 *
 * Why this exists (2026-10-17): for six months every question about a filed
 * return went back to its PDF, and each time a different slice of the PDF was
 * read. The filed-import mapper kept 10–40% of a return (no checkboxes, no
 * Schedule E passive/nonpassive columns, no K-1 Part II, no M-2, no statements),
 * so findings surfaced one at a time, months apart, depending on which question
 * was asked. The owner's rule since then: every box, check, statement row and
 * worksheet line of every page is stored here, and every question is answered
 * from the catalog. A question the catalog cannot answer is a catalog defect.
 *
 * See docs/RETURN_CATALOG_AND_REVIEW.md for the whole design.
 */

/** One widget of a blank IRS form, described by the IRS's own accessibility
 *  text (the XFA <speak> element). Built offline into data/line_dicts. */
export interface DictWidget {
  /** Full AcroForm name, e.g. topmostSubform[0].Page4[0].f4_5[0] */
  name: string
  /** 1-based page within the blank */
  page: number
  /** [x0, y0, x1, y1], top-left origin, points */
  rect: [number, number, number, number]
  kind: 'text' | 'check' | 'radio'
  /** Export value of a check/radio widget ("1", "2", "Yes"…), when known */
  export?: string
  /** The IRS's own description, whitespace-normalised, with "Page N." removed */
  desc: string
  /** Parsed location. Best effort: `line` may be '' for header boxes. */
  section: string
  line: string
  row?: string
  col?: string
  /** Short human label (the description without the line/row/column scaffolding) */
  label: string
  /** Canonical field_values key when the engine maps this widget */
  canonical?: string
}

export interface DictPage {
  page: number
  width: number
  height: number
  /** Form-number tokens printed in the page header (classification gate) */
  header: string[]
  /** Printed template text runs: [text, x0, y0, x1, y1], top-left origin */
  template: Array<[string, number, number, number, number]>
  /** Small drawn paths of the blank (box borders, rules) — subtracted so that
   *  only marks the filer's software drew remain */
  marks: Array<[number, number, number, number]>
}

export interface LineDict {
  /** Form slug as the IRS names its PDF: f1120s, f1040se, f1120ssk, f1125a … */
  form: string
  /** Human form name: "1120-S", "1040 Schedule E", "1120-S Schedule K-1" */
  title: string
  /** Revision: a tax year ("2024") or a revision date's year for forms the IRS
   *  revises irregularly (1125-A "2018", 1125-E "2016", Schedule G "2011"). */
  rev: string
  source: string
  pages: DictPage[]
  widgets: DictWidget[]
}

/** Where a catalogued value came from. */
export type ExtractMethod =
  | 'geometry'   // text assigned to a blank's widget by position
  | 'acroform'   // live form-field value read directly
  | 'mark'       // drawn check mark found inside a check widget
  | 'row'        // statement / worksheet text line
  | 'manual'

export interface CatalogEntry {
  /** Stable within a catalog: `${form}:${instance}:${widget short or row id}` */
  id: string
  form: string
  title: string
  rev: string
  /** '' for the first (or only) instance; 'copy2' for a duplicate printed copy;
   *  'k1:2', '8949:p2' … for repeated forms */
  instance: string
  page: number
  section: string
  line: string
  row?: string
  col?: string
  label: string
  /** Full official description (form widgets) or the statement's title (rows) */
  desc: string
  kind: 'amount' | 'text' | 'check' | 'row'
  /** Normalised value: number for amounts, true for a ticked box, string otherwise */
  value: number | string | boolean | null
  /** Exact text as printed */
  raw: string
  /** Statement rows: every amount on the line, in reading order */
  amounts?: number[]
  canonical?: string
  widget?: string
  /** Transcripts: transaction / as-of date (MM-DD-YYYY as printed), cycle, DLN */
  date?: string
  cycle?: string
  dln?: string
  method: ExtractMethod
  bbox?: [number, number, number, number]
}

export type PageKind =
  | 'form'        // matched to an IRS blank
  | 'statement'   // supporting statement / worksheet / state or vendor page, kept as rows
  | 'duplicate'   // a second printed copy of a form page already catalogued
  | 'transcript'  // an IRS transcript page, parsed into transactions/balances
  | 'blank'       // no text at all (scanned or empty) — a coverage defect unless waived

export interface CatalogPage {
  page: number
  kind: PageKind
  form?: string
  title?: string
  rev?: string
  blank_page?: number
  instance?: string
  /** Statement title (first lines), for statement pages */
  heading?: string
  /** Classification score (share of the blank's template text found) */
  score?: number
  /** Substitute form (software facsimile, not the official PDF): matched by
   *  text and aligned to the blank before values were read */
  aligned?: boolean
  entries: number
  /** Non-template text on a form page that landed in no widget.
   *  A complete catalog has none (or each is waived). */
  residue: Array<{ text: string; bbox: [number, number, number, number] }>
}

export interface CatalogCoverage {
  pages: number
  form_pages: number
  statement_pages: number
  duplicate_pages: number
  transcript_pages: number
  blank_pages: number
  entries: number
  residue_tokens: number
  /** Duplicate copies whose values disagree with the first copy */
  copy_conflicts: number
  /** Every page readable and every amount in a form body placed on a line */
  complete: boolean
  /** Blocking: what makes the catalog incomplete */
  problems: string[]
  /** Not blocking: forms kept as text rows for want of a blank, second
   *  copies that disagree, software notes */
  warnings: string[]
}

export interface Catalog {
  version: number
  extractor: string
  source: { filename: string; sha256: string; pages: number }
  tax_year?: number
  pages: CatalogPage[]
  entries: CatalogEntry[]
  coverage: CatalogCoverage
}
