/**
 * Small AcroForm helpers for the attachment builders in this directory.
 *
 * Why not pdf_filler.setField: it formats numbers with toLocaleString(), which
 * prints QuickBooks cents ("105,067.11") on forms filed in whole dollars, and
 * its checkBox() matches by substring, so 'c1_1' also ticks c1_10..c1_19.
 * These helpers round money once at print time (amounts are added with cents
 * and only the result is rounded, per the IRS instructions), and address a
 * checkbox by its exact widget name.
 */
import { PDFDocument, PDFTextField, PDFCheckBox, PDFName, PDFArray, PDFDict } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'

export type AcroForm = ReturnType<PDFDocument['getForm']>

/** Whole dollars with thousands separators; never "-0". */
export function money(value: number): string {
  const r = Math.round(value)
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US')
}

/**
 * Load a blank whose field IDs a builder verified for exactly `verifiedYear`.
 * Any other year returns null — writing one year's IDs into another year's
 * layout puts every value on the wrong line (see resolveFormYear).
 */
export async function loadVerifiedBlank(
  formName: string, taxYear: number, verifiedYear: number, dir = 'data/irs_forms',
): Promise<PDFDocument | null> {
  if (taxYear !== verifiedYear) return null
  const path = `${dir}/${formName}_${verifiedYear}.pdf`
  if (!existsSync(path)) return null
  return PDFDocument.load(readFileSync(path))
}

function textField(form: AcroForm, shortId: string): PDFTextField | null {
  for (const f of form.getFields()) {
    if (f instanceof PDFTextField && f.getName().endsWith(`.${shortId}[0]`)) return f
  }
  return null
}

/**
 * Set a text field. Numbers print as whole-dollar money; zero IS written.
 * null/undefined/'' are skipped. Returns whether a field was written.
 */
export function put(form: AcroForm, shortId: string, value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  const field = textField(form, shortId)
  if (!field) return false
  const str = typeof value === 'number' ? money(value) : String(value)
  const max = field.getMaxLength()
  if (max !== undefined && str.length > max) field.setMaxLength(str.length)
  field.setText(str)
  return true
}

/** Tick the checkbox whose widget name ends in `.${name}` (e.g. 'c1_1[1]'). */
export function tick(form: AcroForm, name: string): boolean {
  for (const f of form.getFields()) {
    if (f instanceof PDFCheckBox && f.getName().endsWith(`.${name}`)) { f.check(); return true }
  }
  return false
}

/** Uncheck every widget of a checkbox group (e.g. 'c4_1' → c4_1[0..n]). */
export function clearGroup(form: AcroForm, prefix: string): void {
  for (const f of form.getFields()) {
    if (f instanceof PDFCheckBox && new RegExp(`\\.${prefix}\\[\\d+\\]$`).test(f.getName())) f.uncheck()
  }
}

/**
 * Drop the instruction pages a blank carries after the form itself (1125-A
 * pages 2-3, Schedule G page 2). Form pages always carry fields, instruction
 * pages never do (they may carry web links, so it is WIDGET annotations that
 * count). Filed packages attach the form pages only.
 */
export function dropInstructionPages(pdf: PDFDocument): PDFDocument {
  for (let i = pdf.getPageCount() - 1; i >= 0 && pdf.getPageCount() > 1; i--) {
    const annots = pdf.getPage(i).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    let widgets = 0
    for (let j = 0; j < (annots?.size() ?? 0); j++) {
      const a = annots!.lookupMaybe(j, PDFDict)
      if (a?.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) widgets++
    }
    if (widgets === 0) pdf.removePage(i)
  }
  // pdf-lib's removePage does not invalidate the cache behind getPages()
  // (only insertPage does), so without this getPages() keeps returning the
  // removed pages while getPageIndices() does not.
  ;(pdf as unknown as { pageCache?: { invalidate?: () => void } }).pageCache?.invalidate?.()
  return pdf
}

/** A finite number, or 0. */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** True for a full SSN/EIN (9 digits); a masked or partial identifier must never print on a return. */
export function printableId(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return /^\d{3}-?\d{2}-?\d{4}$|^\d{2}-?\d{7}$/.test(s) ? s : null
}
