/**
 * Schedule E Builder — Supplemental Income and Loss (attaches to Form 1040)
 *
 * Fills blank IRS Schedule E from calcScheduleE() result. Current discovery
 * only exposes summary lines (23a-e, 24-26, 30, 32, 37, 39-41) in the PDF
 * field map — per-property grid cells (A/B/C columns, lines 3-20) are not
 * yet mapped and are left blank.
 */

import { PDFDocument } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { setField, fillFromMap } from './pdf_filler.js'
import type { ScheduleE_Inputs, ScheduleE_Result } from '../engine/tax_engine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORMS_DIR = join(__dirname, '../../data/irs_forms')

// Field IDs from f1040se_{year}_fields.json — summary lines only
const FIELD_MAP_SCHE: Record<string, string> = {
  'taxpayer_name':          'f1_1',
  'taxpayer_id':            'f1_2',
  // Part I totals (page 1)
  'L23a_total_rents':       'f1_77',
  'L23b_total_royalties':   'f1_78',
  'L23c_total_mortgage':    'f1_79',
  'L23d_total_depreciation':'f1_80',
  'L23e_total_expenses':    'f1_81',
  'L24_income':             'f1_82',
  'L26_rental_royalty':     'f1_84',
  // Part II-V (page 2)
  'L30_partnership_income': 'f2_45',
  'L32_partnership_total':  'f2_47',
  'L35_estate_income':      'f2_68',
  'L37_estate_trust_total': 'f2_70',
  'L39_remic_total':        'f2_76',
  'L40_farm_rental':        'f2_77',
  'L41_total':              'f2_78',
}

export async function buildScheduleEPdf(
  inputs: ScheduleE_Inputs,
  result: ScheduleE_Result,
  year: number = 2025,
): Promise<{ pdf: PDFDocument; filled: number; missed: string[] }> {
  const pdfPath = join(FORMS_DIR, `f1040se_${year}.pdf`)
  if (!existsSync(pdfPath)) throw new Error(`Blank Schedule E PDF not found: ${pdfPath}`)

  const pdf = await PDFDocument.load(readFileSync(pdfPath))
  const form = pdf.getForm()

  const c = result.computed
  const data: Record<string, string | number> = {
    taxpayer_name:            inputs.taxpayer_name || '',
    taxpayer_id:              inputs.taxpayer_id || '',
    L23a_total_rents:         c.L23a_total_rents,
    L23b_total_royalties:     c.L23b_total_royalties,
    L23c_total_mortgage:      c.L23c_total_mortgage_int,
    L23d_total_depreciation:  c.L23d_total_depreciation,
    L23e_total_expenses:      c.L23e_total_expenses,
    L24_income:               c.L24_income,
    L26_rental_royalty:       c.L26_rental_royalty_net,
    // Part II: L30 shown as partnership ordinary, L32 as Part II subtotal
    L30_partnership_income:   c.L32_partnership_total,
    L32_partnership_total:    c.L32_partnership_total,
    L35_estate_income:        c.L37_estate_trust_total,
    L37_estate_trust_total:   c.L37_estate_trust_total,
    L39_remic_total:          c.L39_remic_total,
    L40_farm_rental:          c.L40_farm_rental,
    L41_total:                c.L41_total_income_loss,
  }

  const { filled, missed } = fillFromMap(form, FIELD_MAP_SCHE, data)

  // Per-property addresses on lines 1A/1B/1C if present (f1_3, f1_4, f1_5 per field map)
  const props = inputs.rental_properties || []
  const addrFields = ['f1_3', 'f1_4', 'f1_5']
  let extraFilled = 0
  for (let i = 0; i < Math.min(props.length, 3); i++) {
    if (props[i].address && setField(form, addrFields[i], props[i].address!)) extraFilled++
  }

  return { pdf, filled: filled + extraFilled, missed }
}
