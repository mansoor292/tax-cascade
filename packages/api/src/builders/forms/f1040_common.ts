/**
 * Shared machinery for the Form 1040 attachments (Schedules 1-3, B, D, E,
 * 8812, 7203, 8995-A, 8959, 8960, 1040-V).
 *
 * Why: the 1040 package printed Form 1040 and nothing else. Every schedule's
 * figures were already computed and stored (sched1.*, schedD.*, f8960.*, ...)
 * and none of them reached paper, so the filed 2025 joint return — 42 pages
 * from outside software — had nothing on our side to compare against except
 * its first two pages. Each form here is a small declarative spec: which
 * stored line goes in which box. The box IDs were read off the 2025 blanks
 * and confirmed by geometry against the filed return (scripts/parity/): a
 * value in the wrong box fails that test in two places.
 *
 * Every spec is for the 2025 blank ONLY. Widget numbering moves between
 * years, so a spec refuses any other year rather than writing 2025 IDs into
 * another year's layout (see resolveFormYear in build_return_pdf.ts).
 */
import { PDFDocument, PDFTextField, PDFCheckBox, type PDFForm } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import type { AttachmentContext, Attachment, AttachmentBuilder } from './types.js'

export const SPEC_YEAR = 2025

export type Value = string | number | null | undefined
export type FieldSource = string | ((c: AttachmentContext) => Value)

export interface FormSpec {
  /** Blank file stem under data/irs_forms, e.g. 'f1040s1'. */
  form: string
  label: string
  /** IRS attachment sequence number. */
  seq: number
  /** Whether the return needs this form at all. */
  when: (c: AttachmentContext) => boolean
  /** Name / identifying-number boxes of the form's header; omitted for forms that have none. */
  header?: { name: string; ssn: string; who?: 'primary' | 'spouse' }
  /** box id → canonical key in the model, or a function of the context. */
  fields: Record<string, FieldSource>
  /** Boxes printed inside the form's own parentheses: the magnitude only. */
  magnitude?: string[]
  /** Checkbox field-name suffixes to tick. */
  checks?: (c: AttachmentContext) => string[]
}

/** Whole dollars, thousands separated, minus sign for negatives ("-3,000"). */
export function money(v: number): string {
  const r = Math.round(v)
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US')
}

export const num = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(x) ? x : 0
}

/** A stored line from the model, as a number (0 when absent). */
export const line = (c: AttachmentContext, key: string): number => num(c.model[key])

/** True when the model carries a non-zero value under any of the keys. */
export const any = (c: AttachmentContext, ...keys: string[]) => keys.some(k => num(c.model[k]) !== 0)

/** Identifying numbers print digits-only: the 2025 SSN/EIN boxes are comb fields. */
export const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')

/**
 * "Name(s) shown on return". Joint returns print both names; a caller can
 * state the exact wording per form (input_data.form_header_names[form]) when
 * a filed return used a different one, e.g. only the primary name on 8959.
 */
export function headerName(c: AttachmentContext, form: string, who: 'primary' | 'spouse' | 'joint' = 'joint'): string {
  const override = c.inputData?.form_header_names?.[form]
  if (override) return String(override)
  const m = c.entity.meta || {}
  const me = [m.first_name, m.last_name].filter(Boolean).join(' ')
  const sp = [m.spouse_first, m.spouse_last].filter(Boolean).join(' ')
  if (who === 'spouse') return sp || c.entity.name
  if (who === 'primary') return me || c.entity.name
  if (me && sp) return `${me} & ${sp}`
  return me || c.entity.name
}

/** The SSN printed in a header: the primary filer's (entity.ein on a 1040) or the spouse's. */
export function headerSsn(c: AttachmentContext, who: 'primary' | 'spouse' = 'primary'): string {
  return digits(who === 'spouse' ? c.entity.meta?.spouse_ssn : c.entity.ein)
}

function findText(form: PDFForm, id: string): PDFTextField | null {
  for (const f of form.getFields())
    if (f instanceof PDFTextField && f.getName().endsWith(`.${id}[0]`)) return f
  return null
}

export function setText(form: PDFForm, id: string, value: Value): boolean {
  if (value === null || value === undefined || value === '') return false
  const f = findText(form, id)
  if (!f) return false
  const s = typeof value === 'number' ? money(value) : String(value)
  const max = f.getMaxLength()
  if (max !== undefined && s.length > max) f.setMaxLength(s.length)
  // pdf-lib clips text wider than the box rather than shrinking it, so
  // "See Statement - Sch 1 (1040) - 8z" printed as "See Statement - ". Size
  // long text to the box (Helvetica averages about half an em per character).
  if (typeof value === 'string' && f.isCombed() === false) {
    const width = f.acroField.getWidgets()[0]?.getRectangle().width ?? 0
    const fits = (width - 4) / (s.length * 0.5)
    if (width && fits < 10) f.setFontSize(Math.max(5, Math.floor(fits)))
  }
  f.setText(s)
  return true
}

/** Tick the checkbox whose full name ends with `suffix` (e.g. 'c1_1[1]' or 'ReadOrder[0].c1_8[1]'). */
export function check(form: PDFForm, suffix: string): boolean {
  for (const f of form.getFields()) {
    if (f instanceof PDFCheckBox && f.getName().endsWith(`.${suffix}`)) {
      f.check()
      return true
    }
  }
  return false
}

export function blankPath(form: string, year: number): string | null {
  if (year !== SPEC_YEAR) return null
  const p = `data/irs_forms/${form}_${year}.pdf`
  return existsSync(p) ? p : null
}

/** Turn a spec into an attachment builder. */
export function specBuilder(spec: FormSpec): AttachmentBuilder {
  return async (c: AttachmentContext): Promise<Attachment | null> => {
    if (c.formType !== '1040') return null
    const path = blankPath(spec.form, c.taxYear)
    if (!path || !spec.when(c)) return null
    const pdf = await PDFDocument.load(readFileSync(path))
    const form = pdf.getForm()
    let filled = 0
    if (spec.header) {
      const who = spec.header.who ?? 'primary'
      if (setText(form, spec.header.name, headerName(c, spec.form, who === 'spouse' ? 'spouse' : 'joint'))) filled++
      if (setText(form, spec.header.ssn, headerSsn(c, who))) filled++
    }
    const mag = new Set(spec.magnitude || [])
    for (const [id, src] of Object.entries(spec.fields)) {
      let v: Value = typeof src === 'function' ? src(c) : (c.model[src] as Value)
      if (typeof v === 'number' && mag.has(id)) v = Math.abs(v)
      if (setText(form, id, v)) filled++
    }
    for (const s of spec.checks?.(c) || []) if (check(form, s)) filled++
    return { seq: spec.seq, label: spec.label, pdf, filled }
  }
}
