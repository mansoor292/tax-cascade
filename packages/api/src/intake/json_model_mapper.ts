/**
 * JSON → Canonical Model Mapper
 *
 * Handles three input formats and produces a unified CanonicalModel.
 *
 * Sources:
 *   TextractOutput   — raw KV pairs from AWS Textract
 *   GeminiOutput     — structured JSON from Gemini extraction prompt
 *   QBOReport        — P&L / balance sheet from QuickBooks Online API
 *
 * Output:
 *   MappingResult    — canonical model + per-field confidence + audit trail
 */

// ─────────────────────────────────────────────────────────────────────────────
// INPUT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface TextractKVPair {
  key:        string
  value:      string
  confidence?: number   // 0-100, from Textract
  page?:      number
}

export interface TextractOutput {
  source:           'textract'
  form_type?:       string   // may be absent — we detect it
  tax_year?:        number
  key_value_pairs:  TextractKVPair[]
}

// Gemini output matches our extraction prompt schema exactly
export interface GeminiOutput {
  source:           'gemini'
  form:             string   // '1120-S', '1120', '1040'
  tax_year:         number | null
  ein:              string | null
  entity_name:      string | null
  address?:         string | null
  city_state_zip?:  string | null
  date_incorporated?: string | null
  s_election_date?: string | null
  total_assets?:    number | null
  num_shareholders?: number | null
  business_activity_code?: string | null
  accounting_method?: string | null
  income: Record<string, number | null>
  deductions: Record<string, number | null>
  schedule_k?: Record<string, number | null>
  schedule_m2?: Record<string, number | null>
  form_1125a?: Record<string, number | null>
  form_1125e?: Record<string, number | null>
  schedule_k1?: Record<string, any>
}

// QuickBooks Online P&L report structure (simplified)
export interface QBOReport {
  source:           'qbo'
  entity_id?:       string
  period_start:     string   // ISO date
  period_end:       string
  report_type:      'ProfitAndLoss' | 'BalanceSheet'
  rows:             QBORow[]
}

export interface QBORow {
  group:      string   // 'Income', 'Expenses', 'GrossProfit', etc.
  label:      string
  amount:     number
  account_id?: string
}

// Union input type
export type MapperInput = TextractOutput | GeminiOutput | QBOReport | Record<string, any>

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type FieldSource = 'extracted' | 'computed' | 'manual' | 'qbo' | 'default'
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'inferred'

export interface FieldMapping {
  canonical_key:    string
  value:            number | string | null
  raw_value?:       string           // original text before parsing
  confidence:       number           // 0-1
  confidence_level: ConfidenceLevel
  source:           FieldSource
  source_key?:      string           // original key in the input (e.g. "1a Gross receipts...")
  computed_from?:   string[]         // if derived, which keys it depends on
}

export interface MappingResult {
  form_type:        string
  tax_year:         number | null
  model:            Record<string, number | string | null>  // flat dot-path canonical
  fields:           FieldMapping[]                          // full audit trail
  unmapped:         string[]                                // input keys not mapped
  missing_required: string[]                                // required keys absent
  warnings:         string[]
  stats: {
    total_input_keys: number
    mapped:           number
    high_confidence:  number
    medium_confidence: number
    low_confidence:   number
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUZZY RULES — Textract label → canonical key
// Pattern matched against lowercased, stripped label text
// ─────────────────────────────────────────────────────────────────────────────

interface FuzzyRule {
  pattern:       RegExp
  canonical_key: string
  confidence:    number   // base confidence for this rule (0-1)
}

const FUZZY_RULES_1120S: FuzzyRule[] = [
  // Meta
  { pattern: /^name.*corporation|corporation.*name/,               canonical_key: 'meta.entity_name',              confidence: 0.95 },
  { pattern: /employer\s+identification|^d\s+employer|\bein\b/,    canonical_key: 'meta.ein',                       confidence: 0.97 },
  { pattern: /date\s+incorporated/,                                canonical_key: 'meta.date_incorporated',         confidence: 0.98 },
  { pattern: /s\s+election\s+effective/,                           canonical_key: 'meta.s_election_date',           confidence: 0.98 },
  { pattern: /^f\s+total\s+assets|total\s+assets.*see\s+instr/,   canonical_key: 'meta.total_assets',              confidence: 0.95 },
  { pattern: /number\s+of\s+shareholders|^i\s+enter.*number.*share/, canonical_key: 'meta.num_shareholders',       confidence: 0.92 },
  { pattern: /business\s+activity\s+code|^b\s+business\s+activity/, canonical_key: 'meta.business_activity_code', confidence: 0.95 },
  // Income
  { pattern: /1a\s+gross\s+receipts|gross\s+receipts\s+or\s+sales/, canonical_key: 'income.gross_receipts',        confidence: 0.98 },
  { pattern: /returns\s+and\s+allowances|1b\s+returns/,            canonical_key: 'income.returns_allowances',     confidence: 0.97 },
  { pattern: /1c\s+balance.*subtract.*1b|balance.*subtract.*line.*1b/, canonical_key: 'income.balance_1c',          confidence: 0.95, },
  { pattern: /cost\s+of\s+goods\s+sold/,                           canonical_key: 'income.cost_of_goods_sold',     confidence: 0.98 },
  { pattern: /3\s+gross\s+profit|gross\s+profit.*subtract.*line\s+2/, canonical_key: 'income.gross_profit',        confidence: 0.97 },
  { pattern: /4\s+net\s+gain.*4797|form\s+4797.*line.*17/,         canonical_key: 'income.net_gain_4797',          confidence: 0.96 },
  { pattern: /^5\s+other\s+income|other\s+income.*loss.*line\s+5/, canonical_key: 'income.other_income',           confidence: 0.90 },
  { pattern: /6\s+total\s+income.*add\s+lines\s+3/,                canonical_key: 'income.total_income',           confidence: 0.97 },
  // Deductions
  { pattern: /7\s+compensation.*officer|compensation\s+of\s+officers/, canonical_key: 'deductions.officer_compensation', confidence: 0.97 },
  { pattern: /8\s+salaries.*wages|salaries\s+and\s+wages/,         canonical_key: 'deductions.salaries_wages',     confidence: 0.97 },
  { pattern: /9\s+repairs.*maintenance|repairs\s+and\s+maintenance/, canonical_key: 'deductions.repairs_maintenance', confidence: 0.97 },
  { pattern: /10\s+bad\s+debts|^bad\s+debts/,                     canonical_key: 'deductions.bad_debts',           confidence: 0.97 },
  { pattern: /^11\s+rents\b/,                                      canonical_key: 'deductions.rents',              confidence: 0.94 },
  { pattern: /12\s+taxes\s+and\s+licenses/,                        canonical_key: 'deductions.taxes_licenses',     confidence: 0.98 },
  { pattern: /^13\s+interest|13\s+interest.*see\s+instructions/,   canonical_key: 'deductions.interest',           confidence: 0.93 },
  { pattern: /14\s+depreciation.*4562/,                            canonical_key: 'deductions.depreciation',       confidence: 0.97 },
  { pattern: /15\s+depletion/,                                     canonical_key: 'deductions.depletion',          confidence: 0.98 },
  { pattern: /^16\s+advertising/,                                  canonical_key: 'deductions.advertising',        confidence: 0.97 },
  { pattern: /17\s+pension.*profit.sharing/,                       canonical_key: 'deductions.pension_plans',      confidence: 0.97 },
  { pattern: /18\s+employee\s+benefit/,                            canonical_key: 'deductions.employee_benefits',  confidence: 0.97 },
  { pattern: /19\s+other\s+deductions.*attach/,                    canonical_key: 'deductions.other_deductions',   confidence: 0.96 },
  { pattern: /20\s+total\s+deductions.*add\s+lines\s+7/,           canonical_key: 'deductions.total_deductions',   confidence: 0.97 },
  { pattern: /21\s+ordinary\s+business.*subtract.*20/,             canonical_key: 'deductions.ordinary_income_loss', confidence: 0.97 },
  // Schedule K
  { pattern: /ordinary\s+business.*income.*page\s+1.*line\s+21/,  canonical_key: 'schedule_k.ordinary_income',    confidence: 0.95 },
  { pattern: /12a\s+charitable.*contrib|charitable\s+contributions/, canonical_key: 'schedule_k.charitable_contrib', confidence: 0.96 },
  { pattern: /16d\s+distributions|distributions.*attach.*statement.*16d/, canonical_key: 'schedule_k.distributions', confidence: 0.95 },
  // Payments
  { pattern: /23a\s+.*estimated.*tax.*payments/,                   canonical_key: 'payments.estimated_payments',   confidence: 0.94 },
  { pattern: /26\s+overpayment|overpayment.*line\s+23d.*larger/,   canonical_key: 'payments.overpayment',          confidence: 0.95 },
]

const FUZZY_RULES_1120: FuzzyRule[] = [
  // ── Meta ──
  { pattern: /employer\s+identification|\bein\b/,                          canonical_key: 'meta.ein',                          confidence: 0.97 },
  { pattern: /^name$|name.*corporation/,                                   canonical_key: 'meta.entity_name',                  confidence: 0.90 },
  { pattern: /^number.*street.*room|^number.*street.*suite/,                canonical_key: 'meta.address',                      confidence: 0.95 },
  { pattern: /^city.*town.*state.*province|^city.*town.*state/,            canonical_key: 'meta.city_state_zip',               confidence: 0.95 },
  { pattern: /^c\s+date\s+incorporated/,                                   canonical_key: 'meta.date_incorporated',            confidence: 0.98 },
  { pattern: /total\s+assets.*see\s+instructions|^d\s+total\s+assets/,    canonical_key: 'meta.total_assets',                 confidence: 0.95 },
  { pattern: /business\s+activity\s+code/,                                 canonical_key: 'meta.business_activity_code',       confidence: 0.95 },
  { pattern: /^b\s+business\s+activity$/,                                  canonical_key: 'meta.business_activity',            confidence: 0.93 },
  { pattern: /^c\s+product\s+or\s+service/,                               canonical_key: 'meta.product_service',              confidence: 0.93 },

  // ── Page 1: Income (Lines 1-11) ──
  { pattern: /1a\s+gross\s+receipts/,                                      canonical_key: 'income.L1a_gross_receipts',         confidence: 0.98 },
  { pattern: /1b\s+returns.*allowances|^b\s+returns.*allowances/,          canonical_key: 'income.L1b_returns',                confidence: 0.97 },
  { pattern: /1c.*balance.*subtract.*1b|^c\s+balance.*subtract/,           canonical_key: 'income.L1c_balance',                confidence: 0.97 },
  { pattern: /^2\s+cost\s+of\s+goods/,                                    canonical_key: 'income.L2_cogs',                    confidence: 0.98 },
  { pattern: /^3\s+gross\s+profit/,                                        canonical_key: 'income.L3_gross_profit',            confidence: 0.97 },
  { pattern: /^4\s+dividends.*schedule\s+c|dividends.*inclusions.*schedule\s+c/,canonical_key:'income.L4_dividends',           confidence: 0.96 },
  { pattern: /^5\s+interest\s+5/,                                          canonical_key: 'income.L5_interest',                confidence: 0.97 },
  { pattern: /^6\s+gross\s+rents/,                                         canonical_key: 'income.L6_gross_rents',             confidence: 0.97 },
  { pattern: /^7\s+gross\s+royalties/,                                     canonical_key: 'income.L7_gross_royalties',         confidence: 0.97 },
  { pattern: /^8\s+capital\s+gain.*net\s+income/,                          canonical_key: 'income.L8_capital_gains',           confidence: 0.96 },
  { pattern: /^9\s+net\s+gain.*4797/,                                      canonical_key: 'income.L9_net_gain_4797',           confidence: 0.96 },
  { pattern: /^10\s+other\s+income.*attach\s+statement/,                   canonical_key: 'income.L10_other_income',           confidence: 0.95 },
  { pattern: /^11\s+total\s+income.*add\s+lines\s+3/,                     canonical_key: 'income.L11_total_income',            confidence: 0.97 },

  // ── Page 1: Deductions (Lines 12-27) ──
  { pattern: /^12\s+compensation.*officer|officer.*compensation.*1125/,    canonical_key: 'deductions.L12_officer_comp',       confidence: 0.97 },
  { pattern: /^13\s+salaries\s+and\s+wages/,                              canonical_key: 'deductions.L13_salaries',            confidence: 0.97 },
  { pattern: /^14\s+repairs.*maintenance/,                                 canonical_key: 'deductions.L14_repairs',             confidence: 0.97 },
  { pattern: /^15\s+bad\s+debts/,                                         canonical_key: 'deductions.L15_bad_debts',           confidence: 0.97 },
  { pattern: /^16\s+rents\b/,                                             canonical_key: 'deductions.L16_rents',               confidence: 0.94 },
  { pattern: /^17\s+taxes\s+and\s+licenses/,                              canonical_key: 'deductions.L17_taxes_licenses',      confidence: 0.98 },
  { pattern: /^18\s+interest.*see\s+instructions/,                         canonical_key: 'deductions.L18_interest',            confidence: 0.93 },
  { pattern: /^19\s+charitable\s+contributions/,                           canonical_key: 'deductions.L19_charitable',          confidence: 0.97 },
  { pattern: /^20\s+depreciation.*form\s+4562/,                            canonical_key: 'deductions.L20_depreciation',        confidence: 0.97 },
  { pattern: /^21\s+depletion\b/,                                         canonical_key: 'deductions.L21_depletion',           confidence: 0.98 },
  { pattern: /^22\s+advertising/,                                          canonical_key: 'deductions.L22_advertising',         confidence: 0.97 },
  { pattern: /^23\s+pension.*profit.sharing/,                              canonical_key: 'deductions.L23_pension',             confidence: 0.97 },
  { pattern: /^24\s+employee\s+benefit/,                                   canonical_key: 'deductions.L24_employee_benefits',   confidence: 0.97 },
  { pattern: /^25\s+energy\s+efficient|^25.*form\s+7205/,                  canonical_key: 'deductions.L25_energy',              confidence: 0.96 },
  { pattern: /^26\s+other\s+deductions/,                                   canonical_key: 'deductions.L26_other_deductions',    confidence: 0.96 },
  { pattern: /^27\s+total\s+deductions.*add\s+lines\s+12/,                canonical_key: 'deductions.L27_total_deductions',    confidence: 0.97 },

  // ── Page 1: Taxable Income & Tax (Lines 28-37) ──
  { pattern: /^28\s+taxable\s+income.*before.*nol/,                        canonical_key: 'tax.L28_ti_before_nol',             confidence: 0.97 },
  { pattern: /^29a\s+net\s+operating\s+loss/,                              canonical_key: 'tax.L29a_nol',                      confidence: 0.97 },
  { pattern: /^29b\s+special\s+deductions/,                                canonical_key: 'tax.L29b_special_ded',              confidence: 0.97 },
  { pattern: /^30\s+taxable\s+income.*subtract.*29c/,                     canonical_key: 'tax.L30_taxable_income',             confidence: 0.97 },
  { pattern: /^31\s+total\s+tax.*schedule\s+j/,                           canonical_key: 'tax.L31_total_tax',                  confidence: 0.97 },
  { pattern: /^33\s+total\s+payments.*credits.*schedule\s+j/,             canonical_key: 'payments.L33_total_payments',        confidence: 0.97 },
  { pattern: /^35\s+amount\s+owed/,                                        canonical_key: 'payments.L35_amount_owed',           confidence: 0.95 },
  { pattern: /^36\s+overpayment/,                                          canonical_key: 'payments.L36_overpayment',           confidence: 0.95 },
  { pattern: /refunded/,                                                    canonical_key: 'payments.L37_refunded',              confidence: 0.90 },

  // ── Schedule J: Tax Computation (Page 3) ──
  { pattern: /^1a\s+income\s+tax.*see\s+instructions/,                    canonical_key: 'schedJ.J1a_income_tax',              confidence: 0.97 },
  { pattern: /^2\s+total\s+income\s+tax.*add\s+lines\s+1a/,              canonical_key: 'schedJ.J2_total_income_tax',          confidence: 0.97 },
  { pattern: /^4\s+add\s+lines\s+2\s+and\s+3/,                           canonical_key: 'schedJ.J4_add_2_3',                  confidence: 0.95 },
  { pattern: /^7\s+subtract\s+line\s+6\s+from\s+line\s+4/,               canonical_key: 'schedJ.J7_subtract_6_4',             confidence: 0.95 },
  { pattern: /^11a\s+total\s+tax\s+before\s+deferred/,                    canonical_key: 'schedJ.J11a_total_before_def',       confidence: 0.97 },
  { pattern: /^12\s+total\s+tax.*subtract.*11b.*11c/,                     canonical_key: 'schedJ.J12_total_tax',               confidence: 0.97 },
  { pattern: /^13\s+preceding\s+year.*overpayment.*credited/,             canonical_key: 'schedJ.J13_prior_overpayment',       confidence: 0.97 },
  { pattern: /^14\s+current\s+year.*estimated\s+tax\s+payments/,          canonical_key: 'schedJ.J14_estimated_payments',       confidence: 0.97 },
  { pattern: /^19\s+total\s+payments.*combine\s+lines\s+13/,              canonical_key: 'schedJ.J19_total_payments',           confidence: 0.97 },
  { pattern: /^23\s+total\s+payments.*credits.*add\s+lines\s+19/,         canonical_key: 'schedJ.J23_total_pay_credits',        confidence: 0.97 },

  // ── Schedule M-1: Book-Tax Reconciliation ──
  { pattern: /^1\s+net\s+income.*loss.*per\s+books/,                      canonical_key: 'schedM1.L1_net_income_books',        confidence: 0.96 },
  { pattern: /^2\s+federal\s+income\s+tax\s+per\s+books/,                canonical_key: 'schedM1.L2_fed_tax_books',            confidence: 0.96 },
  { pattern: /^5\s+expenses\s+recorded.*not\s+deducted/,                  canonical_key: 'schedM1.L5_expenses_not_ded',        confidence: 0.95 },
  { pattern: /^6\s+add\s+lines\s+1\s+through\s+5/,                       canonical_key: 'schedM1.L6_add_1_thru_5',            confidence: 0.95 },
  { pattern: /^8\s+deductions.*not\s+charged.*book\s+income/,             canonical_key: 'schedM1.L8_ded_not_charged',         confidence: 0.95 },
  { pattern: /^9\s+add\s+lines\s+7\s+and\s+8/,                           canonical_key: 'schedM1.L9_add_7_8',                 confidence: 0.95 },
  { pattern: /^10\s+income.*page\s+1.*line\s+28/,                         canonical_key: 'schedM1.L10_income_line28',          confidence: 0.95 },

  // ── Schedule M-2: Retained Earnings ──
  { pattern: /^1\s+balance\s+at\s+beginning\s+of\s+year/,                canonical_key: 'schedM2.L1_beg_balance',             confidence: 0.95 },
  { pattern: /^4\s+add\s+lines?\s+1.*2.*and\s+3/,                        canonical_key: 'schedM2.L4_add',                     confidence: 0.93 },
  { pattern: /^8\s+balance\s+at\s+end\s+of\s+year/,                      canonical_key: 'schedM2.L8_end_balance',             confidence: 0.95 },

  // ── Form 1125-A: Cost of Goods Sold ──
  { pattern: /^3\s+cost\s+of\s+labor/,                                    canonical_key: 'cogs.L3_labor',                      confidence: 0.97 },
  { pattern: /^5\s+other\s+costs.*attach/,                                canonical_key: 'cogs.L5_other',                      confidence: 0.96 },
  { pattern: /^6\s+total.*add\s+lines\s+1\s+through\s+5/,                canonical_key: 'cogs.L6_total',                      confidence: 0.95 },
  { pattern: /^8\s+cost\s+of\s+goods\s+sold.*subtract\s+line\s+7/,       canonical_key: 'cogs.L8_cogs',                       confidence: 0.97 },

  // ── Form 4562: Depreciation ──
  { pattern: /^17\s+macrs\s+deductions.*placed\s+in\s+service.*before/,   canonical_key: 'dep.L17_macrs_prior',                confidence: 0.96 },
  { pattern: /^22\s+total.*add\s+amounts.*line\s+12/,                     canonical_key: 'dep.L22_total',                      confidence: 0.95 },
  { pattern: /^43\s+amortization.*costs.*began\s+before/,                 canonical_key: 'dep.L43_amortization',               confidence: 0.96 },
  { pattern: /^44\s+total.*add\s+amounts.*column.*f/,                     canonical_key: 'dep.L44_total_amort',                confidence: 0.95 },

  // ── NOL Statement ──
  { pattern: /net\s+operating\s+loss\s+carryover\s+to\s+next/,            canonical_key: 'nol.carryover_next_year',            confidence: 0.95 },

  // ── Preparer Info ──
  { pattern: /^ptin$/,                                                     canonical_key: 'preparer.ptin',                     confidence: 0.95 },
  { pattern: /^firm.*ein$/,                                                canonical_key: 'preparer.firm_ein',                 confidence: 0.95 },
  { pattern: /^firm.*address$/,                                            canonical_key: 'preparer.firm_address',             confidence: 0.93 },
  { pattern: /^phone\s+no\./,                                             canonical_key: 'preparer.phone',                    confidence: 0.93 },
]

const FUZZY_RULES_1040: FuzzyRule[] = [
  // Income — Textract labels may start with letter (Z, b) or number (1a, 2b)
  { pattern: /1a\s+total\s+amount.*w-2|total\s+amount.*form.*w-2.*1a/,                        canonical_key: 'income.w2_wages',            confidence: 0.97 },
  { pattern: /add\s+lines\s+1a\s+through\s+1h\s+1z|^z\s+add\s+lines\s+1a/,                  canonical_key: 'income.wages',               confidence: 0.95 },
  { pattern: /taxable\s+interest.*2b|2b\s+taxable\s+interest|^b\s+taxable\s+interest/,        canonical_key: 'income.taxable_interest',    confidence: 0.97 },
  { pattern: /qualified\s+dividends.*3a|3a\s+qualified|^3a\s+qualified/,                       canonical_key: 'income.qualified_dividends', confidence: 0.97 },
  { pattern: /ordinary\s+dividends.*3b|3b\s+ordinary|^b\s+ordinary\s+dividends/,              canonical_key: 'income.ordinary_dividends',  confidence: 0.97 },
  { pattern: /capital\s+gain.*(?:loss|7)|7\s+capital\s+gain|7a\s+capital\s+gain/,              canonical_key: 'income.capital_gains',        confidence: 0.96 },
  { pattern: /additional\s+income.*schedule\s+1.*(?:line\s+10|8)|8\s+additional\s+income/,     canonical_key: 'income.schedule1_income',    confidence: 0.96 },
  { pattern: /add\s+lines\s+1z.*this\s+is\s+your\s+total\s+incom|9\s+add\s+lines\s+1z/,     canonical_key: 'income.total_income',        confidence: 0.97 },
  { pattern: /adjustments\s+to\s+income.*schedule\s+1|10\s+adjustments/,                      canonical_key: 'income.adjustments',         confidence: 0.95 },
  { pattern: /adjusted\s+gross\s+income|11\s+.*adjusted\s+gross|11a\s+.*adjusted\s+gross/,   canonical_key: 'income.agi',                 confidence: 0.97 },
  // Deductions
  { pattern: /standard\s+deduction.*(?:schedule\s+a|12)|12\s+standard\s+deduction|12e\s+standard/, canonical_key: 'deductions.standard',   confidence: 0.97 },
  { pattern: /qualified\s+business\s+income\s+deduction|13\s+qualified\s+business|13a\s+qualified/, canonical_key: 'deductions.qbi',        confidence: 0.97 },
  { pattern: /add\s+lines\s+12.*and\s+13|14\s+add\s+lines\s+12/,                             canonical_key: 'deductions.total',           confidence: 0.95 },
  { pattern: /this\s+is\s+your\s+taxable\s+income|15\s+.*taxable\s+income|subtract\s+line\s+14.*11/, canonical_key: 'deductions.taxable_income', confidence: 0.97 },
  // Tax
  { pattern: /^16\s+tax|tax.*see\s+instructions.*16|tax.*check\s+if/,                         canonical_key: 'tax.income_tax',             confidence: 0.95 },
  { pattern: /amount\s+from\s+schedule\s+2.*line\s+3|17\s+amount.*schedule\s+2/,              canonical_key: 'tax.schedule2',              confidence: 0.96 },
  { pattern: /add\s+lines\s+16\s+and\s+17|18\s+add\s+lines\s+16/,                            canonical_key: 'tax.add_16_17',              confidence: 0.95 },
  { pattern: /other\s+taxes.*self-employment.*schedule\s+2|23\s+other\s+taxes/,                canonical_key: 'tax.other_taxes',            confidence: 0.96 },
  { pattern: /this\s+is\s+your\s+total\s+tax|24\s+.*total\s+tax/,                            canonical_key: 'tax.total_tax',              confidence: 0.97 },
  // Payments
  { pattern: /form.*w-2\s+25a|^a\s+form.*w-2|25a.*withholding/,                               canonical_key: 'payments.w2_withholding',   confidence: 0.95 },
  { pattern: /add\s+lines\s+25a.*25c\s+25d|^d\s+add\s+lines\s+25a/,                          canonical_key: 'payments.total_withholding', confidence: 0.95 },
  { pattern: /estimated\s+tax\s+payments.*(?:26|return)|26\s+.*estimated\s+tax/,               canonical_key: 'payments.estimated',         confidence: 0.96 },
  { pattern: /total\s+payments.*33|33\s+.*total\s+payments|these\s+are\s+your\s+total\s+payments/, canonical_key: 'payments.total_payments', confidence: 0.97 },
  // Result
  { pattern: /amount.*refunded.*35a|35a\s+amount.*refunded/,                                   canonical_key: 'result.refund',              confidence: 0.95 },
  { pattern: /amount\s+you\s+owe|37\s+.*amount\s+you\s+owe/,                                  canonical_key: 'result.balance_due',         confidence: 0.95 },
  { pattern: /estimated\s+tax\s+penalty|38\s+estimated\s+tax\s+penalty/,                       canonical_key: 'result.penalty',             confidence: 0.93 },
  // Schedule 1 / E (K-1 flow)
  { pattern: /rental\s+real\s+estate.*partnerships.*s\s+corporations|5\s+rental\s+real\s+estate/, canonical_key: 'schedule1.k1_income',     confidence: 0.94 },
]

const FUZZY_RULES: Record<string, FuzzyRule[]> = {
  '1120S': FUZZY_RULES_1120S,
  '1120':  FUZZY_RULES_1120,
  '1040':  FUZZY_RULES_1040,
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI KEY → CANONICAL KEY MAP
// Gemini uses our exact schema but may have slight key variations
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_KEY_MAP: Record<string, string> = {
  // top-level → meta.*
  'ein':                    'meta.ein',
  'entity_name':            'meta.entity_name',
  'address':                'meta.address',
  'city_state_zip':         'meta.city_state_zip',
  'date_incorporated':      'meta.date_incorporated',
  's_election_date':        'meta.s_election_date',
  'total_assets':           'meta.total_assets',
  'num_shareholders':       'meta.num_shareholders',
  'business_activity_code': 'meta.business_activity_code',
  'accounting_method':      'meta.accounting_method',
  // income section — keys map directly under 'income.'
  // deductions section — keys map directly under 'deductions.'
  // etc.
}

// QBO account group → canonical key (for common P&L line items)
const QBO_GROUP_MAP: Record<string, string> = {
  'TotalIncome':         'income.total_income',
  'GrossProfit':         'income.gross_profit',
  'TotalExpenses':       'deductions.total_deductions',
  'NetIncome':           'deductions.ordinary_income_loss',
}

// QBO account label → canonical key (fuzzy, best-effort)
const QBO_LABEL_RULES: Array<[RegExp, string]> = [
  [/salaries|wages|payroll/i,      'deductions.salaries_wages'],
  [/officer.*comp|owner.*comp/i,   'deductions.officer_compensation'],
  [/rent/i,                        'deductions.rents'],
  [/insurance/i,                   'deductions.employee_benefits'],
  [/depreciation/i,                'deductions.depreciation'],
  [/interest.*expense/i,           'deductions.interest'],
  [/taxes.*licenses|payroll.*tax/i,'deductions.taxes_licenses'],
  [/advertising|marketing/i,       'deductions.advertising'],
  [/gross.*sales|gross.*revenue/i, 'income.gross_receipts'],
  [/cost.*goods.*sold|cogs/i,      'income.cost_of_goods_sold'],
]

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────────────────────────

/** Clean a dollar string to integer */
function parseDollar(raw: string | number | null): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') return Math.round(raw)
  const cleaned = String(raw).replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : Math.round(n)
}

/** Detect form type from Textract KV pairs */
function detectFormType(kvPairs: TextractKVPair[]): string {
  const text = kvPairs.map(p => p.key + ' ' + p.value).join(' ').toLowerCase()
  if (text.includes('1120-s') || text.includes('1120s') || text.includes('s corporation'))
    return '1120S'
  if (text.includes('1120') && !text.includes('1120s'))
    return '1120'
  if (text.includes('1040'))
    return '1040'
  return '1120S' // default
}

/** Detect tax year from KV pairs */
function detectTaxYear(kvPairs: TextractKVPair[]): number | null {
  for (const { key, value } of kvPairs) {
    // "For calendar year 2022" or "beginning , 2022"
    const m = (key + ' ' + value).match(/(?:calendar\s+year|tax\s+year)\s+(\d{4})|,\s*(\d{4})\s*,/)
    if (m) return parseInt(m[1] || m[2])
    // Check value for standalone years
    const ym = value.match(/^(202[0-9])$/)
    if (ym && key.toLowerCase().includes('year')) return parseInt(ym[1])
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// MAPPER CLASSES
// ─────────────────────────────────────────────────────────────────────────────

/** Map Textract KV pairs → canonical model */
function mapFromTextract(input: TextractOutput): MappingResult {
  const formType  = input.form_type || detectFormType(input.key_value_pairs)
  const taxYear   = input.tax_year  || detectTaxYear(input.key_value_pairs) || null
  const rules     = FUZZY_RULES[formType] || FUZZY_RULES['1120S']

  const model:    Record<string, number | string | null> = { form: formType, tax_year: taxYear }
  const fields:   FieldMapping[] = []
  const unmapped: string[] = []
  const usedKeys  = new Set<string>()

  for (const { key, value, confidence: rawConf } of input.key_value_pairs) {
    if (!value?.trim()) continue

    const keyLower = key.toLowerCase().trim()
    let matched = false

    for (const rule of rules) {
      if (rule.pattern.test(keyLower)) {
        const parsed = parseDollar(value)
        // For text fields, keep as string (don't parse as dollar amount)
        const isText = rule.canonical_key.endsWith('name') ||
                       rule.canonical_key.endsWith('ein') ||
                       rule.canonical_key.endsWith('method') ||
                       rule.canonical_key.endsWith('code') ||
                       rule.canonical_key.endsWith('address') ||
                       rule.canonical_key.endsWith('city_state_zip') ||
                       rule.canonical_key.endsWith('date_incorporated') ||
                       rule.canonical_key.endsWith('phone') ||
                       rule.canonical_key.endsWith('ptin') ||
                       rule.canonical_key.endsWith('firm_ein') ||
                       rule.canonical_key.endsWith('firm_address') ||
                       rule.canonical_key.endsWith('business_activity') ||
                       rule.canonical_key.endsWith('product_service')

        const finalValue = isText ? value.trim() : parsed

        // Confidence: base rule confidence × Textract confidence (if available)
        const textractConf = (rawConf ?? 95) / 100
        const finalConf = rule.confidence * textractConf

        if (!model[rule.canonical_key] || finalConf > (fields.find(f => f.canonical_key === rule.canonical_key)?.confidence ?? 0)) {
          model[rule.canonical_key] = finalValue
          const existing = fields.findIndex(f => f.canonical_key === rule.canonical_key)
          const entry: FieldMapping = {
            canonical_key:    rule.canonical_key,
            value:            finalValue,
            raw_value:        value,
            confidence:       finalConf,
            confidence_level: finalConf >= 0.90 ? 'high' : finalConf >= 0.70 ? 'medium' : 'low',
            source:           'extracted',
            source_key:       key,
          }
          if (existing >= 0) fields[existing] = entry
          else fields.push(entry)
        }

        usedKeys.add(key)
        matched = true
        break
      }
    }

    if (!matched && value.trim() && parseDollar(value) !== null) {
      unmapped.push(`"${key.substring(0, 60)}" = "${value}"`)
    }
  }

  return buildResult(formType, taxYear, model, fields, unmapped, input.key_value_pairs.length)
}

/** Map Gemini structured JSON → canonical model */
function mapFromGemini(input: GeminiOutput): MappingResult {
  const formType = input.form?.replace('-', '') || '1120S'
  const taxYear  = input.tax_year

  const model:   Record<string, number | string | null> = { form: formType, tax_year: taxYear }
  const fields:  FieldMapping[] = []
  const unmapped: string[] = []

  // Helper: add field with high confidence (Gemini already understood the semantics)
  const add = (canonical_key: string, raw: any, source_key: string, conf = 0.96) => {
    const isNumeric = !canonical_key.match(/\.(ein|name|address|city|date|method|code)$/)
    const value = isNumeric ? parseDollar(raw) : (raw ? String(raw).trim() : null)
    if (value === null) return

    model[canonical_key] = value
    fields.push({
      canonical_key,
      value,
      raw_value: String(raw),
      confidence: conf,
      confidence_level: conf >= 0.90 ? 'high' : 'medium',
      source: 'extracted',
      source_key,
    })
  }

  // Top-level fields → meta.*
  for (const [gKey, canonKey] of Object.entries(GEMINI_KEY_MAP)) {
    if (input[gKey as keyof GeminiOutput] !== undefined) {
      add(canonKey, (input as any)[gKey], gKey)
    }
  }

  // Nested sections: income, deductions, schedule_k, schedule_m2
  const sections: Array<[keyof GeminiOutput, string]> = [
    ['income',      'income'],
    ['deductions',  'deductions'],
    ['schedule_k',  'schedule_k'],
    ['schedule_m2', 'schedule_m2'],
  ]

  for (const [section, prefix] of sections) {
    const sectionData = input[section] as Record<string, any> | undefined
    if (!sectionData) continue
    for (const [k, v] of Object.entries(sectionData)) {
      if (v !== null && v !== undefined) {
        add(`${prefix}.${k}`, v, `${section}.${k}`)
      }
    }
  }

  // Schedule K-1
  if (input.schedule_k1) {
    const k1 = input.schedule_k1
    if (k1.shareholder_name)  add('schedule_k1.shareholder_name',  k1.shareholder_name,  'schedule_k1.shareholder_name',  0.95)
    if (k1.shareholder_ssn)   add('schedule_k1.shareholder_ssn',   k1.shareholder_ssn,   'schedule_k1.shareholder_ssn',   0.95)
    if (k1.ownership_pct)     add('schedule_k1.ownership_pct',     k1.ownership_pct,     'schedule_k1.ownership_pct',     0.95)
    if (k1.ordinary_income)   add('schedule_k1.ordinary_income',   k1.ordinary_income,   'schedule_k1.ordinary_income',   0.95)
    if (k1.w2_wages)          add('schedule_k1.w2_wages',          k1.w2_wages,          'schedule_k1.w2_wages',          0.90)
  }

  return buildResult(formType, taxYear ?? null, model, fields, unmapped,
    Object.keys(input).length + Object.keys(input.income ?? {}).length + Object.keys(input.deductions ?? {}).length)
}

/** Map QuickBooks P&L report → canonical model (best-effort) */
function mapFromQBO(input: QBOReport): MappingResult {
  const model:   Record<string, number | string | null> = {
    form:     '1120S',  // QBO doesn't know the form type — caller sets this
    tax_year: parseInt(input.period_end.substring(0, 4)),
  }
  const fields:   FieldMapping[] = []
  const unmapped: string[] = []

  for (const row of input.rows) {
    let mapped = false

    // Try group map first (high confidence)
    const groupCanon = QBO_GROUP_MAP[row.group]
    if (groupCanon) {
      model[groupCanon] = Math.round(row.amount)
      fields.push({
        canonical_key:    groupCanon,
        value:            Math.round(row.amount),
        raw_value:        String(row.amount),
        confidence:       0.85,  // QBO groups → canonical is approximate
        confidence_level: 'medium',
        source:           'qbo',
        source_key:       row.group,
      })
      mapped = true
    }

    // Try label rules (lower confidence — QBO account names are user-defined)
    if (!mapped) {
      for (const [pattern, canonKey] of QBO_LABEL_RULES) {
        if (pattern.test(row.label)) {
          // Accumulate — multiple QBO accounts may map to one canonical line
          const existing = model[canonKey]
          model[canonKey] = Math.round((typeof existing === 'number' ? existing : 0) + row.amount)
          const existingField = fields.find(f => f.canonical_key === canonKey)
          if (existingField) {
            existingField.value = model[canonKey]
          } else {
            fields.push({
              canonical_key:    canonKey,
              value:            model[canonKey],
              raw_value:        String(row.amount),
              confidence:       0.65,
              confidence_level: 'low',
              source:           'qbo',
              source_key:       row.label,
            })
          }
          mapped = true
          break
        }
      }
    }

    if (!mapped) {
      unmapped.push(`QBO row: "${row.label}" (${row.group}) = ${row.amount}`)
    }
  }

  return buildResult('1120S', model.tax_year as number, model, fields, unmapped, input.rows.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE — combine results from multiple sources
// Higher-confidence sources override lower-confidence ones
// ─────────────────────────────────────────────────────────────────────────────

export function mergeResults(results: MappingResult[]): MappingResult {
  // Sort by confidence (best source wins per field)
  const merged: Record<string, FieldMapping> = {}

  for (const result of results) {
    for (const field of result.fields) {
      const existing = merged[field.canonical_key]
      if (!existing || field.confidence > existing.confidence) {
        merged[field.canonical_key] = field
      }
    }
  }

  const allFields  = Object.values(merged)
  const model: Record<string, number | string | null> = {}
  for (const f of allFields) {
    model[f.canonical_key] = f.value
  }

  // Preserve form/year from first result
  const primary = results[0]
  model.form     = primary.model.form
  model.tax_year = primary.model.tax_year

  const allUnmapped = results.flatMap(r => r.unmapped)
  return buildResult(
    String(primary.model.form),
    primary.model.tax_year as number | null,
    model, allFields, allUnmapped,
    results.reduce((s, r) => s + r.stats.total_input_keys, 0)
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD RESULT — shared result construction
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS: Record<string, string[]> = {
  '1120S': ['meta.ein', 'income.gross_receipts', 'deductions.ordinary_income_loss'],
  '1120':  ['meta.ein', 'income.gross_receipts', 'deductions.taxable_income'],
  '1040':  ['income.wages', 'tax.total_tax'],
}

function buildResult(
  formType:    string,
  taxYear:     number | null,
  model:       Record<string, number | string | null>,
  fields:      FieldMapping[],
  unmapped:    string[],
  totalInputKeys: number,
): MappingResult {
  const warnings: string[] = []
  const required  = REQUIRED_FIELDS[formType] || []
  const mapped    = model

  const missing_required = required.filter(k => mapped[k] == null)

  // Warn if computed fields don't match derivable values
  if (mapped['income.gross_receipts'] != null && mapped['income.cost_of_goods_sold'] != null) {
    const derived = (mapped['income.gross_receipts'] as number) - (mapped['income.cost_of_goods_sold'] as number)
    if (mapped['income.gross_profit'] != null && Math.abs((mapped['income.gross_profit'] as number) - derived) > 1) {
      warnings.push(`Gross profit mismatch: extracted ${mapped['income.gross_profit']}, derived ${derived}`)
    }
  }

  const high_confidence   = fields.filter(f => f.confidence >= 0.90).length
  const medium_confidence = fields.filter(f => f.confidence >= 0.70 && f.confidence < 0.90).length
  const low_confidence    = fields.filter(f => f.confidence < 0.70).length

  return {
    form_type: formType,
    tax_year:  taxYear,
    model:     mapped,
    fields,
    unmapped,
    missing_required,
    warnings,
    stats: {
      total_input_keys: totalInputKeys,
      mapped:           fields.length,
      high_confidence,
      medium_confidence,
      low_confidence,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// Auto-detects input format and routes to the right mapper
// ─────────────────────────────────────────────────────────────────────────────

export function mapToCanonical(input: MapperInput): MappingResult {
  // Detect source
  if ('source' in input) {
    switch (input.source) {
      case 'textract': return mapFromTextract(input as TextractOutput)
      case 'gemini':   return mapFromGemini(input as GeminiOutput)
      case 'qbo':      return mapFromQBO(input as QBOReport)
    }
  }

  // No source tag — try to infer from shape
  if ('key_value_pairs' in input) {
    return mapFromTextract({ source: 'textract', ...input } as TextractOutput)
  }
  if ('income' in input && 'deductions' in input) {
    return mapFromGemini({ source: 'gemini', ...input } as GeminiOutput)
  }
  if ('rows' in input && 'period_end' in input) {
    return mapFromQBO({ source: 'qbo', ...input } as QBOReport)
  }

  throw new Error('Unknown input format. Expected textract, gemini, or qbo shape.')
}
