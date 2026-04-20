/**
 * Schedule E Builder — Supplemental Income and Loss (attaches to Form 1040)
 *
 * Fills blank IRS Schedule E from calcScheduleE() result. Covers:
 *   • Part I per-property grid (properties A/B/C, lines 1a, 1b, 2, 3-20, 21, 22)
 *   • Part I totals (23a-e, 24-26)
 *   • Part II–V summary lines (32, 37, 39, 40, 41)
 *
 * Line 22 (deductible rental RE loss after §469 PAL limitation) is populated
 * from L21 as-is since Form 8582 passive activity logic isn't wired yet —
 * this assumes all losses are deductible, which is optimistic for investors
 * above the MAGI phaseouts. Flagged for follow-up.
 */

import { PDFDocument } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { setField, fillFromMap } from './pdf_filler.js'
import type { ScheduleE_Inputs, ScheduleE_Result, RentalProperty } from '../engine/tax_engine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORMS_DIR = join(__dirname, '../../data/irs_forms')

// Summary lines + header
const FIELD_MAP_SCHE: Record<string, string> = {
  taxpayer_name:            'f1_1',
  taxpayer_id:              'f1_2',
  L23a_total_rents:         'f1_77',
  L23b_total_royalties:     'f1_78',
  L23c_total_mortgage:      'f1_79',
  L23d_total_depreciation:  'f1_80',
  L23e_total_expenses:      'f1_81',
  L24_income:               'f1_82',
  L25_losses:               'f1_83',
  L26_rental_royalty:       'f1_84',
  // Part II summary (from discovery enum_sche)
  L30_partnership_income:   'f2_45',
  L32_partnership_total:    'f2_47',
  L35_estate_income:        'f2_68',
  L37_estate_trust_total:   'f2_70',
  L39_remic_total:          'f2_76',
  L40_farm_rental:          'f2_77',
  L41_total:                'f2_78',
}

// Per-property grid: each line gives [PropA_id, PropB_id, PropC_id].
// Shape discovered via enum_sche.ts pass against f1040se_2025.pdf.
const GRID: Record<string, [string, string, string]> = {
  address:              ['f1_3',  'f1_4',  'f1_5'],
  property_type:        ['f1_6',  'f1_7',  'f1_8'],   // type code 1-8
  fair_rental_days:     ['f1_9',  'f1_11', 'f1_13'],  // Line 2a
  personal_use_days:    ['f1_10', 'f1_12', 'f1_14'],  // Line 2b
  rents:                ['f1_16', 'f1_17', 'f1_18'],  // Line 3
  royalties:            ['f1_19', 'f1_20', 'f1_21'],  // Line 4
  advertising:          ['f1_22', 'f1_23', 'f1_24'],  // Line 5
  auto_travel:          ['f1_25', 'f1_26', 'f1_27'],  // Line 6
  cleaning_maintenance: ['f1_28', 'f1_29', 'f1_30'],  // Line 7
  commissions:          ['f1_31', 'f1_32', 'f1_33'],  // Line 8
  insurance:            ['f1_34', 'f1_35', 'f1_36'],  // Line 9
  legal_professional:   ['f1_37', 'f1_38', 'f1_39'],  // Line 10
  management_fees:      ['f1_40', 'f1_41', 'f1_42'],  // Line 11
  mortgage_interest:    ['f1_43', 'f1_44', 'f1_45'],  // Line 12
  other_interest:       ['f1_46', 'f1_47', 'f1_48'],  // Line 13
  repairs:              ['f1_49', 'f1_50', 'f1_51'],  // Line 14
  supplies:             ['f1_52', 'f1_53', 'f1_54'],  // Line 15
  taxes:                ['f1_55', 'f1_56', 'f1_57'],  // Line 16
  utilities:            ['f1_58', 'f1_59', 'f1_60'],  // Line 17
  depreciation:         ['f1_61', 'f1_62', 'f1_63'],  // Line 18
  other_expenses:       ['f1_65', 'f1_66', 'f1_67'],  // Line 19 amounts (f1_64 is the label)
  total_expenses:       ['f1_68', 'f1_69', 'f1_70'],  // Line 20
  net_income_loss:      ['f1_71', 'f1_72', 'f1_73'],  // Line 21
  deductible_re_loss:   ['f1_74', 'f1_75', 'f1_76'],  // Line 22 — pre-PAL; optimistic
}

// QJV (qualified joint venture) checkboxes on line 2, one per property
const QJV_CHECKS: [string, string, string] = ['c1_3', 'c1_4', 'c1_5']

function fillProperty(
  form: ReturnType<PDFDocument['getForm']>,
  col: 0 | 1 | 2,
  p: RentalProperty,
  totalExpenses: number,
  netIncomeLoss: number,
): number {
  let n = 0
  const fill = (key: keyof typeof GRID, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '' || value === 0) return
    if (setField(form, GRID[key][col], value)) n++
  }
  fill('address', p.address)
  fill('property_type', p.property_type)
  fill('fair_rental_days', p.fair_rental_days)
  fill('personal_use_days', p.personal_use_days)
  fill('rents', p.rents)
  fill('royalties', p.royalties)
  fill('advertising', p.advertising)
  fill('auto_travel', p.auto_travel)
  fill('cleaning_maintenance', p.cleaning_maintenance)
  fill('commissions', p.commissions)
  fill('insurance', p.insurance)
  fill('legal_professional', p.legal_professional)
  fill('management_fees', p.management_fees)
  fill('mortgage_interest', p.mortgage_interest)
  fill('other_interest', p.other_interest)
  fill('repairs', p.repairs)
  fill('supplies', p.supplies)
  fill('taxes', p.taxes)
  fill('utilities', p.utilities)
  fill('depreciation', p.depreciation)
  fill('other_expenses', p.other_expenses)
  fill('total_expenses', totalExpenses)
  fill('net_income_loss', netIncomeLoss)
  // Line 22 — deductible loss. Without Form 8582 PAL limitation, assume full
  // loss is deductible. Only populate if net is negative.
  if (netIncomeLoss < 0) fill('deductible_re_loss', netIncomeLoss)
  return n
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
    L25_losses:               c.L25_losses,
    L26_rental_royalty:       c.L26_rental_royalty_net,
    L30_partnership_income:   c.L32_partnership_total,
    L32_partnership_total:    c.L32_partnership_total,
    L35_estate_income:        c.L37_estate_trust_total,
    L37_estate_trust_total:   c.L37_estate_trust_total,
    L39_remic_total:          c.L39_remic_total,
    L40_farm_rental:          c.L40_farm_rental,
    L41_total:                c.L41_total_income_loss,
  }

  const { filled, missed } = fillFromMap(form, FIELD_MAP_SCHE, data)

  // Per-property grid (up to 3 properties)
  const props = inputs.rental_properties || []
  let gridFilled = 0
  for (let i = 0; i < Math.min(props.length, 3); i++) {
    const perProp = c.per_property[i]
    gridFilled += fillProperty(form, i as 0 | 1 | 2, props[i], perProp.total_expenses, perProp.net_income_loss)
  }

  return { pdf, filled: filled + gridFilled, missed }
}
