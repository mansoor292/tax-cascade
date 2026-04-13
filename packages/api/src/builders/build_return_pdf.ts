/**
 * Build a complete filled PDF return package.
 *
 * Refactored from the tested build_1120_package.ts / build_1120s_package.ts.
 * Takes textract data + entity + return data → produces a full multi-form package.
 *
 * For 1120: Main form + 1125-A (COGS) + Schedule G + 4562 + statements
 * For 1120S: Main form + K-1s
 * For 1040: Main form + schedules
 */
import { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { mapToCanonical, type TextractOutput } from '../intake/json_model_mapper.js'
import { calc1120, calc1120S, calc1040 } from '../engine/tax_engine.js'
import { getEngineToCanonicalMap } from '../maps/engine_to_pdf.js'
import * as maps2024 from '../maps/pdf_field_map_2024.js'
import * as maps2025 from '../maps/pdf_field_map_2025.js'

// ─── Helpers (same as tested builders) ───

function findField(form: ReturnType<PDFDocument['getForm']>, shortId: string): PDFTextField | null {
  for (const f of form.getFields())
    if (f.getName().includes(shortId + '[') && f instanceof PDFTextField) return f
  return null
}

function setField(form: ReturnType<PDFDocument['getForm']>, shortId: string, value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  const field = findField(form, shortId)
  if (!field) return false
  const str = typeof value === 'number' ? value.toLocaleString() : String(value)
  const maxLen = field.getMaxLength()
  if (maxLen !== undefined && str.length > maxLen) field.setMaxLength(str.length)
  field.setText(str)
  return true
}

function parseBSVal(s: string): number {
  if (!s) return 0
  const n = parseFloat(s.replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1').replace(/\.$/, ''))
  return isNaN(n) ? 0 : Math.round(Math.abs(n))
}

function getFieldMap(formType: string, year: number): Record<string, string> {
  const mapKey = `F${formType.replace('-', '')}_${year}`
  return (maps2025 as any)[mapKey] || (maps2024 as any)[mapKey] || {}
}

function loadForm(formName: string, year: number): string | null {
  // Try exact year, then fall back to nearby years
  for (const y of [year, 2025, 2024]) {
    const path = `data/irs_forms/${formName}_${y}.pdf`
    if (existsSync(path)) return path
  }
  return null
}

// ─── Types ───

export interface EntityData {
  name: string
  ein: string
  address: string
  city: string
  state: string
  zip: string
  date_incorporated?: string
  meta?: Record<string, any>
}

export interface BuildPdfInput {
  formType: string
  taxYear: number
  entity: EntityData
  // Engine input/output
  inputData?: Record<string, any>
  computedData?: Record<string, any>
  // Textract-extracted canonical field values
  fieldValues?: Record<string, any>
  // Raw textract KV pairs (for Schedule L table extraction)
  textractKvs?: Array<{ key: string; value: string }>
  // Optional overrides
  overrides?: Record<string, string | number>
}

export interface BuildPdfResult {
  pdf: PDFDocument
  filled: number
  pages: number
  forms: string[]
}

// ─── Build canonical model ───

function buildModel(input: BuildPdfInput): Record<string, string | number> {
  const model: Record<string, string | number> = {}
  const engineMap = getEngineToCanonicalMap(input.formType)

  // 1. Map engine inputs → canonical keys
  if (input.inputData) {
    for (const [key, value] of Object.entries(input.inputData)) {
      if (value === undefined || value === null) continue
      const canon = engineMap[key]
      if (canon) model[canon] = value
    }
  }

  // 2. Map engine computed → canonical keys
  if (input.computedData) {
    for (const [key, value] of Object.entries(input.computedData)) {
      if (value === undefined || value === null) continue
      const canon = engineMap[key]
      if (canon) model[canon] = value
    }
  }

  // 3. field_values override (already canonical-keyed from Textract extraction)
  if (input.fieldValues) {
    for (const [key, value] of Object.entries(input.fieldValues)) {
      if (value !== undefined && value !== null) model[key] = value
    }
  }

  // 4. Entity metadata
  const e = input.entity
  model['meta.entity_name'] = e.name || ''
  model['meta.ein'] = e.ein || ''
  model['meta.address'] = e.address || ''
  if (e.city || e.state || e.zip)
    model['meta.city_state_zip'] = [e.city, e.state, e.zip].filter(Boolean).join(', ')
  if (e.date_incorporated) model['meta.date_incorporated'] = e.date_incorporated
  if (e.meta?.business_activity) model['meta.business_activity'] = e.meta.business_activity
  if (e.meta?.product_service) model['meta.product_service'] = e.meta.product_service
  if (e.meta?.business_code) model['meta.business_activity_code'] = e.meta.business_code
  if (e.meta?.s_election_date) model['meta.s_election_date'] = e.meta.s_election_date

  // 5. Overrides
  if (input.overrides) {
    for (const [k, v] of Object.entries(input.overrides)) model[k] = v
  }

  return model
}

// ─── Extract Schedule L from Textract KVs ───

function extractScheduleL(kvs: Array<{ key: string; value: string }>, model: Record<string, string | number>) {
  // Schedule L is typically in table format — look for balance sheet KV patterns
  const schedLPatterns: Array<[RegExp, string]> = [
    [/^1\s.*cash/i, 'schedL.L1_cash'],
    [/^2a\s.*trade/i, 'schedL.L2a_trade'],
    [/^6\s.*other\s*current/i, 'schedL.L6_othercurr'],
    [/^7\s.*loans/i, 'schedL.L7_loans'],
    [/^10a\s/i, 'schedL.L10a_bldg'],
    [/^14\s.*other/i, 'schedL.L14_other'],
    [/^15\s.*total\s*assets/i, 'schedL.L15_total'],
    [/^17\s.*mortgage/i, 'schedL.L17_mortshort'],
    [/^20\s.*long.*term/i, 'schedL.L20_mortlong'],
    [/^23\s.*capital\s*stock/i, 'schedL.L23_paidin'],
    [/^25\s.*retained/i, 'schedL.L25_retained'],
    [/^28\s.*total.*liab/i, 'schedL.L28_total'],
  ]

  for (const kv of kvs) {
    for (const [pattern, prefix] of schedLPatterns) {
      if (pattern.test(kv.key)) {
        const val = parseBSVal(kv.value)
        if (val) {
          // Try to determine BOY vs EOY from context
          if (kv.key.toLowerCase().includes('begin') || kv.key.includes('(b)'))
            model[`${prefix}_boy_b`] = val
          else if (kv.key.toLowerCase().includes('end') || kv.key.includes('(d)'))
            model[`${prefix}_eoy_d`] = val
          else
            model[`${prefix}_eoy_d`] = val  // default to EOY
        }
      }
    }
  }
}

// ─── Fill a single PDF form from model ───

async function fillForm(
  formName: string, year: number, formType: string,
  model: Record<string, string | number>,
): Promise<{ pdf: PDFDocument; filled: number } | null> {
  const path = loadForm(formName, year)
  if (!path) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()
  const fieldMap = getFieldMap(formType, year)

  let filled = 0
  for (const [canonKey, value] of Object.entries(model)) {
    if (value === undefined || value === null || value === '') continue
    const fieldId = fieldMap[canonKey]
    if (!fieldId) continue
    if (setField(form, fieldId, value)) filled++
  }

  return { pdf, filled }
}

// ─── Fill 1125-A (COGS) ───

async function fill1125A(
  year: number, entity: EntityData, model: Record<string, string | number>,
): Promise<PDFDocument | null> {
  const path = loadForm('f1125a', year)
  if (!path) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()

  setField(form, 'f1_1', entity.name)
  setField(form, 'f1_2', entity.ein)
  setField(form, 'f1_7', model['cogs.L3_labor'])
  setField(form, 'f1_11', model['cogs.L5_other'])
  setField(form, 'f1_13', model['cogs.L6_total'])
  setField(form, 'f1_17', model['cogs.L8_cogs'])

  return pdf
}

// ─── Fill Schedule G (Ownership) ───

async function fillScheduleG(
  year: number, entity: EntityData,
): Promise<PDFDocument | null> {
  const path = loadForm('f1120sg', year)
  if (!path) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()

  setField(form, 'f1_1_0_', entity.name)
  setField(form, 'f1_3_0_', entity.ein)

  return pdf
}

// ─── Fill 4562 (Depreciation) ───

async function fill4562(
  year: number, entity: EntityData, model: Record<string, string | number>,
): Promise<PDFDocument | null> {
  const path = loadForm('f4562', year)
  if (!path) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()

  setField(form, 'f1_1', entity.name)
  setField(form, 'f1_2', `Form ${entity.meta?.form_type || '1120'} ${entity.meta?.business_activity || ''}`.trim())
  setField(form, 'f1_3', entity.ein)
  setField(form, 'f1_22', model['dep.L17_macrs_prior'])
  setField(form, 'f1_25', model['dep.L22_total'])
  setField(form, 'f2_57', model['dep.L43_amortization'])
  setField(form, 'f2_58', model['dep.L44_total_amort'])

  return pdf
}

// ─── Generate statement pages ───

async function generateStatements(
  entity: EntityData, year: number, model: Record<string, string | number>,
): Promise<PDFDocument | null> {
  // Only generate if we have other deductions or COGS detail
  const hasData = model['deductions.L26_other_deductions'] || model['cogs.L5_other']
  if (!hasData) return null

  const stmtPdf = await PDFDocument.create()
  const font = await stmtPdf.embedFont(StandardFonts.Courier)
  const boldFont = await stmtPdf.embedFont(StandardFonts.CourierBold)

  function addPage(title: string, detail: string): PDFPage {
    const page = stmtPdf.addPage([612, 792])
    let y = 740
    const draw = (text: string, x: number, yy: number, f: PDFFont = font, size = 10) =>
      page.drawText(text, { x, y: yy, font: f, size, color: rgb(0, 0, 0) })

    draw(entity.name, 50, y, boldFont, 12); y -= 15
    draw(`EIN: ${entity.ein}`, 50, y); y -= 15
    draw(`Tax Year ${year}`, 50, y); y -= 25
    draw(title, 50, y, boldFont, 11); y -= 20
    draw('-'.repeat(65), 50, y); y -= 15
    draw(detail, 60, y); y -= 15
    draw('-'.repeat(65), 50, y)
    return page
  }

  if (model['deductions.L26_other_deductions']) {
    addPage(
      'Form 1120, Line 26 — Other Deductions',
      `Total Other Deductions: ${Number(model['deductions.L26_other_deductions']).toLocaleString()}`
    )
  }

  if (model['cogs.L5_other']) {
    addPage(
      'Form 1125-A, Line 5 — Other Costs (COGS)',
      `Total Other Costs: ${Number(model['cogs.L5_other']).toLocaleString()}`
    )
  }

  return stmtPdf.getPageCount() > 0 ? stmtPdf : null
}

// ─── Main entry point ───

export async function buildReturnPdf(input: BuildPdfInput): Promise<BuildPdfResult> {
  const { formType, taxYear, entity } = input
  const model = buildModel(input)

  // Extract Schedule L from raw Textract KVs if available
  if (input.textractKvs) {
    extractScheduleL(input.textractKvs, model)
  }

  const formName = formType === '1120S' ? 'f1120s' : `f${formType.toLowerCase()}`
  const forms: string[] = []

  // 1. Fill main form
  const main = await fillForm(formName, taxYear, formType, model)
  if (!main) throw new Error(`No blank PDF for ${formName} ${taxYear}`)
  forms.push(`Form ${formType}`)

  // 2. Check Schedule K checkboxes (1120 only)
  if (formType === '1120') {
    const mainForm = main.pdf.getForm()
    for (const f of mainForm.getFields()) {
      if (!(f instanceof PDFCheckBox)) continue
      const name = f.getName()
      // Accrual method
      if (name.includes('c4_1[1]')) f.check()
    }
  }

  // 3. Build package with supporting forms
  const merged = await PDFDocument.create()

  async function append(src: PDFDocument, label?: string) {
    const pages = await merged.copyPages(src, src.getPageIndices())
    pages.forEach(p => merged.addPage(p))
    if (label) forms.push(label)
  }

  await append(main.pdf)
  let totalFilled = main.filled

  if (formType === '1120' || formType === '1120S') {
    // 1125-A (COGS)
    if (model['cogs.L8_cogs'] || model['income.L2_cogs']) {
      const cogs = await fill1125A(taxYear, entity, model)
      if (cogs) await append(cogs, 'Form 1125-A')
    }

    // Schedule G (ownership) — 1120 only
    if (formType === '1120') {
      const sg = await fillScheduleG(taxYear, entity)
      if (sg) await append(sg, 'Schedule G')
    }

    // 4562 (depreciation)
    if (model['dep.L22_total'] || model['deductions.L20_depreciation']) {
      const dep = await fill4562(taxYear, entity, model)
      if (dep) await append(dep, 'Form 4562')
    }

    // Statement pages
    const stmts = await generateStatements(entity, taxYear, model)
    if (stmts) await append(stmts, 'Statements')
  }

  return {
    pdf: merged,
    filled: totalFilled,
    pages: merged.getPageCount(),
    forms,
  }
}

// Re-export for backwards compat
export { buildModel as buildCanonicalModel }
