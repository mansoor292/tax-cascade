/**
 * Build a filled PDF return from a canonical model + entity data.
 *
 * Reuses the same fill logic as the tested builders (build_1120_package, etc.)
 * but takes a model + entity as input instead of reading from Textract files.
 *
 * Returns the filled PDFDocument and fill count.
 */
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { getEngineToCanonicalMap } from '../maps/engine_to_pdf.js'
import * as maps2024 from '../maps/pdf_field_map_2024.js'
import * as maps2025 from '../maps/pdf_field_map_2025.js'

function findField(form: ReturnType<PDFDocument['getForm']>, shortId: string): PDFTextField | null {
  for (const f of form.getFields())
    if (f.getName().includes(shortId + '[') && f instanceof PDFTextField) return f
  return null
}

function setField(form: ReturnType<PDFDocument['getForm']>, shortId: string, value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  const field = findField(form, shortId)
  if (!field) return false
  const str = typeof value === 'number'
    ? (value === 0 ? '' : value.toLocaleString()) : String(value)
  if (!str) return false
  const maxLen = field.getMaxLength()
  if (maxLen !== undefined && str.length > maxLen) field.setMaxLength(str.length)
  field.setText(str)
  return true
}

interface EntityData {
  name: string
  ein: string
  address: string
  city: string
  state: string
  zip: string
  date_incorporated?: string
  meta?: Record<string, any>
}

/**
 * Build a canonical model from engine inputs/outputs + entity data.
 * This is the same model the tested builders construct.
 */
export function buildCanonicalModel(
  formType: string,
  inputData: Record<string, any>,
  computedData: Record<string, any>,
  entity: EntityData,
  fieldValues?: Record<string, any>,
): Record<string, string | number> {
  const model: Record<string, string | number> = {}
  const engineMap = getEngineToCanonicalMap(formType)

  // Map engine input keys → canonical keys
  for (const [key, value] of Object.entries(inputData)) {
    if (value === undefined || value === null) continue
    const canon = engineMap[key]
    if (canon) model[canon] = value
  }

  // Map engine computed keys → canonical keys
  for (const [key, value] of Object.entries(computedData)) {
    if (value === undefined || value === null) continue
    const canon = engineMap[key]
    if (canon) model[canon] = value
  }

  // Add field_values directly (already canonical-keyed from extracted returns)
  if (fieldValues) {
    for (const [key, value] of Object.entries(fieldValues)) {
      if (value !== undefined && value !== null) model[key] = value
    }
  }

  // Entity metadata
  model['meta.entity_name'] = entity.name || ''
  model['meta.ein'] = entity.ein || ''
  model['meta.address'] = entity.address || ''
  if (entity.city || entity.state || entity.zip)
    model['meta.city_state_zip'] = [entity.city, entity.state, entity.zip].filter(Boolean).join(', ')
  if (entity.date_incorporated) model['meta.date_incorporated'] = entity.date_incorporated
  if (entity.meta?.business_activity) model['meta.business_activity'] = entity.meta.business_activity
  if (entity.meta?.product_service) model['meta.product_service'] = entity.meta.product_service
  if (entity.meta?.business_code) model['meta.business_activity_code'] = entity.meta.business_code
  if (entity.meta?.s_election_date) model['meta.s_election_date'] = entity.meta.s_election_date

  return model
}

/**
 * Fill a PDF from a canonical model using the appropriate year's field map.
 * Same fill logic as the tested builders.
 */
export async function buildReturnPdf(
  formType: string,
  taxYear: number,
  model: Record<string, string | number>,
): Promise<{ pdf: PDFDocument; filled: number; missed: string[] }> {

  // Resolve blank form path
  const formName = formType === '1120S' ? 'f1120s' : `f${formType.toLowerCase()}`
  const blankPath = `data/irs_forms/${formName}_${taxYear}.pdf`
  if (!existsSync(blankPath)) {
    throw new Error(`No blank PDF for ${formName} ${taxYear}`)
  }

  const pdf = await PDFDocument.load(readFileSync(blankPath))
  const form = pdf.getForm()

  // Get year-specific field map (same maps the tested builders use)
  const mapKey = `F${formType.replace('-', '')}_${taxYear}`
  const fieldMap: Record<string, string> =
    (maps2025 as any)[mapKey] || (maps2024 as any)[mapKey] || {}

  if (!Object.keys(fieldMap).length) {
    throw new Error(`No field map for ${formType} ${taxYear} (looked for ${mapKey})`)
  }

  // Fill: canonical key → field ID → set text
  let filled = 0
  const missed: string[] = []
  for (const [canonKey, value] of Object.entries(model)) {
    if (value === undefined || value === null || value === '' || value === 0) continue
    const fieldId = fieldMap[canonKey]
    if (!fieldId) {
      missed.push(canonKey)
      continue
    }
    if (setField(form, fieldId, value)) filled++
  }

  return { pdf, filled, missed }
}
