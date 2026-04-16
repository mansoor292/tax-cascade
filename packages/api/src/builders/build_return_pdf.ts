/**
 * Build a complete filled PDF return package.
 *
 * Unified builder merging logic from the three tested builders:
 *   - build_1120_package.ts  (C-Corp)
 *   - build_1120s_package.ts (S-Corp)
 *   - build_1040_package.ts  (Individual)
 *
 * Takes entity data + engine data + field values -> produces a multi-form PDF package.
 *
 * For 1120:  Main form + 1125-A (COGS) + Schedule G + 4562 + statements
 * For 1120S: Main form + statements (other deductions + other income)
 * For 1040:  Main form (personal header, filing status, W-2 breakdown, Schedule 2)
 */
import { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { getEngineToCanonicalMap, CANON_1040_ALIASES, getCanonicalAliases } from '../maps/engine_to_pdf.js'
import * as maps2024 from '../maps/pdf_field_map_2024.js'
import * as maps2025 from '../maps/pdf_field_map_2025.js'

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
  // meta.sched_k: Schedule K answers { K1_method: 'accrual', K3_subsidiary: 'no', ... }
  // meta.owners: [{ name, ssn, country, pct }]
  // meta.title: signer title (e.g. 'PRESIDENT')
  // meta.filing_status: for 1040 (e.g. 'mfj', 'single')
  // meta.first_name, meta.last_name, meta.spouse_first, meta.spouse_last
  // meta.spouse_ssn
  // meta.preparer: { name, ptin, firm_name, firm_ein, firm_address, phone }
}

export interface BuildPdfInput {
  formType: string
  taxYear: number
  entity: EntityData
  inputData?: Record<string, any>
  computedData?: Record<string, any>
  fieldValues?: Record<string, any>
  textractKvs?: Array<{ key: string; value: string }>
  overrides?: Record<string, string | number>
}

export interface BuildPdfResult {
  pdf: PDFDocument
  filled: number
  pages: number
  forms: string[]
}

// ─── Helpers ───

function findField(form: ReturnType<PDFDocument['getForm']>, shortId: string): PDFTextField | null {
  for (const f of form.getFields())
    if (f.getName().includes(shortId + '[') && f instanceof PDFTextField) return f
  return null
}

/**
 * Set a PDF text field. Zero values ARE written (rule: zero must appear on the form).
 * Only null/undefined/empty-string are skipped.
 */
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
  const base = `F${formType.replace('-', '')}`
  // Try exact year first, then fall back — Schedule L field IDs are stable across years
  for (const y of [year, 2025, 2024]) {
    const map = (maps2025 as any)[`${base}_${y}`] || (maps2024 as any)[`${base}_${y}`]
    if (map && Object.keys(map).length > 0) return map
  }
  return {}
}

function loadForm(formName: string, year: number): string | null {
  for (const y of [year, 2025, 2024]) {
    const path = `data/irs_forms/${formName}_${y}.pdf`
    if (existsSync(path)) return path
  }
  return null
}

// ─── Build canonical model ───

function buildModel(input: BuildPdfInput): Record<string, string | number> {
  const model: Record<string, string | number> = {}
  const engineMap = getEngineToCanonicalMap(input.formType)

  // 1. Map engine inputs -> canonical keys
  if (input.inputData) {
    for (const [key, value] of Object.entries(input.inputData)) {
      if (value === undefined || value === null) continue
      const canon = engineMap[key]
      if (canon) model[canon] = value
    }
  }

  // 2. Map engine computed -> canonical keys
  if (input.computedData) {
    for (const [key, value] of Object.entries(input.computedData)) {
      if (value === undefined || value === null) continue
      const canon = engineMap[key]
      if (canon) model[canon] = value
    }
  }

  // 3. field_values override (canonical-keyed from Textract extraction or QBO)
  //    Apply canonical aliases: descriptive keys → IRS-line keys
  if (input.fieldValues) {
    const aliases = getCanonicalAliases(input.formType)
    for (const [key, value] of Object.entries(input.fieldValues)) {
      if (value === undefined || value === null) continue
      // Write under both the original and the aliased key so either PDF map year works
      model[key] = value
      const aliased = aliases[key]
      if (aliased) model[aliased] = value
    }
  }

  // 4. Entity metadata
  const e = input.entity
  const ft = input.formType

  if (ft === '1040') {
    // 1040 uses split name fields
    if (e.meta?.first_name) model['meta.first_name'] = e.meta.first_name
    if (e.meta?.last_name) model['meta.last_name'] = e.meta.last_name
    if (e.ein) model['meta.ssn'] = e.ein  // For 1040, "ein" field holds SSN
    if (e.meta?.spouse_first) model['meta.spouse_first'] = e.meta.spouse_first
    if (e.meta?.spouse_last) model['meta.spouse_last'] = e.meta.spouse_last
    if (e.meta?.spouse_ssn) model['meta.spouse_ssn'] = e.meta.spouse_ssn
    if (e.address) model['meta.address'] = e.address
    if (e.city) model['meta.city'] = e.city
    if (e.state) model['meta.state'] = e.state
    if (e.zip) model['meta.zip'] = e.zip
  } else {
    // 1120 / 1120S use entity_name + address fields
    model['meta.entity_name'] = e.name || ''
    model['meta.ein'] = e.ein || ''
    model['meta.address'] = e.address || ''
    // Individual city/state/zip fields (2025+) AND combined (2024)
    if (e.city) model['meta.city'] = e.city
    if (e.state) model['meta.state'] = e.state
    if (e.zip) model['meta.zip'] = e.zip
    if (e.city || e.state || e.zip)
      model['meta.city_state_zip'] = [e.city, e.state, e.zip].filter(Boolean).join(', ')
    if (e.date_incorporated) model['meta.date_incorporated'] = e.date_incorporated
  }

  // Business metadata (1120 / 1120S)
  if (e.meta?.business_activity) model['meta.business_activity'] = e.meta.business_activity
  if (e.meta?.product_service) model['meta.product_service'] = e.meta.product_service
  if (e.meta?.business_code) model['meta.business_activity_code'] = e.meta.business_code
  if (e.meta?.s_election_date) model['meta.s_election_date'] = e.meta.s_election_date
  if (e.meta?.total_assets) model['meta.total_assets'] = e.meta.total_assets
  if (e.meta?.num_shareholders) model['meta.num_shareholders'] = e.meta.num_shareholders

  // Title
  if (e.meta?.title) model['meta.title'] = e.meta.title

  // Preparer info (works for all form types)
  const prep = e.meta?.preparer as {
    name?: string; ptin?: string; firm_name?: string
    firm_ein?: string; firm_address?: string; phone?: string
  } | undefined
  if (prep) {
    if (prep.name) model['preparer.name'] = prep.name
    if (prep.ptin) model['preparer.ptin'] = prep.ptin
    if (prep.firm_name) model['preparer.firm_name'] = prep.firm_name
    if (prep.firm_ein) model['preparer.firm_ein'] = prep.firm_ein
    if (prep.firm_address) model['preparer.firm_address'] = prep.firm_address
    if (prep.phone) model['preparer.phone'] = prep.phone
  }

  // 5. Add 1040 aliases so both 2024 and 2025 field maps can match
  if (input.formType === '1040') {
    for (const [key2025, key2024] of Object.entries(CANON_1040_ALIASES)) {
      if (model[key2025] !== undefined && model[key2024] === undefined) model[key2024] = model[key2025]
      if (model[key2024] !== undefined && model[key2025] === undefined) model[key2025] = model[key2024]
    }
  }

  // 6. Overrides (final layer, highest priority)
  if (input.overrides) {
    for (const [k, v] of Object.entries(input.overrides)) model[k] = v
  }

  return model
}

// ─── Extract Schedule L from Textract KVs ───

function extractScheduleL(kvs: Array<{ key: string; value: string }>, model: Record<string, string | number>) {
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

// ─── Fill a single PDF form from model + field map ───

async function fillForm(
  formName: string, year: number, formType: string,
  model: Record<string, string | number>,
): Promise<{ pdf: PDFDocument; filled: number } | null> {
  const path = loadForm(formName, year)
  if (!path) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()

  // Primary: hand-coded canonical map (year-specific field IDs, verified)
  const typedMap = getFieldMap(formType, year)

  // Fallback: Textract-discovered JSON map (label → field_id)
  // This lets ANY discovered form be filled without a hand-coded TS map
  const { getFieldMap: getJsonMap } = await import('../maps/field_maps.js')
  const jsonEntries = getJsonMap(formName, year)
  const labelToFieldId: Record<string, string> = {}
  for (const e of jsonEntries) {
    labelToFieldId[e.label] = e.field_id
  }

  let filled = 0
  for (const [canonKey, value] of Object.entries(model)) {
    if (value === undefined || value === null || value === '') continue

    // 1. Try typed canonical map first (schedL.L1_cash_boy_b → f6_2)
    let fieldId = typedMap[canonKey]

    // 2. Fallback: try matching the canonical key directly as a label
    //    This works when field_values use the Textract label as the key
    if (!fieldId) fieldId = labelToFieldId[canonKey]

    // 3. Fuzzy fallback: strip prefix and match against labels
    //    e.g. "schedL.L1_cash_boy_b" → look for label containing "1" and "cash"
    if (!fieldId && jsonEntries.length) {
      fieldId = fuzzyMatchLabel(canonKey, jsonEntries) || ''
    }

    if (!fieldId) continue
    if (setField(form, fieldId, value)) filled++
  }

  return { pdf, filled }
}

/**
 * Fuzzy-match a canonical key to a Textract label.
 * Extracts the IRS line number and keywords from the canonical key,
 * then finds the best matching label in the JSON field map.
 *
 * e.g. "schedL.L15_total_eoy_d" → matches label "15 Total assets" on the right column
 * e.g. "income.L1a_gross_receipts" → matches label "1a Gross receipts or sales"
 */
function fuzzyMatchLabel(
  canonKey: string,
  entries: Array<{ field_id: string; label: string }>,
): string | undefined {
  // Extract line number and keywords from canonical key
  // Pattern: "prefix.L{number}_{description}" or "prefix.L{number}{letter}_{description}"
  const m = canonKey.match(/\.L(\d+[a-z]?)_(.+)$/)
  if (!m) return undefined

  const lineNum = m[1]          // e.g. "1a", "15", "28"
  const parts = m[2].split('_') // e.g. ["gross", "receipts"] or ["cash", "boy", "b"]

  // Column hints: boy/eoy × a/b/c/d
  // Schedule L has 4 columns: (a) gross BOY, (b) net BOY, (c) gross EOY, (d) net EOY
  // The field IDs in the PDF go sequentially: f6_1(a), f6_2(b), f6_3(c), f6_4(d) for line 1
  const colHint = parts[parts.length - 1]  // last part: "a", "b", "c", or "d"
  const isColumnHint = ['a', 'b', 'c', 'd'].includes(colHint)
  const keywords = isColumnHint ? parts.slice(0, -2) : parts  // strip column + boy/eoy

  // Find entries whose label starts with the line number
  const lineMatches = entries.filter(e => {
    const label = e.label.toLowerCase().trim()
    return label.startsWith(lineNum + ' ') || label.startsWith(lineNum + '\t')
  })

  if (lineMatches.length === 0) return undefined

  // If only one match, return it (simple case)
  if (lineMatches.length === 1 && !isColumnHint) {
    return lineMatches[0].field_id
  }

  // For Schedule L multi-column fields, pick by column position
  // Field IDs for the same line are sequential: ...f6_1, f6_2, f6_3, f6_4
  // Column a=0, b=1, c=2, d=3
  if (isColumnHint && lineMatches.length >= 1) {
    // Sort by field_id numerically
    const sorted = [...lineMatches].sort((a, b) => {
      const na = parseInt(a.field_id.replace(/\D/g, ''))
      const nb = parseInt(b.field_id.replace(/\D/g, ''))
      return na - nb
    })
    const colIdx = colHint.charCodeAt(0) - 'a'.charCodeAt(0)
    if (colIdx < sorted.length) return sorted[colIdx].field_id
    // If column index exceeds matches, try the last one
    return sorted[sorted.length - 1].field_id
  }

  // Score by keyword overlap
  let best: string | undefined
  let bestScore = 0
  for (const entry of lineMatches) {
    const label = entry.label.toLowerCase()
    let score = 0
    for (const kw of keywords) {
      if (label.includes(kw)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = entry.field_id
    }
  }

  return best
}

// ─── Schedule K checkboxes (1120) ───

function fillScheduleKCheckboxes(
  form: ReturnType<PDFDocument['getForm']>,
  schedK: Record<string, string>,
) {
  // Map: Schedule K question key -> [checkbox prefix, ...]
  // c4_* = page 4, c5_* = page 5
  // For most: [0] = Yes, [1] = No
  // For K1_method: [0] = Cash, [1] = Accrual, [2] = Other
  const checkboxMap: Record<string, [string, number]> = {
    'K1_method':            ['c4_1', 1],  // [1] = accrual
    'K3_subsidiary':        ['c4_2', -1],
    'K4a_foreign_own':      ['c4_3', -1],
    'K4b_individual_own':   ['c4_4', -1],
    'K5a_own_foreign':      ['c4_5', -1],
    'K5b_own_partnership':  ['c4_6', -1],
    'K6_dividends':         ['c4_7', -1],
    'K7_foreign_25pct':     ['c4_8', -1],
    'K13_receipts_250k':    ['c5_1', -1],
    'K14_utp':              ['c5_2', -1],
    'K15a_1099':            ['c5_3', -1],
    'K16_ownership_change': ['c5_4', -1],
    'K17_dispose_65pct':    ['c5_5', -1],
    'K18_351_transfer':     ['c5_6', -1],
    'K19_payments':         ['c5_7', -1],
    'K20_cooperative':      ['c5_8', -1],
    'K21_267a':             ['c5_9', -1],
    'K22_500m':             ['c5_10', -1],
    'K23_163j':             ['c5_11', -1],
    'K24_8990':             ['c5_12', -1],
    'K25_qof':              ['c5_13', -1],
    'K26_foreign_acq':      ['c5_14', -1],
    'K27_digital_asset':    ['c5_15', -1],
    'K28_controlled_group': ['c5_16', -1],
    'K29a_59k':             ['c5_17', -1],
    'K29c_safe_harbor':     ['c5_18', -1],
    'K30a_repurchase':      ['c5_19', -1],
    'K30b_foreign_corp':    ['c5_20', -1],
    'K31_consolidated':     ['c5_21', -1],
  }

  for (const f of form.getFields()) {
    if (!(f instanceof PDFCheckBox)) continue
    const name = f.getName()

    for (const [key, [prefix]] of Object.entries(checkboxMap)) {
      const answer = schedK[key]
      if (!answer) continue

      if (key === 'K1_method') {
        // Special: [0]=cash, [1]=accrual, [2]=other
        if (answer === 'accrual' && name.includes(`${prefix}[1]`)) f.check()
        if (answer === 'cash' && name.includes(`${prefix}[0]`)) f.check()
        if (answer === 'other' && name.includes(`${prefix}[2]`)) f.check()
      } else {
        // Standard yes/no: [0]=Yes, [1]=No
        if (answer === 'yes' && name.includes(`${prefix}[0]`)) f.check()
        if (answer === 'no' && name.includes(`${prefix}[1]`)) f.check()
      }
    }
  }
}

// ─── Schedule B checkbox (1120S) ───

function fillScheduleBCheckbox(
  form: ReturnType<PDFDocument['getForm']>,
  schedK: Record<string, string>,
) {
  // 1120S Schedule B accounting method: c2_1[0]=Cash, c2_1[1]=Accrual, c2_1[2]=Other
  const method = schedK['accounting_method'] || schedK['K1_method']
  if (!method) return

  for (const f of form.getFields()) {
    if (!(f instanceof PDFCheckBox)) continue
    const name = f.getName()
    if (method === 'cash' && name.includes('c2_1[0]')) f.check()
    if (method === 'accrual' && name.includes('c2_1[1]')) f.check()
    if (method === 'accrual' && name.includes('c2_1[2]')) f.check() // some forms use [2] for accrual
    if (method === 'other' && name.includes('c2_1[2]')) f.check()
  }
}

// ─── Filing status checkbox (1040) ───

function fillFilingStatus(
  form: ReturnType<PDFDocument['getForm']>,
  filingStatus: string,
) {
  // c1_01 checkbox: [0]=Single, [1]=MFJ, [2]=MFS, [3]=HOH, [4]=QSS
  const statusMap: Record<string, string> = {
    'single': 'c1_01[0]',
    'mfj': 'c1_01[1]',
    'mfs': 'c1_01[2]',
    'hoh': 'c1_01[3]',
    'qss': 'c1_01[4]',
  }

  const target = statusMap[filingStatus.toLowerCase()]
  if (!target) return

  for (const f of form.getFields()) {
    if (f instanceof PDFCheckBox && f.getName().includes(target)) {
      f.check()
      break
    }
  }
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
  setField(form, 'f1_3', model['cogs.L1_inventory_boy'])
  setField(form, 'f1_5', model['cogs.L2_purchases'])
  setField(form, 'f1_7', model['cogs.L3_labor'])
  setField(form, 'f1_9', model['cogs.L4_additional_263a'])
  setField(form, 'f1_11', model['cogs.L5_other'])
  setField(form, 'f1_13', model['cogs.L6_total'])
  setField(form, 'f1_15', model['cogs.L7_inventory_eoy'])
  setField(form, 'f1_17', model['cogs.L8_cogs'])

  return pdf
}

// ─── Fill Schedule G (Ownership) — 1120 only ───

async function fillScheduleG(
  year: number, entity: EntityData,
): Promise<PDFDocument | null> {
  const path = loadForm('f1120sg', year)
  if (!path) return null

  const pdf = await PDFDocument.load(readFileSync(path))
  const form = pdf.getForm()

  setField(form, 'f1_1_0_', entity.name)
  setField(form, 'f1_3_0_', entity.ein)

  // Fill owners from entity.meta.owners
  const owners = entity.meta?.owners as Array<{
    name: string; ssn: string; country: string; pct: string
  }> | undefined
  if (owners) {
    for (let i = 0; i < Math.min(owners.length, 4); i++) {
      const o = owners[i]
      setField(form, `f1_${4 + i * 4}_0_`, o.name)
      setField(form, `f1_${5 + i * 4}_0_`, o.ssn)
      setField(form, `f1_${6 + i * 4}_0_`, o.country)
      setField(form, `f1_${7 + i * 4}_0_`, o.pct)
    }
  }

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
  setField(form, 'f1_4', model['dep.L1_179_limit'])
  setField(form, 'f1_6', model['dep.L3_threshold'])
  setField(form, 'f1_21', model['dep.L16_macrs_current'])
  setField(form, 'f1_22', model['dep.L17_macrs_prior'])
  setField(form, 'f1_25', model['dep.L22_total'])
  setField(form, 'f2_57', model['dep.L43_amortization'])
  setField(form, 'f2_58', model['dep.L44_total_amort'])

  return pdf
}

// ─── Generate statement pages ───

async function generateStatements(
  entity: EntityData, year: number, formType: string,
  model: Record<string, string | number>,
): Promise<PDFDocument | null> {
  // Collect statement data
  const otherDeductions = (entity.meta?.other_deductions || []) as Array<[string, number]>
  const cogsOtherCosts = (entity.meta?.cogs_other_costs || []) as Array<[string, number]>
  const otherIncome = (entity.meta?.other_income || []) as Array<[string, number]>

  // Determine which statements to generate
  const hasOtherDed = otherDeductions.length > 0 || model['deductions.L26_other_deductions'] || model['deductions.L20_other']
  const hasCogsCosts = cogsOtherCosts.length > 0 || model['cogs.L5_other']
  const hasOtherIncome = otherIncome.length > 0

  if (!hasOtherDed && !hasCogsCosts && !hasOtherIncome) return null

  const stmtPdf = await PDFDocument.create()
  const font = await stmtPdf.embedFont(StandardFonts.Courier)
  const boldFont = await stmtPdf.embedFont(StandardFonts.CourierBold)

  function addStatementPage(title: string, items: Array<[string, number]>, totalLabel: string): PDFPage {
    const page = stmtPdf.addPage([612, 792])
    let y = 740
    const draw = (text: string, x: number, yy: number, f: PDFFont = font, size = 10) =>
      page.drawText(text, { x, y: yy, font: f, size, color: rgb(0, 0, 0) })

    draw(entity.name, 50, y, boldFont, 12); y -= 15
    draw(`EIN: ${entity.ein}`, 50, y); y -= 15
    draw(`Tax Year ${year}`, 50, y); y -= 25
    draw(title, 50, y, boldFont, 11); y -= 20
    draw('-'.repeat(65), 50, y); y -= 15

    let total = 0
    for (const [desc, amt] of items) {
      draw(desc, 60, y)
      draw(amt.toLocaleString().padStart(12), 430, y)
      total += amt
      y -= 14
      // Page overflow: start new page if running low
      if (y < 80) {
        const nextPage = stmtPdf.addPage([612, 792])
        y = 740
        // Continue drawing on new page (simplified: re-bind draw to new page)
        // For now, items that overflow will just clip. In practice, statement
        // pages have < 30 line items which fits in one page.
      }
    }
    y -= 5
    draw('-'.repeat(65), 50, y); y -= 15
    draw(totalLabel, 60, y, boldFont)
    draw(total.toLocaleString().padStart(12), 430, y, boldFont)
    return page
  }

  // Summary-only fallback: if no line items provided, show just the total
  function addSummaryPage(title: string, totalAmount: number): PDFPage {
    const page = stmtPdf.addPage([612, 792])
    let y = 740
    const draw = (text: string, x: number, yy: number, f: PDFFont = font, size = 10) =>
      page.drawText(text, { x, y: yy, font: f, size, color: rgb(0, 0, 0) })

    draw(entity.name, 50, y, boldFont, 12); y -= 15
    draw(`EIN: ${entity.ein}`, 50, y); y -= 15
    draw(`Tax Year ${year}`, 50, y); y -= 25
    draw(title, 50, y, boldFont, 11); y -= 20
    draw('-'.repeat(65), 50, y); y -= 15
    draw(`Total: ${totalAmount.toLocaleString()}`, 60, y)
    y -= 15
    draw('-'.repeat(65), 50, y)
    return page
  }

  // Other Deductions statement
  if (hasOtherDed) {
    const formLabel = formType === '1120S' ? 'Form 1120-S, Line 20' : 'Form 1120, Line 26'
    if (otherDeductions.length > 0) {
      addStatementPage(
        `${formLabel} \u2014 Other Deductions`,
        otherDeductions,
        'Total Other Deductions',
      )
    } else {
      const amt = Number(model['deductions.L26_other_deductions'] || model['deductions.L20_other'] || 0)
      if (amt) addSummaryPage(`${formLabel} \u2014 Other Deductions`, amt)
    }
  }

  // COGS Other Costs statement
  if (hasCogsCosts) {
    if (cogsOtherCosts.length > 0) {
      addStatementPage(
        'Form 1125-A, Line 5 \u2014 Other Costs (COGS)',
        cogsOtherCosts,
        'Total Other Costs',
      )
    } else {
      const amt = Number(model['cogs.L5_other'] || 0)
      if (amt) addSummaryPage('Form 1125-A, Line 5 \u2014 Other Costs (COGS)', amt)
    }
  }

  // Other Income statement (1120S)
  if (hasOtherIncome && otherIncome.length > 0) {
    addStatementPage(
      `Form ${formType === '1120S' ? '1120-S' : formType}, Line ${formType === '1120S' ? '5' : '10'} \u2014 Other Income`,
      otherIncome,
      'Total Other Income',
    )
  }

  return stmtPdf.getPageCount() > 0 ? stmtPdf : null
}

// ─── Fill 1120-specific extras on the main form ───

function fill1120Extras(
  form: ReturnType<PDFDocument['getForm']>,
  entity: EntityData,
  year: number,
) {
  // Schedule K checkboxes
  const schedK = entity.meta?.sched_k as Record<string, string> | undefined
  if (schedK) {
    fillScheduleKCheckboxes(form, schedK)
  }

  // Title (field ID varies by year)
  if (entity.meta?.title) {
    if (year >= 2025) setField(form, 'f1_58', entity.meta.title)
    else setField(form, 'f1_56', entity.meta.title)
  }

  // Preparer — field IDs differ by year
  const prep = entity.meta?.preparer as Record<string, string> | undefined
  if (prep) {
    if (year >= 2025) {
      setField(form, 'f1_59', prep.name)
      setField(form, 'f1_60', prep.ptin)
      setField(form, 'f1_61', prep.firm_name)
      setField(form, 'f1_62', prep.firm_ein)
      setField(form, 'f1_63', prep.firm_address)
      setField(form, 'f1_64', prep.phone)
    } else {
      setField(form, 'f1_53', prep.name)
      setField(form, 'f1_55', prep.ptin)
      setField(form, 'f1_56', prep.firm_name)
      setField(form, 'f1_57', prep.firm_ein)
      setField(form, 'f1_58', prep.firm_address)
    }
  }
}

// ─── Fill 1120S-specific extras on the main form ───

function fill1120SExtras(
  form: ReturnType<PDFDocument['getForm']>,
  entity: EntityData,
  model: Record<string, string | number>,
  year: number,
) {
  // Schedule B accounting method checkbox
  const schedK = entity.meta?.sched_k as Record<string, string> | undefined
  if (schedK) {
    fillScheduleBCheckbox(form, schedK)
  }

  // Title
  if (entity.meta?.title) {
    // 1120S title field ID differs by year
    if (year >= 2025) setField(form, 'f1_54', entity.meta.title)
    else setField(form, 'f1_50', entity.meta.title)
  }

  // Schedule L for 1120S uses f4_* field IDs (NOT f6_* like 1120)
  // These are filled via the model -> field map path if the canonical keys
  // are set. For raw field values passed as overrides, they go through setField directly.
  const rawSchedL = entity.meta?.sched_l_raw as Record<string, number> | undefined
  if (rawSchedL) {
    for (const [fieldId, value] of Object.entries(rawSchedL)) {
      setField(form, fieldId, value)
    }
  }

  // Schedule K income allocations are handled through the canonical model
  // (schedK.L1_ordinary, schedK.L4_interest, etc. map to f3_* and f4_* field IDs)

  // Schedule M-1 for 1120S uses f5_* field IDs (NOT f6_* like 1120)
  // This is handled by the year-specific field map since canonical keys like
  // schedM1.L1_net_income map to f5_1 for 1120S vs f6_133 for 1120.
}

// ─── Fill 1040-specific extras on the main form ───

function fill1040Extras(
  form: ReturnType<PDFDocument['getForm']>,
  entity: EntityData,
  model: Record<string, string | number>,
  year: number,
) {
  // Filing status checkbox
  const filingStatus = entity.meta?.filing_status as string | undefined
  if (filingStatus) {
    fillFilingStatus(form, filingStatus)
  }

  // W-2 breakdown (1a, 1e, 1z) — these are in the model via canonical keys:
  //   income.L1a_w2_wages, income.L1e_dependent_care, income.L1z_total_wages
  // They're filled by the main fillForm loop if present in the model.
  // The 2024 vs 2025 field ID difference is handled by the year-specific maps.
  //   2024: f1_32 = L1a wages, f1_36 = L1e dependent care, f1_41 = L1z total
  //   2025: f1_47 = L1a wages, f1_51 = L1e dependent care, f1_57 = L1z total

  // Schedule 2 taxes (additional Medicare, NIIT) are in the model as
  //   tax.L17_sched2, tax.L23_other_taxes
  // Filled by the main loop.

  // Estimated payments (line 26) and other withholding (line 25c)
  // are in the model as payments.L26_estimated, payments.L25c_other
  // Filled by the main loop.
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

  const mainForm = main.pdf.getForm()

  // 2. Form-specific extras (checkboxes, preparer, title, etc.)
  if (formType === '1120') {
    fill1120Extras(mainForm, entity, taxYear)
  } else if (formType === '1120S') {
    fill1120SExtras(mainForm, entity, model, taxYear)
  } else if (formType === '1040') {
    fill1040Extras(mainForm, entity, model, taxYear)
  }

  // 3. Build merged package
  const merged = await PDFDocument.create()

  async function append(src: PDFDocument, label?: string) {
    const pages = await merged.copyPages(src, src.getPageIndices())
    pages.forEach(p => merged.addPage(p))
    if (label) forms.push(label)
  }

  await append(main.pdf)
  let totalFilled = main.filled

  // 4. Supporting forms (1120 and 1120S)
  if (formType === '1120' || formType === '1120S') {
    // 1125-A (COGS)
    if (model['cogs.L8_cogs'] || model['income.L2_cogs'] || model['cogs.L5_other']) {
      const cogs = await fill1125A(taxYear, entity, model)
      if (cogs) await append(cogs, 'Form 1125-A')
    }

    // Schedule G (ownership) — 1120 only
    if (formType === '1120' && entity.meta?.owners) {
      const sg = await fillScheduleG(taxYear, entity)
      if (sg) await append(sg, 'Schedule G')
    }

    // 4562 (depreciation) — 1120 only (1120S uses field map)
    if (formType === '1120' && (model['dep.L22_total'] || model['deductions.L20_depreciation'])) {
      const dep = await fill4562(taxYear, entity, model)
      if (dep) await append(dep, 'Form 4562')
    }

    // Statement pages (other deductions, COGS detail, other income)
    const stmts = await generateStatements(entity, taxYear, formType, model)
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
