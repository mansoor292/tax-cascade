/**
 * Extension Form Builder — 4868, 7004, 8868
 *
 * Fills blank IRS extension PDFs from structured inputs.
 * All three forms follow the same pattern: taxpayer info + estimated tax = balance due.
 */

import { PDFDocument } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { setField, checkBox, fillFromMap } from './pdf_filler.js'
import type { ExtensionInputs, ExtensionType } from '../engine/tax_engine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORMS_DIR = join(__dirname, '../../data/irs_forms')

// ─── Field maps: input property → PDF field ID ───
// These map ExtensionInputs fields to the actual PDF field IDs discovered via pdf-lib scan.

const FIELD_MAP_4868: Record<string, string> = {
  // VoucherHeader (tax year fields — usually blank for calendar year filers)
  // f1_1 = tax year beginning date, f1_2 = tax year ending date, f1_3 = ending year suffix
  // Part I — Identification
  'taxpayer_name':           'f1_4',
  'address':                 'f1_5',
  'city':                    'f1_6',
  'state':                   'f1_7',
  'zip':                     'f1_8',
  'taxpayer_id':             'f1_9',
  'spouse_ssn':              'f1_10',
  // Part II — Individual Income Tax
  'estimated_tax_liability': 'f1_11',
  'total_payments':          'f1_12',
  'balance_due':             'f1_13',
  'amount_paying':           'f1_14',
}

const FIELD_MAP_7004: Record<string, string> = {
  'taxpayer_name':           'f1_1',
  'taxpayer_id':             'f1_2',
  'address':                 'f1_3',
  'suite':                   'f1_4',
  'city':                    'f1_5',
  'state':                   'f1_6',
  'country':                 'f1_7',
  'zip':                     'f1_8',
  'form_code_digit1':        'f1_9',
  'form_code_digit2':        'f1_10',
  'calendar_year':           'f1_11',
  'estimated_tax_liability': 'f1_16',
  'total_payments':          'f1_17',
  'balance_due':             'f1_18',
}

const FIELD_MAP_8868: Record<string, string> = {
  'taxpayer_name':           'f1_1',
  'taxpayer_id':             'f1_2',
  'address':                 'f1_3',
  'city_state_zip':          'f1_4',
  'return_code':             'f1_5',
  'org_books_care_of':       'f1_23',
  'telephone':               'f1_24',
  'fax':                     'f1_25',
  'extension_date':          'f1_26',
  'extension_year':          'f1_27',
  'calendar_year':           'f1_28',
  'estimated_tax_liability': 'f1_33',
  'total_payments':          'f1_34',
  'balance_due':             'f1_35',
}

const FIELD_MAPS: Record<ExtensionType, Record<string, string>> = {
  '4868': FIELD_MAP_4868,
  '7004': FIELD_MAP_7004,
  '8868': FIELD_MAP_8868,
}

const FORM_NAMES: Record<ExtensionType, string> = {
  '4868': 'f4868',
  '7004': 'f7004',
  '8868': 'f8868',
}

/**
 * Build a filled extension PDF from structured inputs.
 */
export async function buildExtensionPdf(
  inputs: ExtensionInputs,
  year: number = 2025
): Promise<{ pdf: PDFDocument; filled: number; missed: string[] }> {
  const formName = FORM_NAMES[inputs.extension_type]
  const pdfPath = `${FORMS_DIR}/${formName}_${year}.pdf`

  if (!existsSync(pdfPath)) {
    throw new Error(`Blank PDF not found: ${pdfPath}`)
  }

  const pdf = await PDFDocument.load(readFileSync(pdfPath))
  const form = pdf.getForm()
  const fieldMap = FIELD_MAPS[inputs.extension_type]

  // Compute balance due
  const balance_due = Math.max(0, (inputs.estimated_tax_liability || 0) - (inputs.total_payments || 0))

  // Build data record from inputs
  const data: Record<string, string | number> = {}

  // Common fields
  if (inputs.taxpayer_name) data['taxpayer_name'] = inputs.taxpayer_name
  if (inputs.taxpayer_id) data['taxpayer_id'] = inputs.taxpayer_id
  if (inputs.address) data['address'] = inputs.address
  if (inputs.estimated_tax_liability !== undefined) data['estimated_tax_liability'] = inputs.estimated_tax_liability
  if (inputs.total_payments !== undefined) data['total_payments'] = inputs.total_payments
  data['balance_due'] = balance_due
  if (inputs.amount_paying !== undefined) data['amount_paying'] = inputs.amount_paying

  // Form-specific fields
  if (inputs.extension_type === '4868') {
    if (inputs.city) data['city'] = inputs.city
    if (inputs.state) data['state'] = inputs.state
    if (inputs.zip) data['zip'] = inputs.zip
    if (inputs.spouse_ssn) data['spouse_ssn'] = inputs.spouse_ssn
  } else if (inputs.extension_type === '7004') {
    if (inputs.city) data['city'] = inputs.city
    if (inputs.state) data['state'] = inputs.state
    if (inputs.zip) data['zip'] = inputs.zip
    if ((inputs as any).suite) data['suite'] = (inputs as any).suite
    if ((inputs as any).country) data['country'] = (inputs as any).country
    // Split form code into 2 digits
    if (inputs.form_code) {
      const code = inputs.form_code.padStart(2, '0')
      data['form_code_digit1'] = code[0]
      data['form_code_digit2'] = code[1]
    }
    if (inputs.calendar_year) data['calendar_year'] = String(inputs.calendar_year).slice(-2)
  } else if (inputs.extension_type === '8868') {
    if ((inputs as any).city_state_zip) data['city_state_zip'] = (inputs as any).city_state_zip
    if (inputs.return_code) data['return_code'] = inputs.return_code
    if (inputs.org_books_care_of) data['org_books_care_of'] = inputs.org_books_care_of
    if (inputs.telephone) data['telephone'] = inputs.telephone
    if (inputs.fax) data['fax'] = inputs.fax
    if (inputs.extension_date) data['extension_date'] = inputs.extension_date
    if (inputs.calendar_year) data['calendar_year'] = String(inputs.calendar_year).slice(-2)
    data['extension_year'] = String(year + 1).slice(-2)
  }

  // Fill text fields
  const { filled, missed } = fillFromMap(form, fieldMap, data)

  // Handle checkboxes
  if (inputs.extension_type === '4868') {
    if (inputs.out_of_country) checkBox(form, 'c1_1')
    if (inputs.form_1040nr_no_wages) checkBox(form, 'c1_2')
  } else if (inputs.extension_type === '7004') {
    if (inputs.is_foreign_corp) checkBox(form, 'c1_1')
    if (inputs.is_consolidated_parent) checkBox(form, 'c1_2')
  } else if (inputs.extension_type === '8868') {
    // Calendar year checkbox
    if (inputs.calendar_year) checkBox(form, 'c1_3[0]')
  }

  return { pdf, filled, missed }
}
