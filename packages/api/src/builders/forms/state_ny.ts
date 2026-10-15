/**
 * New York nonresident package: IT-203, IT-203-B and IT-2, on the state's own
 * fill-in PDFs (data/state_forms/).
 *
 * Why this exists (2026-10-15 parity sprint): the 2025 Form 1040 was filed with
 * a New York nonresident return for one spouse's New York workdays, and the
 * package we generate had no state forms at all. This renders them; it does
 * NOT compute New York tax. The figures are carried on the federal return's
 * input_data, one key per form so a save that restates one form cannot drop
 * another (compute_return merges input_data one level deep):
 *
 *   state_ny_it203  { L1_federal, L1_ny, ..., filing_status, dependents: [...] }
 *   state_ny_it203b { L1a, ..., residences: [...], students: [...] }
 *   state_ny_it2    { w2: [{ box_1, box_16a, ... }, ...] }      two W-2s per page
 *
 * Keys are the line numbers printed on the form, generated from the blanks by
 * scripts/state_forms/gen_ny_maps.py (the fill-in field NAMES carry the form
 * designer's typos — "53d dollars" is line 52d). Computing these lines
 * (income allocation, the NY tax tables, the income percentage on line 45) is
 * future engine work; until then they are entered as filed.
 *
 * Identity: SSNs default to the federal return's entity (entity.ein holds the
 * primary SSN on a 1040, meta.spouse_ssn the spouse's), so they are not stored
 * twice. Anything else identifying (dates of birth, dependents' SSNs, refund
 * account) lives only in input_data, which is encrypted at rest.
 *
 * Field IDs are verified against the 2025 blanks only; any other year is
 * refused rather than written into a layout the map was not checked against.
 */
import { PDFDocument, PDFCheckBox, PDFName, PDFRadioGroup, PDFTextField, StandardFonts } from 'pdf-lib'
import type { PDFFont, PDFForm } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import type { Attachment, AttachmentContext } from './types.js'
import { NY_IT203_2025, NY_IT203B_2025, NY_IT2_2025 } from './state_ny_maps_2025.js'

export interface NyFieldSpec { field: string; kind: 'text' | 'check'; page: number; options?: string[] }
export interface NyRowSpec { kind: 'text' | 'check'; on?: string; fields: string[] }
export interface NyFieldMap {
  fields: Record<string, NyFieldSpec>
  rows: Record<string, Record<string, NyRowSpec>>
}

const VERIFIED_YEAR = 2025
// Sequence after every federal form; NY forms in the order NY wants them.
const SEQ = { it203: 1100, it203b: 1101, it2: 1102 }

/** PDF names arrive with #xx escapes ("2#20Married..."); compare decoded. */
function decodeName(s: string): string {
  return s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

const FILING_STATUS: Record<string, string> = { single: '1', mfj: '2', mfs: '3', hoh: 'Head', qss: 'Qualifying' }

/**
 * A NY "dollars" box holds whole dollars with no separators — the ".00" is
 * printed on the form. Strings (codes, names, dates, percentages) pass through.
 */
function nyText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    const r = Math.round(v)
    return String(Object.is(r, -0) ? 0 : r)
  }
  return String(v)
}

/** SSN / EIN boxes take bare digits; entity identifiers are stored dashed. */
const ID_KEYS = new Set(['ssn', 'spouse_ssn', 'box_a', 'box_b', 'ein'])
const digitsOnly = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : v)

/**
 * Shrink a value's font until it fits its box. The NY fill-ins fix the size
 * in each field's default appearance, and pdf-lib does not shrink fixed-size
 * text: a 40-character joint name on IT-203-B ran out of the name box and
 * printed its last word inside the occupation box.
 */
function fitFontSize(f: PDFTextField, s: string, font: PDFFont): void {
  const da = f.acroField.getDefaultAppearance() || ''
  const m = /(\d+(?:\.\d+)?)\s+Tf/.exec(da)
  const size = m ? parseFloat(m[1]) : 0
  if (!size) return // 0 = auto-size; pdf-lib already fits it
  const widget = f.acroField.getWidgets()[0]
  if (!widget || f.isCombed()) return
  const room = widget.getRectangle().width - 4
  const width = font.widthOfTextAtSize(s, size)
  if (width > room && room > 0) f.setFontSize(Math.max(4, Math.floor((size * room / width) * 10) / 10))
}

function setText(form: PDFForm, name: string, v: unknown, font: PDFFont): boolean {
  const s = nyText(v)
  if (s === null) return false
  let f
  try { f = form.getField(name) } catch { return false }
  if (!(f instanceof PDFTextField)) return false
  const max = f.getMaxLength()
  if (max !== undefined && s.length > max) f.setMaxLength(s.length)
  fitFontSize(f, s, font)
  f.setText(s)
  return true
}

/**
 * Tick one box of a one-of group. The NY forms give several widgets ONE field
 * name and tell them apart by export value, so pdf-lib's check() — which turns
 * on the first widget's value — would tick the wrong box. Set the value that
 * names the intended widget instead.
 */
function setChoice(form: PDFForm, name: string, options: string[], value: unknown, key: string): boolean {
  if (value === null || value === undefined || value === '' || value === false) return false
  let want: string | undefined
  const v = String(value).trim().toLowerCase()
  const decoded = options.map(decodeName)
  if (key === 'filing_status' && FILING_STATUS[v]) {
    want = options[decoded.findIndex(o => o.startsWith(FILING_STATUS[v]))]
  }
  if (!want) want = options[decoded.findIndex(o => o.toLowerCase() === v)]
  if (!want && (value === true || v === 'true' || v === 'x') && options.length === 1) want = options[0]
  if (!want && options.length === 1 && v === 'yes') want = options[0]
  if (!want) {
    throw new Error(`NY ${key}: "${value}" is not one of ${decoded.join(' / ')}`)
  }
  let f
  try { f = form.getField(name) } catch { return false }
  const target = PDFName.of(decodeName(want))
  if (!(f instanceof PDFCheckBox || f instanceof PDFRadioGroup)) return false
  // PDFAcroCheckBox.setValue accepts only the FIRST widget's on-value and
  // throws for the others, so set /V and each widget's appearance directly.
  const acro = f.acroField
  const widgets = acro.getWidgets()
  if (!widgets.some(w => w.getOnValue() === target)) {
    throw new Error(`NY ${key}: no box on the form exports "${decodeName(want)}"`)
  }
  acro.dict.set(PDFName.of('V'), target)
  for (const w of widgets) w.setAppearanceState(w.getOnValue() === target ? target : PDFName.of('Off'))
  return true
}

async function fillMap(pdf: PDFDocument, map: NyFieldMap, data: Record<string, any>, rowOffset = 0): Promise<number> {
  const form = pdf.getForm()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  let filled = 0
  for (const [key, spec] of Object.entries(map.fields)) {
    const v = ID_KEYS.has(key) ? digitsOnly(data[key]) : data[key]
    if (spec.kind === 'text') { if (setText(form, spec.field, v, font)) filled++ }
    else if (setChoice(form, spec.field, spec.options || [], v, key)) filled++
  }
  for (const [arr, cols] of Object.entries(map.rows)) {
    const items = Array.isArray(data[arr]) ? data[arr] : []
    for (const [col, spec] of Object.entries(cols)) {
      spec.fields.forEach((fieldName, i) => {
        const item = items[i + rowOffset]
        if (!item) return
        const v = ID_KEYS.has(col) ? digitsOnly(item[col]) : item[col]
        if (spec.kind === 'text') { if (setText(form, fieldName, v, font)) filled++ }
        else if (setChoice(form, fieldName, [spec.on || 'Yes'], v, `${arr}.${col}`)) filled++
      })
    }
  }
  return filled
}

async function loadBlank(name: string): Promise<PDFDocument | null> {
  const path = `data/state_forms/${name}_${VERIFIED_YEAR}.pdf`
  if (!existsSync(path)) return null
  return PDFDocument.load(readFileSync(path))
}

function present(o: unknown): o is Record<string, any> {
  return !!o && typeof o === 'object' && Object.keys(o as object).length > 0
}

function refuseYear(ctx: AttachmentContext, form: string): boolean {
  if (ctx.taxYear === VERIFIED_YEAR) return false
  console.error(`[state_ny] ${form}: field map verified for ${VERIFIED_YEAR} only; not rendering tax year ${ctx.taxYear}`)
  return true
}

export async function buildNyIt203(ctx: AttachmentContext): Promise<Attachment | null> {
  const data = ctx.inputData.state_ny_it203
  if (!present(data) || refuseYear(ctx, 'IT-203')) return null
  const pdf = await loadBlank('it203')
  if (!pdf) return null
  const meta = ctx.entity.meta || {}
  const withIds = {
    ...data,
    ssn: data.ssn ?? (ctx.formType === '1040' ? ctx.entity.ein : undefined),
    spouse_ssn: data.spouse_ssn ?? meta.spouse_ssn,
  }
  const filled = await fillMap(pdf, NY_IT203_2025, withIds)
  return { seq: SEQ.it203, label: 'NY IT-203', pdf, filled }
}

export async function buildNyIt203b(ctx: AttachmentContext): Promise<Attachment | null> {
  const data = ctx.inputData.state_ny_it203b
  if (!present(data) || refuseYear(ctx, 'IT-203-B')) return null
  const pdf = await loadBlank('it203b')
  if (!pdf) return null
  const withIds = { ...data, ssn: data.ssn ?? (ctx.formType === '1040' ? ctx.entity.ein : undefined) }
  const filled = await fillMap(pdf, NY_IT203B_2025, withIds)
  return { seq: SEQ.it203b, label: 'NY IT-203-B', pdf, filled }
}

/** IT-2 summarizes W-2s two to a page; more W-2s mean more pages. */
export async function buildNyIt2(ctx: AttachmentContext): Promise<Attachment[] | null> {
  const data = ctx.inputData.state_ny_it2
  const w2s = Array.isArray(data?.w2) ? data.w2 : []
  if (!w2s.length || refuseYear(ctx, 'IT-2')) return null
  const out: Attachment[] = []
  for (let i = 0; i < w2s.length; i += 2) {
    const pdf = await loadBlank('it2')
    if (!pdf) return null
    const filled = await fillMap(pdf, NY_IT2_2025, { w2: w2s }, i)
    out.push({ seq: SEQ.it2 + i / 1000, label: 'NY IT-2', pdf, filled })
  }
  return out
}
