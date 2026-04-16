/**
 * Form 4562 Builder — Depreciation and Amortization
 *
 * Fills blank IRS Form 4562 from calc4562() results.
 * Focuses on summary lines (Parts I, II, III Section A, IV, VI).
 * Part III Section B grid rows are filled per-asset.
 */

import { PDFDocument } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { setField, fillFromMap } from './pdf_filler.js'
import type { Form4562_Inputs, Form4562_Result } from '../engine/tax_engine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORMS_DIR = join(__dirname, '../../data/irs_forms')

// Map canonical input/computed keys → PDF field IDs
const FIELD_MAP_4562: Record<string, string> = {
  // Header
  'taxpayer_name':              'f1_1',
  'business_activity':          'f1_2',
  'taxpayer_id':                'f1_3',
  // Part I — Section 179
  'section_179_max':            'f1_4',   // Line 1
  'section_179_total_cost':     'f1_5',   // Line 2
  'section_179_threshold':      'f1_6',   // Line 3
  'reduction':                  'f1_7',   // Line 4
  'section_179_limitation':     'f1_8',   // Line 5
  // Lines 6 (description/cost/elected) — f1_9 to f1_14 (grid rows)
  'listed_property_179':        'f1_15',  // Line 7
  'total_elected_179':          'f1_16',  // Line 8
  'tentative_deduction':        'f1_17',  // Line 9
  'section_179_carryover':      'f1_18',  // Line 10
  'business_income_limit':      'f1_19',  // Line 11
  'section_179_deduction':      'f1_20',  // Line 12
  'section_179_carryforward':   'f1_21',  // Line 13
  // Part II
  'special_depreciation':       'f1_22',  // Line 14
  'sec_168f1':                  'f1_23',  // Line 15
  'other_depreciation':         'f1_24',  // Line 16
  // Part III Section A
  'macrs_prior_years':          'f1_25',  // Line 17
  // Part IV — Summary
  'listed_property':            'f2_1',   // Line 21
  'total_depreciation':         'f2_2',   // Line 22
  // Part VI — Amortization
  'amortization_prior':         'f3_13',  // Line 43
  'total_amortization':         'f3_14',  // Line 44
}

// Part III Section B — MACRS grid row field IDs (basis + deduction per class)
// Row format: 19a-j → basis in col (c), deduction in col (g)
const MACRS_GRID: Record<number, { basis: string; deduction: string }> = {
  3:    { basis: 'f1_28', deduction: 'f1_31' },  // 19a
  5:    { basis: 'f1_34', deduction: 'f1_37' },  // 19b
  7:    { basis: 'f1_40', deduction: 'f1_43' },  // 19c
  10:   { basis: 'f1_46', deduction: 'f1_49' },  // 19d
  15:   { basis: 'f1_52', deduction: 'f1_55' },  // 19e
  20:   { basis: 'f1_58', deduction: 'f1_61' },  // 19f
}

export async function build4562Pdf(
  inputs: Form4562_Inputs,
  result: Form4562_Result,
  year: number = 2025
): Promise<{ pdf: PDFDocument; filled: number; missed: string[] }> {
  const pdfPath = join(FORMS_DIR, `f4562_${year}.pdf`)
  if (!existsSync(pdfPath)) throw new Error(`Blank PDF not found: ${pdfPath}`)

  const pdf = await PDFDocument.load(readFileSync(pdfPath))
  const form = pdf.getForm()

  const data: Record<string, string | number> = {}

  // Header
  data['taxpayer_name'] = inputs.taxpayer_name
  data['business_activity'] = inputs.business_activity
  data['taxpayer_id'] = inputs.taxpayer_id

  // Part I
  data['section_179_max'] = inputs.section_179_max ?? 1250000
  if (inputs.section_179_total_cost) data['section_179_total_cost'] = inputs.section_179_total_cost
  data['section_179_threshold'] = inputs.section_179_threshold ?? 3130000
  const reduction = Math.max(0, (inputs.section_179_total_cost ?? 0) - (inputs.section_179_threshold ?? 3130000))
  data['reduction'] = reduction
  data['section_179_limitation'] = result.computed.section_179_limitation
  if (inputs.section_179_carryover) data['section_179_carryover'] = inputs.section_179_carryover
  if (inputs.business_income_limit) data['business_income_limit'] = inputs.business_income_limit
  data['section_179_deduction'] = result.computed.section_179_deduction
  data['section_179_carryforward'] = result.computed.section_179_carryforward

  // Part II
  if (inputs.special_depreciation) data['special_depreciation'] = inputs.special_depreciation
  if (inputs.other_depreciation) data['other_depreciation'] = inputs.other_depreciation

  // Part III Section A
  if (inputs.macrs_prior_years) data['macrs_prior_years'] = inputs.macrs_prior_years

  // Part IV — Summary
  data['total_depreciation'] = result.computed.total_depreciation

  // Part VI
  if (inputs.amortization_prior) data['amortization_prior'] = inputs.amortization_prior
  data['total_amortization'] = result.computed.total_amortization

  // Fill summary fields
  const { filled, missed } = fillFromMap(form, FIELD_MAP_4562, data)

  // Fill MACRS grid (Part III Section B) — aggregate by class
  let gridFilled = 0
  for (const [period, dep] of Object.entries(result.computed.depreciation_by_class)) {
    const yrs = parseInt(period)
    const grid = MACRS_GRID[yrs]
    if (grid && dep > 0) {
      // Sum basis for this class from assets
      const classBasis = (inputs.assets || [])
        .filter(a => a.recovery_period === yrs)
        .reduce((s, a) => s + Math.round(a.cost_basis * a.business_pct / 100), 0)
      if (setField(form, grid.basis, classBasis)) gridFilled++
      if (setField(form, grid.deduction, dep)) gridFilled++
    }
  }

  return { pdf, filled: filled + gridFilled, missed }
}
