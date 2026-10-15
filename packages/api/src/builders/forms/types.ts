/**
 * Attachment builders — the extension point for forms that ride along with a
 * return package (schedules, supporting forms, statements, state returns).
 *
 * Why a registry: build_return_pdf.ts grew one hand-wired `if` per attachment
 * and every new form meant editing the same function. The 2026-10-15 parity
 * sprint (filed 2025 returns as the test, see scripts/parity/) adds two dozen
 * forms across four parallel workstreams; a registry per return family keeps
 * each form in its own file and lets the package builder stay a loop.
 *
 * Contract for a builder:
 *  - Return null (or []) when the return has nothing for the form. Never emit
 *    an empty form "for completeness".
 *  - Field IDs are verified against ONE year's blank. Refuse any other year
 *    (return null) rather than writing those IDs into another year's layout —
 *    see resolveFormYear in build_return_pdf.ts for why that matters.
 *  - `seq` is the IRS attachment sequence number printed in the form's
 *    header (Schedule D = 12, Form 8995-A = 55A → 55.1, ...). State returns
 *    use 1000+. The package is sorted by it after the main form.
 */
import type { PDFDocument } from 'pdf-lib'
import type { EntityData } from '../build_return_pdf.js'

export interface AttachmentContext {
  formType: string
  taxYear: number
  entity: EntityData
  /** Canonical model the main form was filled from (field values + aliases + entity meta). */
  model: Record<string, string | number>
  /** The return's saved input_data, including the `*_detail` itemizations. */
  inputData: Record<string, any>
  /** The return's saved computed_data. */
  computedData: Record<string, any>
}

export interface Attachment {
  seq: number
  label: string
  pdf: PDFDocument
  filled?: number
}

export type AttachmentBuilder = (ctx: AttachmentContext) => Promise<Attachment | Attachment[] | null>
