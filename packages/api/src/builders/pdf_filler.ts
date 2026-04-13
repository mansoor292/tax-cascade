/**
 * PDF Filler — Deterministic field fill utility
 *
 * Takes a canonical model (Record<string, value>) and a field map
 * (Record<canonicalKey, fieldId>), fills the PDF. No fuzzy logic.
 */

import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib'
import { readFileSync } from 'fs'

/**
 * Find a text field by its short ID (e.g. "f1_14")
 */
export function findTextField(form: ReturnType<PDFDocument['getForm']>, shortId: string): PDFTextField | null {
  for (const f of form.getFields()) {
    if (f.getName().includes(shortId + '[') && f instanceof PDFTextField) return f
  }
  return null
}

/**
 * Set a text field value. Handles maxLength constraints and number formatting.
 */
export function setField(form: ReturnType<PDFDocument['getForm']>, shortId: string, value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  const field = findTextField(form, shortId)
  if (!field) return false

  const str = typeof value === 'number'
    ? value.toLocaleString()
    : String(value)
  if (str === '') return false

  const maxLen = field.getMaxLength()
  if (maxLen !== undefined && str.length > maxLen) {
    field.setMaxLength(str.length)
  }
  field.setText(str)
  return true
}

/**
 * Check a checkbox by short ID pattern.
 */
export function checkBox(form: ReturnType<PDFDocument['getForm']>, pattern: string): boolean {
  for (const f of form.getFields()) {
    if (f.getName().includes(pattern) && f instanceof PDFCheckBox) {
      f.check()
      return true
    }
  }
  return false
}

/**
 * Fill a PDF from a canonical model using a deterministic field map.
 * Returns the number of fields filled.
 */
export function fillFromMap(
  form: ReturnType<PDFDocument['getForm']>,
  fieldMap: Record<string, string>,
  data: Record<string, string | number>
): { filled: number; missed: string[] } {
  let filled = 0
  const missed: string[] = []

  for (const [canonicalKey, value] of Object.entries(data)) {
    const fieldId = fieldMap[canonicalKey]
    if (!fieldId) {
      missed.push(canonicalKey)
      continue
    }
    if (setField(form, fieldId, value)) {
      filled++
    }
  }

  return { filled, missed }
}

/**
 * Load a blank IRS form PDF.
 */
export async function loadBlankForm(formName: string, year: number): Promise<PDFDocument> {
  const path = `tax-api/data/irs_forms/${formName}_${year}.pdf`
  return PDFDocument.load(readFileSync(path))
}

/**
 * Merge multiple PDFs into one package.
 */
export async function mergePDFs(pdfs: PDFDocument[]): Promise<PDFDocument> {
  const merged = await PDFDocument.create()
  for (const src of pdfs) {
    const pages = await merged.copyPages(src, src.getPageIndices())
    pages.forEach(p => merged.addPage(p))
  }
  return merged
}
