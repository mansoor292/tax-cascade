/**
 * Form 8594 Builder — Asset Acquisition Statement
 *
 * Fills blank IRS Form 8594 from calc8594() results.
 * Part II allocation table + header info.
 */

import { PDFDocument } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { setField, checkBox, fillFromMap } from './pdf_filler.js'
import type { Form8594_Inputs, Form8594_Result } from '../engine/tax_engine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORMS_DIR = join(__dirname, '../../data/irs_forms')

const FIELD_MAP_8594: Record<string, string> = {
  // Header
  'taxpayer_name':        'f1_1',
  'taxpayer_id':          'f1_2',
  // Part I — General Information
  'other_party_name':     'f1_3',
  'other_party_id':       'f1_4',
  'other_party_address':  'f1_5',
  'other_party_city':     'f1_6',
  'date_of_sale':         'f1_7',
  'total_sales_price':    'f1_8',
  // Part II — Class allocations (FMV | Allocation)
  'class_i_fmv':          'f1_9',
  'class_i_alloc':        'f1_10',
  'class_ii_fmv':         'f1_11',
  'class_ii_alloc':       'f1_12',
  'class_iii_fmv':        'f1_13',
  'class_iii_alloc':      'f1_14',
  'class_iv_fmv':         'f1_15',
  'class_iv_alloc':       'f1_16',
  'class_v_fmv':          'f1_17',
  'class_v_alloc':        'f1_18',
  'class_vi_vii_fmv':     'f1_19',
  'class_vi_vii_alloc':   'f1_20',
  'total_fmv':            'f1_21',
  'total_allocation':     'f1_22',
}

export async function build8594Pdf(
  inputs: Form8594_Inputs,
  result: Form8594_Result,
  year: number = 2025
): Promise<{ pdf: PDFDocument; filled: number; missed: string[] }> {
  const pdfPath = join(FORMS_DIR, `f8594_${year}.pdf`)
  if (!existsSync(pdfPath)) throw new Error(`Blank PDF not found: ${pdfPath}`)

  const pdf = await PDFDocument.load(readFileSync(pdfPath))
  const form = pdf.getForm()

  const data: Record<string, string | number> = {
    'taxpayer_name':       inputs.taxpayer_name,
    'taxpayer_id':         inputs.taxpayer_id,
    'other_party_name':    inputs.other_party_name,
    'other_party_id':      inputs.other_party_id,
    'date_of_sale':        inputs.date_of_sale,
    'total_sales_price':   inputs.total_sales_price,
    'class_i_fmv':         inputs.class_i_fmv || 0,
    'class_i_alloc':       inputs.class_i_alloc || 0,
    'class_ii_fmv':        inputs.class_ii_fmv || 0,
    'class_ii_alloc':      inputs.class_ii_alloc || 0,
    'class_iii_fmv':       inputs.class_iii_fmv || 0,
    'class_iii_alloc':     inputs.class_iii_alloc || 0,
    'class_iv_fmv':        inputs.class_iv_fmv || 0,
    'class_iv_alloc':      inputs.class_iv_alloc || 0,
    'class_v_fmv':         inputs.class_v_fmv || 0,
    'class_v_alloc':       inputs.class_v_alloc || 0,
    'class_vi_vii_fmv':    inputs.class_vi_vii_fmv || 0,
    'class_vi_vii_alloc':  inputs.class_vi_vii_alloc || 0,
    'total_fmv':           result.computed.total_fmv,
    'total_allocation':    result.computed.total_allocation,
  }

  if (inputs.other_party_address) data['other_party_address'] = inputs.other_party_address
  if (inputs.other_party_city) data['other_party_city'] = inputs.other_party_city

  const { filled, missed } = fillFromMap(form, FIELD_MAP_8594, data)

  // Checkboxes
  if (inputs.is_purchaser) {
    checkBox(form, 'c1_1[0]')
  } else {
    checkBox(form, 'c1_1[1]')
  }

  if (inputs.has_allocation_agreement === true) checkBox(form, 'c1_2[0]')
  else if (inputs.has_allocation_agreement === false) checkBox(form, 'c1_2[1]')

  if (inputs.fmv_amounts_agreed === true) checkBox(form, 'c1_3[0]')
  else if (inputs.fmv_amounts_agreed === false) checkBox(form, 'c1_3[1]')

  if (inputs.has_covenant === true) checkBox(form, 'c1_4[0]')
  else if (inputs.has_covenant === false) checkBox(form, 'c1_4[1]')

  return { pdf, filled, missed }
}
