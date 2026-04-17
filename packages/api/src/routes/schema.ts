/**
 * Schema routes — Self-describing API for Claude skill discovery
 *
 * The API describes itself so the skill stays thin and stable.
 * When new forms or years are added, the skill picks them up automatically.
 */
import { Router } from 'express'
import { FORM_INVENTORY } from '../maps/field_maps.js'
import { TAX_TABLES } from '../engine/tax_tables.js'

const router = Router()

// ─── Input schema definitions per form type ───

interface FieldDef {
  name: string
  type: 'number' | 'string' | 'boolean' | 'array'
  required: boolean
  description: string
  category: string
  irs_line?: string
}

interface FormSchema {
  form_type: string
  display_name: string
  description: string
  fields: FieldDef[]
}

export const INPUT_SCHEMAS: Record<string, FormSchema> = {
  '1040': {
    form_type: '1040',
    display_name: 'Form 1040 — U.S. Individual Income Tax Return',
    description: 'Individual income tax return. Supports standard/itemized deductions, QBI, K-1 pass-through, and multi-year brackets.',
    fields: [
      { name: 'filing_status', type: 'string', required: true, description: 'Filing status: single, mfj (married filing jointly), mfs (married filing separately), hoh (head of household), qw (qualifying widow/er)', category: 'filing' },
      { name: 'tax_year', type: 'number', required: true, description: 'Tax year (2018-2025)', category: 'filing' },
      { name: 'wages', type: 'number', required: true, description: 'Total wages, salaries, tips (W-2 box 1)', category: 'income', irs_line: '1z' },
      { name: 'taxable_interest', type: 'number', required: false, description: 'Taxable interest income', category: 'income', irs_line: '2b' },
      { name: 'ordinary_dividends', type: 'number', required: false, description: 'Ordinary dividends', category: 'income', irs_line: '3b' },
      { name: 'qualified_dividends', type: 'number', required: false, description: 'Qualified dividends (taxed at LTCG rates)', category: 'income', irs_line: '3a' },
      { name: 'ira_distributions', type: 'number', required: false, description: 'Taxable IRA distributions', category: 'income', irs_line: '4b' },
      { name: 'pensions_annuities', type: 'number', required: false, description: 'Taxable pensions and annuities', category: 'income', irs_line: '5b' },
      { name: 'social_security', type: 'number', required: false, description: 'Taxable Social Security benefits', category: 'income', irs_line: '6b' },
      { name: 'capital_gains', type: 'number', required: false, description: 'Capital gain or loss (Schedule D)', category: 'income', irs_line: '7' },
      { name: 'schedule1_income', type: 'number', required: false, description: 'Additional income from Schedule 1 (K-1s, rental, etc.)', category: 'income', irs_line: '8' },
      { name: 'student_loan_interest', type: 'number', required: false, description: 'Student loan interest deduction', category: 'adjustments', irs_line: 'Sch1 L21' },
      { name: 'educator_expenses', type: 'number', required: false, description: 'Educator expenses deduction', category: 'adjustments', irs_line: 'Sch1 L11' },
      { name: 'itemized_deductions', type: 'number', required: false, description: 'Total itemized deductions (Schedule A). If 0 or omitted, standard deduction is used.', category: 'deductions' },
      { name: 'use_itemized', type: 'boolean', required: false, description: 'Force itemized deductions even if less than standard', category: 'deductions' },
      { name: 'k1_ordinary_income', type: 'number', required: false, description: 'K-1 ordinary business income (from S-Corp or partnership)', category: 'k1' },
      { name: 'k1_w2_wages', type: 'number', required: false, description: 'K-1 W-2 wages (for QBI limitation)', category: 'k1' },
      { name: 'k1_ubia', type: 'number', required: false, description: 'K-1 UBIA (unadjusted basis of qualified property)', category: 'k1' },
      { name: 'qbi_from_k1', type: 'number', required: false, description: 'Qualified business income for §199A deduction', category: 'k1' },
      { name: 'is_sstb', type: 'boolean', required: false, description: 'Specified Service Trade or Business (law, health, consulting, financial services, etc.) — SSTBs get $0 QBI deduction above the phaseout threshold per IRC §199A(d)', category: 'k1' },
      { name: 'ltcg_portion', type: 'number', required: false, description: 'Portion of capital_gains that is long-term (taxed at preferential 0/15/20% rates). If 0 or omitted, all gains taxed at ordinary rates.', category: 'income', irs_line: '7' },
      { name: 'net_se_income', type: 'number', required: false, description: 'Net self-employment income (Schedule C/SE). Triggers SE tax (15.3%), half-SE deduction, and possibly Additional Medicare Tax.', category: 'income' },
      { name: 'num_dependents', type: 'number', required: false, description: 'Number of qualifying children (for Child Tax Credit)', category: 'dependents' },
      { name: 'withholding', type: 'number', required: false, description: 'Federal income tax withheld (W-2 box 2)', category: 'payments', irs_line: '25d' },
      { name: 'estimated_payments', type: 'number', required: false, description: 'Estimated tax payments made', category: 'payments', irs_line: '26' },
    ],
  },

  '1120': {
    form_type: '1120',
    display_name: 'Form 1120 — U.S. Corporation Income Tax Return',
    description: 'C-Corporation income tax return. Flat 21% rate. Supports NOL, estimated payments.',
    fields: [
      { name: 'tax_year', type: 'number', required: true, description: 'Tax year', category: 'filing' },
      { name: 'gross_receipts', type: 'number', required: true, description: 'Gross receipts or sales', category: 'income', irs_line: '1a' },
      { name: 'returns_allowances', type: 'number', required: false, description: 'Returns and allowances', category: 'income', irs_line: '1b' },
      { name: 'cost_of_goods_sold', type: 'number', required: false, description: 'Cost of goods sold (Schedule A)', category: 'income', irs_line: '2' },
      { name: 'dividends', type: 'number', required: false, description: 'Dividends (Schedule C)', category: 'income', irs_line: '4' },
      { name: 'interest_income', type: 'number', required: false, description: 'Interest', category: 'income', irs_line: '5' },
      { name: 'gross_rents', type: 'number', required: false, description: 'Gross rents', category: 'income', irs_line: '6' },
      { name: 'gross_royalties', type: 'number', required: false, description: 'Gross royalties', category: 'income', irs_line: '7' },
      { name: 'capital_gains', type: 'number', required: false, description: 'Capital gain net income', category: 'income', irs_line: '8' },
      { name: 'net_gain_4797', type: 'number', required: false, description: 'Net gain/loss from Form 4797', category: 'income', irs_line: '9' },
      { name: 'other_income', type: 'number', required: false, description: 'Other income', category: 'income', irs_line: '10' },
      { name: 'officer_compensation', type: 'number', required: false, description: 'Compensation of officers', category: 'deductions', irs_line: '12' },
      { name: 'salaries_wages', type: 'number', required: false, description: 'Salaries and wages (less employment credits)', category: 'deductions', irs_line: '13' },
      { name: 'repairs_maintenance', type: 'number', required: false, description: 'Repairs and maintenance', category: 'deductions', irs_line: '14' },
      { name: 'bad_debts', type: 'number', required: false, description: 'Bad debts', category: 'deductions', irs_line: '15' },
      { name: 'rents', type: 'number', required: false, description: 'Rents', category: 'deductions', irs_line: '16' },
      { name: 'taxes_licenses', type: 'number', required: false, description: 'Taxes and licenses', category: 'deductions', irs_line: '17' },
      { name: 'interest_expense', type: 'number', required: false, description: 'Interest', category: 'deductions', irs_line: '18' },
      { name: 'charitable_contrib', type: 'number', required: false, description: 'Charitable contributions', category: 'deductions', irs_line: '19' },
      { name: 'depreciation', type: 'number', required: false, description: 'Depreciation (Form 4562)', category: 'deductions', irs_line: '20' },
      { name: 'depletion', type: 'number', required: false, description: 'Depletion', category: 'deductions', irs_line: '21' },
      { name: 'advertising', type: 'number', required: false, description: 'Advertising', category: 'deductions', irs_line: '22' },
      { name: 'pension_plans', type: 'number', required: false, description: 'Pension, profit-sharing plans', category: 'deductions', irs_line: '23' },
      { name: 'employee_benefits', type: 'number', required: false, description: 'Employee benefit programs', category: 'deductions', irs_line: '24' },
      { name: 'other_deductions', type: 'number', required: false, description: 'Other deductions (attach statement)', category: 'deductions', irs_line: '26' },
      { name: 'nol_deduction', type: 'number', required: false, description: 'Net operating loss deduction', category: 'tax', irs_line: '29a' },
      { name: 'special_deductions', type: 'number', required: false, description: 'Special deductions total (Schedule C L29b). If 0, computed automatically from dividend tier fields.', category: 'tax', irs_line: '29b' },
      { name: 'dividends_less_20pct_owned', type: 'number', required: false, description: 'Dividends from domestic corps <20% owned — 50% DRD under IRC §243', category: 'drd' },
      { name: 'dividends_20pct_or_more_owned', type: 'number', required: false, description: 'Dividends from domestic corps ≥20% owned — 65% DRD', category: 'drd' },
      { name: 'dividends_affiliated_group', type: 'number', required: false, description: 'Dividends from affiliated group members — 100% DRD', category: 'drd' },
      { name: 'foreign_tax_credit', type: 'number', required: false, description: 'Foreign Tax Credit (Form 1118)', category: 'credits' },
      { name: 'general_business_credit', type: 'number', required: false, description: 'General Business Credit (Form 3800)', category: 'credits' },
      { name: 'prior_year_min_tax_credit', type: 'number', required: false, description: 'Prior year minimum tax credit (Form 8827)', category: 'credits' },
      { name: 'other_credits', type: 'number', required: false, description: 'Other credits (Schedule J Part I)', category: 'credits' },
      { name: 'estimated_tax_paid', type: 'number', required: false, description: 'Estimated tax payments', category: 'payments' },
    ],
  },

  '1120S': {
    form_type: '1120S',
    display_name: 'Form 1120-S — U.S. Income Tax Return for an S Corporation',
    description: 'S-Corporation income tax return. Pass-through entity — income flows to shareholders via K-1. No entity-level tax (usually).',
    fields: [
      { name: 'gross_receipts', type: 'number', required: true, description: 'Gross receipts or sales', category: 'income', irs_line: '1a' },
      { name: 'returns_allowances', type: 'number', required: false, description: 'Returns and allowances', category: 'income', irs_line: '1b' },
      { name: 'cost_of_goods_sold', type: 'number', required: false, description: 'Cost of goods sold', category: 'income', irs_line: '2' },
      { name: 'net_gain_4797', type: 'number', required: false, description: 'Net gain/loss from Form 4797', category: 'income', irs_line: '4' },
      { name: 'other_income', type: 'number', required: false, description: 'Other income/loss', category: 'income', irs_line: '5' },
      { name: 'officer_compensation', type: 'number', required: false, description: 'Compensation of officers', category: 'deductions', irs_line: '7' },
      { name: 'salaries_wages', type: 'number', required: false, description: 'Salaries and wages', category: 'deductions', irs_line: '8' },
      { name: 'repairs_maintenance', type: 'number', required: false, description: 'Repairs and maintenance', category: 'deductions', irs_line: '9' },
      { name: 'bad_debts', type: 'number', required: false, description: 'Bad debts', category: 'deductions', irs_line: '10' },
      { name: 'rents', type: 'number', required: false, description: 'Rents', category: 'deductions', irs_line: '11' },
      { name: 'taxes_licenses', type: 'number', required: false, description: 'Taxes and licenses', category: 'deductions', irs_line: '12' },
      { name: 'interest', type: 'number', required: false, description: 'Interest', category: 'deductions', irs_line: '13' },
      { name: 'depreciation', type: 'number', required: false, description: 'Depreciation', category: 'deductions', irs_line: '14' },
      { name: 'depletion', type: 'number', required: false, description: 'Depletion (other than oil and gas)', category: 'deductions', irs_line: '15' },
      { name: 'advertising', type: 'number', required: false, description: 'Advertising', category: 'deductions', irs_line: '16' },
      { name: 'pension_plans', type: 'number', required: false, description: 'Pension, profit-sharing plans', category: 'deductions', irs_line: '17' },
      { name: 'employee_benefits', type: 'number', required: false, description: 'Employee benefit programs', category: 'deductions', irs_line: '18' },
      { name: 'other_deductions', type: 'number', required: false, description: 'Other deductions', category: 'deductions', irs_line: '20' },
      { name: 'charitable_contrib', type: 'number', required: false, description: 'Charitable contributions (Schedule K)', category: 'schedule_k' },
      { name: 'section_179', type: 'number', required: false, description: 'Section 179 expense deduction (Schedule K)', category: 'schedule_k' },
      { name: 'is_sstb', type: 'boolean', required: false, description: 'Specified Service Trade or Business — flows to shareholders K-1 for QBI deduction limitation', category: 'schedule_k' },
      { name: 'shareholders', type: 'array', required: true, description: 'Array of shareholders: [{name: string, pct: number}]. Percentages must sum to 100.', category: 'shareholders' },
    ],
  },
  '4868': {
    form_type: '4868',
    display_name: 'Form 4868 — Application for Automatic Extension of Time To File U.S. Individual Income Tax Return',
    description: 'Individual extension. Requests 6 extra months to file Form 1040/1040-SR/1040-NR. Does NOT extend time to pay.',
    fields: [
      { name: 'taxpayer_name', type: 'string', required: true, description: 'Your name(s) — include spouse if filing jointly', category: 'identification', irs_line: '1' },
      { name: 'taxpayer_id', type: 'string', required: true, description: 'Your social security number (9 digits, no dashes)', category: 'identification', irs_line: '2' },
      { name: 'spouse_ssn', type: 'string', required: false, description: "Spouse's social security number (if MFJ)", category: 'identification', irs_line: '3' },
      { name: 'address', type: 'string', required: true, description: 'Street address', category: 'identification' },
      { name: 'city', type: 'string', required: true, description: 'City, town, or post office', category: 'identification' },
      { name: 'state', type: 'string', required: true, description: 'State (2-letter code)', category: 'identification' },
      { name: 'zip', type: 'string', required: true, description: 'ZIP code', category: 'identification' },
      { name: 'estimated_tax_liability', type: 'number', required: true, description: 'Estimate of total tax liability for 2025', category: 'tax', irs_line: '4' },
      { name: 'total_payments', type: 'number', required: true, description: 'Total 2025 payments (withholding + estimated payments already made)', category: 'tax', irs_line: '5' },
      { name: 'amount_paying', type: 'number', required: false, description: 'Amount you are paying with this extension', category: 'tax', irs_line: '7' },
      { name: 'out_of_country', type: 'boolean', required: false, description: 'Check if you are "out of the country" and a U.S. citizen or resident', category: 'flags', irs_line: '8' },
      { name: 'form_1040nr_no_wages', type: 'boolean', required: false, description: 'Check if filing 1040-NR and did not receive wages subject to U.S. withholding', category: 'flags', irs_line: '9' },
    ],
  },

  '7004': {
    form_type: '7004',
    display_name: 'Form 7004 — Application for Automatic Extension of Time To File Certain Business Income Tax, Information, and Other Returns',
    description: 'Business extension. Requests automatic extension for 1120, 1120-S, 1065, and other business returns. File separate application for each return.',
    fields: [
      { name: 'taxpayer_name', type: 'string', required: true, description: 'Business name', category: 'identification' },
      { name: 'taxpayer_id', type: 'string', required: true, description: 'Employer Identification Number (EIN, 9 digits, no dash)', category: 'identification' },
      { name: 'address', type: 'string', required: true, description: 'Number and street (or P.O. box)', category: 'identification' },
      { name: 'suite', type: 'string', required: false, description: 'Room or suite number', category: 'identification' },
      { name: 'city', type: 'string', required: true, description: 'City or town', category: 'identification' },
      { name: 'state', type: 'string', required: true, description: 'State or province', category: 'identification' },
      { name: 'country', type: 'string', required: false, description: 'Country (if foreign)', category: 'identification' },
      { name: 'zip', type: 'string', required: true, description: 'ZIP or foreign postal code', category: 'identification' },
      { name: 'form_code', type: 'string', required: true, description: 'Form code for the return being extended (e.g. 12=1120, 25=1120-S, 09=1065). See Form 7004 Part I table.', category: 'filing', irs_line: '1' },
      { name: 'calendar_year', type: 'number', required: false, description: 'Calendar year (if calendar year filer)', category: 'filing', irs_line: '5a' },
      { name: 'is_foreign_corp', type: 'boolean', required: false, description: 'Foreign corporation with no U.S. office', category: 'flags', irs_line: '2' },
      { name: 'is_consolidated_parent', type: 'boolean', required: false, description: 'Common parent filing consolidated return', category: 'flags', irs_line: '3' },
      { name: 'estimated_tax_liability', type: 'number', required: true, description: 'Tentative total tax', category: 'tax', irs_line: '6' },
      { name: 'total_payments', type: 'number', required: true, description: 'Total payments and credits', category: 'tax', irs_line: '7' },
      { name: 'amount_paying', type: 'number', required: false, description: 'Amount you are paying with this extension', category: 'tax' },
    ],
  },

  '8868': {
    form_type: '8868',
    display_name: 'Form 8868 — Application for Extension of Time To File an Exempt Organization Return',
    description: 'Exempt organization extension. Requests automatic 6-month extension for Form 990, 990-PF, 990-T, and other exempt org returns.',
    fields: [
      { name: 'taxpayer_name', type: 'string', required: true, description: 'Name of exempt organization, employer, or other filer', category: 'identification' },
      { name: 'taxpayer_id', type: 'string', required: true, description: 'Taxpayer Identification Number (TIN/EIN)', category: 'identification' },
      { name: 'address', type: 'string', required: true, description: 'Number, street, and room or suite number', category: 'identification' },
      { name: 'city_state_zip', type: 'string', required: true, description: 'City, town or post office, state, and ZIP code', category: 'identification' },
      { name: 'return_code', type: 'string', required: true, description: 'Return code (e.g. 01=990/990-EZ, 04=990-PF, 05=990-T sec.401a). See Form 8868 table.', category: 'filing' },
      { name: 'org_books_care_of', type: 'string', required: false, description: 'Person/entity that has care of the books', category: 'identification' },
      { name: 'telephone', type: 'string', required: false, description: 'Telephone number', category: 'identification' },
      { name: 'fax', type: 'string', required: false, description: 'Fax number', category: 'identification' },
      { name: 'extension_date', type: 'string', required: false, description: 'Requested extension date (e.g. "November 15")', category: 'filing', irs_line: '1' },
      { name: 'calendar_year', type: 'number', required: false, description: 'Calendar year for the return', category: 'filing', irs_line: '1' },
      { name: 'estimated_tax_liability', type: 'number', required: false, description: 'Tentative tax less nonrefundable credits (for 990-PF, 990-T, 4720, 6069 only)', category: 'tax', irs_line: '3a' },
      { name: 'total_payments', type: 'number', required: false, description: 'Refundable credits and estimated tax payments made', category: 'tax', irs_line: '3b' },
      { name: 'amount_paying', type: 'number', required: false, description: 'Amount you are paying with this extension', category: 'tax' },
    ],
  },

  '4562': {
    form_type: '4562',
    display_name: 'Form 4562 — Depreciation and Amortization',
    description: 'Calculates depreciation deductions for business assets using MACRS, straight-line, or Section 179 expensing. Attach to income tax return.',
    fields: [
      { name: 'taxpayer_name', type: 'string', required: true, description: 'Name(s) shown on return', category: 'identification' },
      { name: 'business_activity', type: 'string', required: true, description: 'Business or activity to which this form relates', category: 'identification' },
      { name: 'taxpayer_id', type: 'string', required: true, description: 'Identifying number (SSN or EIN)', category: 'identification' },
      { name: 'tax_year', type: 'number', required: true, description: 'Tax year', category: 'filing' },
      { name: 'section_179_total_cost', type: 'number', required: false, description: 'Total cost of section 179 property placed in service', category: 'section_179', irs_line: '2' },
      { name: 'section_179_carryover', type: 'number', required: false, description: 'Carryover of disallowed deduction from prior year', category: 'section_179', irs_line: '10' },
      { name: 'business_income_limit', type: 'number', required: false, description: 'Business income limitation', category: 'section_179', irs_line: '11' },
      { name: 'special_depreciation', type: 'number', required: false, description: 'Special (bonus) depreciation allowance for qualified property', category: 'depreciation', irs_line: '14' },
      { name: 'other_depreciation', type: 'number', required: false, description: 'Other depreciation including ACRS', category: 'depreciation', irs_line: '16' },
      { name: 'macrs_prior_years', type: 'number', required: false, description: 'MACRS deductions for assets placed in service in prior tax years', category: 'depreciation', irs_line: '17' },
      { name: 'assets', type: 'array', required: false, description: 'Array of assets: [{description, date_placed, cost_basis, business_pct, recovery_period, method, convention, year_number, section_179_elected}]', category: 'assets' },
      { name: 'amortization_prior', type: 'number', required: false, description: 'Amortization of costs that began before current tax year', category: 'amortization', irs_line: '43' },
    ],
  },

  '8594': {
    form_type: '8594',
    display_name: 'Form 8594 — Asset Acquisition Statement Under Section 1060',
    description: 'Reports allocation of purchase price across 7 asset classes in an asset acquisition. Both buyer and seller must file.',
    fields: [
      { name: 'taxpayer_name', type: 'string', required: true, description: 'Name as shown on return', category: 'identification' },
      { name: 'taxpayer_id', type: 'string', required: true, description: 'Identifying number (SSN or EIN)', category: 'identification' },
      { name: 'is_purchaser', type: 'boolean', required: true, description: 'True if purchaser, false if seller', category: 'identification' },
      { name: 'other_party_name', type: 'string', required: true, description: 'Name of other party to the transaction', category: 'general', irs_line: '1' },
      { name: 'other_party_id', type: 'string', required: true, description: 'Other party identifying number', category: 'general', irs_line: '1' },
      { name: 'other_party_address', type: 'string', required: false, description: 'Other party address', category: 'general' },
      { name: 'other_party_city', type: 'string', required: false, description: 'Other party city, state, ZIP', category: 'general' },
      { name: 'date_of_sale', type: 'string', required: true, description: 'Date of sale (MM/DD/YYYY)', category: 'general', irs_line: '2' },
      { name: 'total_sales_price', type: 'number', required: true, description: 'Total sales price (consideration)', category: 'general', irs_line: '3' },
      { name: 'class_i_fmv', type: 'number', required: false, description: 'Class I FMV (cash/equivalents)', category: 'allocation', irs_line: '4' },
      { name: 'class_i_alloc', type: 'number', required: false, description: 'Class I allocation', category: 'allocation', irs_line: '4' },
      { name: 'class_ii_fmv', type: 'number', required: false, description: 'Class II FMV (securities)', category: 'allocation', irs_line: '4' },
      { name: 'class_ii_alloc', type: 'number', required: false, description: 'Class II allocation', category: 'allocation', irs_line: '4' },
      { name: 'class_iii_fmv', type: 'number', required: false, description: 'Class III FMV (receivables)', category: 'allocation', irs_line: '4' },
      { name: 'class_iii_alloc', type: 'number', required: false, description: 'Class III allocation', category: 'allocation', irs_line: '4' },
      { name: 'class_iv_fmv', type: 'number', required: false, description: 'Class IV FMV (inventory)', category: 'allocation', irs_line: '4' },
      { name: 'class_iv_alloc', type: 'number', required: false, description: 'Class IV allocation', category: 'allocation', irs_line: '4' },
      { name: 'class_v_fmv', type: 'number', required: false, description: 'Class V FMV (other assets)', category: 'allocation', irs_line: '4' },
      { name: 'class_v_alloc', type: 'number', required: false, description: 'Class V allocation', category: 'allocation', irs_line: '4' },
      { name: 'class_vi_vii_fmv', type: 'number', required: false, description: 'Class VI/VII FMV (intangibles/goodwill)', category: 'allocation', irs_line: '4' },
      { name: 'class_vi_vii_alloc', type: 'number', required: false, description: 'Class VI/VII allocation', category: 'allocation', irs_line: '4' },
      { name: 'has_allocation_agreement', type: 'boolean', required: false, description: 'Did parties agree on allocation in contract?', category: 'questions', irs_line: '5' },
      { name: 'has_covenant', type: 'boolean', required: false, description: 'Did purchaser acquire license/covenant not to compete?', category: 'questions', irs_line: '6' },
    ],
  },
}

// ─── GET /api/schema — Full API manifest ───
router.get('/', (_req, res) => {
  const supportedYears = Object.keys(TAX_TABLES).map(Number).sort()

  res.json({
    api_version: '0.1.0',
    supported_years: supportedYears,
    supported_forms: Object.keys(INPUT_SCHEMAS),
    forms: Object.entries(INPUT_SCHEMAS).map(([key, schema]) => ({
      form_type: key,
      display_name: schema.display_name,
      description: schema.description,
      required_fields: schema.fields.filter(f => f.required).map(f => f.name),
      total_fields: schema.fields.length,
    })),
    form_inventory: FORM_INVENTORY,
    endpoints: {
      entities: {
        list: 'GET /api/entities',
        get: 'GET /api/entities/:id',
        create: 'POST /api/entities',
        update: 'PUT /api/entities/:id',
      },
      returns: {
        list: 'GET /api/returns',
        get: 'GET /api/returns/:id',
        validate: 'POST /api/returns/validate',
        compute: 'POST /api/returns/compute',
        pdf: 'GET /api/returns/:id/pdf',
        compare: 'GET /api/returns/compare/:entity_id',
        process_document: 'POST /api/returns/process/:document_id',
      },
      scenarios: {
        list: 'GET /api/scenarios',
        create: 'POST /api/scenarios',
        compute: 'POST /api/scenarios/:id/compute',
        analyze: 'POST /api/scenarios/:id/analyze',
        promote: 'POST /api/scenarios/:id/promote',
        compare: 'POST /api/scenarios/compare',
      },
      documents: {
        presign: 'GET /api/documents/presign?filename=...',
        register: 'POST /api/documents/register',
        list: 'GET /api/documents',
        get: 'GET /api/documents/:id',
        download: 'GET /api/documents/:id/download',
      },
      compute: {
        '1040': 'POST /api/compute/1040',
        '1120': 'POST /api/compute/1120',
        '1120s': 'POST /api/compute/1120s',
        cascade: 'POST /api/compute/cascade',
      },
      extensions: {
        compute: 'POST /api/returns/extension — compute + fill extension (4868/7004/8868)',
        validate: 'POST /api/returns/extension/validate — validate extension inputs',
      },
      quickbooks: {
        connect: 'GET /api/qbo/connect/:entity_id — returns auth_url for OAuth',
        callback: 'GET /api/qbo/callback — OAuth redirect (automatic)',
        status: 'GET /api/qbo/:entity_id/status',
        disconnect: 'DELETE /api/qbo/:entity_id/disconnect',
        financials: 'GET /api/qbo/:entity_id/financials?year=YYYY — unified P&L + Balance Sheet',
        reports: 'GET /api/qbo/:entity_id/reports/:report — profit-and-loss(-detail), balance-sheet(-detail), trial-balance, general-ledger, cash-flow, transaction-list, accounts-receivable, accounts-payable, vendor-balance, customer-balance',
        accounts: 'GET /api/qbo/:entity_id/accounts — chart of accounts with balances',
        transactions: 'GET /api/qbo/:entity_id/transactions?year=&account=&start_date=&end_date= — filtered transaction list',
        query: 'GET /api/qbo/:entity_id/query?q=SELECT... — raw QBO query',
      },
    },
    auth: {
      method: 'API key via x-api-key header',
      key_format: 'txk_...',
    },
  })
})

// ─── GET /api/schema/:form_type/:year — Input schema for a form+year ───
router.get('/:form_type/:year', (req, res) => {
  const { form_type, year } = req.params
  const yearNum = parseInt(year)

  const schema = INPUT_SCHEMAS[form_type]
  if (!schema) {
    return res.status(404).json({
      error: `Unknown form type: ${form_type}`,
      supported: Object.keys(INPUT_SCHEMAS),
    })
  }

  if (!TAX_TABLES[yearNum]) {
    return res.status(404).json({
      error: `No tax tables for year ${yearNum}`,
      supported_years: Object.keys(TAX_TABLES).map(Number).sort(),
    })
  }

  // Group fields by category
  const categories: Record<string, FieldDef[]> = {}
  for (const field of schema.fields) {
    if (!categories[field.category]) categories[field.category] = []
    categories[field.category].push(field)
  }

  res.json({
    ...schema,
    tax_year: yearNum,
    categories,
    // Folds in the old /api/tax-tables/:year — brackets, standard deduction, etc.
    tax_tables: TAX_TABLES[yearNum],
  })
})

// ─── GET /api/schema/:form_type/qbo-mapping — QBO P&L → tax input mappings ───
router.get('/:form_type/qbo-mapping', (req, res) => {
  const { form_type } = req.params

  // QBO P&L category → tax input field
  // These mappings cover the standard QBO P&L report categories
  const baseMappings: Record<string, Record<string, string>> = {
    '1120': {
      'Total Income': 'gross_receipts',
      'Cost of Goods Sold': 'cost_of_goods_sold',
      'Payroll Expenses': 'salaries_wages',
      'Rent or Lease': 'rents',
      'Insurance': 'other_deductions',
      'Utilities': 'other_deductions',
      'Office Expenses': 'other_deductions',
      'Professional Fees': 'other_deductions',
      'Advertising': 'advertising',
      'Depreciation': 'depreciation',
      'Taxes & Licenses': 'taxes_licenses',
      'Interest Paid': 'interest_expense',
      'Repairs & Maintenance': 'repairs_maintenance',
      'Travel': 'other_deductions',
      'Meals': 'other_deductions',
      'Officers Compensation': 'officer_compensation',
    },
    '1120S': {
      'Total Income': 'gross_receipts',
      'Cost of Goods Sold': 'cost_of_goods_sold',
      'Payroll Expenses': 'salaries_wages',
      'Rent or Lease': 'rents',
      'Insurance': 'other_deductions',
      'Utilities': 'other_deductions',
      'Office Expenses': 'other_deductions',
      'Professional Fees': 'other_deductions',
      'Advertising': 'advertising',
      'Depreciation': 'depreciation',
      'Taxes & Licenses': 'taxes_licenses',
      'Interest Paid': 'interest',
      'Repairs & Maintenance': 'repairs_maintenance',
      'Travel': 'other_deductions',
      'Meals': 'other_deductions',
      'Officers Compensation': 'officer_compensation',
    },
    '1040': {
      'Wages & Salaries': 'wages',
      'Interest Income': 'taxable_interest',
      'Dividend Income': 'ordinary_dividends',
    },
  }

  const mappings = baseMappings[form_type]
  if (!mappings) {
    return res.status(404).json({
      error: `No QBO mappings for form type: ${form_type}`,
      supported: Object.keys(baseMappings),
    })
  }

  res.json({
    form_type,
    description: 'Map QuickBooks Online P&L categories to tax form input fields. For categories that map to "other_deductions", combine them into a single total.',
    mappings,
    notes: [
      'Pull QBO P&L via GET /reports/ProfitAndLoss (QBO Reports API)',
      'Categories mapping to "other_deductions" should be summed together',
      'Officer compensation may appear under Payroll in QBO — separate it for the tax form',
      'Verify gross_receipts against QBO "Total Income" (not "Total Revenue" which may include non-operating)',
    ],
  })
})

export default router
