/**
 * Return routes — Process documents into tax returns, validate, compare
 *
 * When a document is recognized as a tax return:
 *   1. Textract KV pairs → json_model_mapper → canonical model
 *   2. Canonical model → tax engine → computed values
 *   3. Compare extracted vs computed → discrepancy report
 *   4. Save as tax_return record
 */
import { Router, type Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { mapToCanonical, type TextractOutput } from '../intake/json_model_mapper.js'
import { calc1120, calc1120S, calc1040, calcExtension, calc4562, calc8594, calcScheduleE, type ExtensionInputs, type ExtensionType, type Form4562_Inputs, type Form8594_Inputs, type ScheduleE_Inputs } from '../engine/tax_engine.js'
import { encryptedFields } from '../lib/row_crypto.js'
import { extractAggregates as extractAggregatesFromFv, readMetric, COMPARE_METRICS } from '../maps/metric_to_field.js'

const ENCRYPTED_RETURN_FIELDS = { json: ['input_data', 'computed_data', 'field_values', 'verification'] }
import { TAX_TABLES } from '../engine/tax_tables.js'
import { INPUT_SCHEMAS } from './schema.js'
import { buildCanonicalModel, buildReturnPdf } from '../builders/build_return_pdf.js'
import { buildScheduleL } from '../maps/qbo_to_schedule_l.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function getUser(req: any): Promise<string | null> {
  if ((req as any).userId) return (req as any).userId
  const t = req.headers.authorization?.replace('Bearer ', '')
  if (t) { const { data: { user } } = await supabase.auth.getUser(t); return user?.id || null }
  return null
}

const FORM_TYPE_MAP: Record<string, string> = {
  prior_return_1040: '1040', prior_return_1120: '1120', prior_return_1120s: '1120S',
}

const router = Router()

// Process a document into a tax return
router.post('/process/:document_id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: doc } = await supabase.from('document')
    .select('*').eq('id', req.params.document_id).eq('user_id', userId).single()
  if (!doc) return res.status(404).json({ error: 'Document not found' })

  if (!doc.textract_data?.kvs?.length) {
    return res.status(400).json({ error: 'No textract data. Upload and wait for extraction first.' })
  }

  const formType = FORM_TYPE_MAP[doc.doc_type] || req.body.form_type
  if (!formType) {
    return res.status(400).json({ error: 'Cannot determine form type. Set form_type in body or categorize document first.' })
  }

  const taxYear = doc.tax_year || req.body.tax_year
  if (!taxYear) {
    return res.status(400).json({ error: 'Cannot determine tax year. Set tax_year in body or categorize document first.' })
  }

  try {
    // 1. Run textract KVs through the mapper
    const textractInput: TextractOutput = {
      source: 'textract',
      form_type: formType === '1120S' ? '1120S' : formType,
      tax_year: taxYear,
      key_value_pairs: doc.textract_data.kvs.map((kv: any) => ({
        key: kv.key, value: kv.value,
      })),
      tables: doc.textract_data.tables,
    }
    const mapped = mapToCanonical(textractInput)

    // 2. Build engine input from mapped fields
    let engineResult: any = null
    let engineInput: any = {}

    const getNum = (key: string): number => {
      const v = mapped.model[key]
      return typeof v === 'number' ? v : 0
    }

    if (formType === '1120') {
      engineInput = {
        gross_receipts: getNum('income.L1a_gross_receipts') || getNum('income.gross_receipts'),
        returns_allowances: getNum('income.L1b_returns') || getNum('income.returns_allowances'),
        cost_of_goods_sold: getNum('income.L2_cogs') || getNum('income.cost_of_goods_sold'),
        dividends: getNum('income.L4_dividends'),
        interest_income: getNum('income.L5_interest'),
        gross_rents: getNum('income.L6_gross_rents'),
        gross_royalties: getNum('income.L7_gross_royalties'),
        capital_gains: getNum('income.L8_capital_gains'),
        net_gain_4797: getNum('income.L9_net_gain_4797'),
        other_income: getNum('income.L10_other_income'),
        officer_compensation: getNum('deductions.L12_officer_comp') || getNum('deductions.officer_compensation'),
        salaries_wages: getNum('deductions.L13_salaries') || getNum('deductions.salaries_wages'),
        repairs_maintenance: getNum('deductions.L14_repairs') || getNum('deductions.repairs_maintenance'),
        bad_debts: getNum('deductions.L15_bad_debts') || getNum('deductions.bad_debts'),
        rents: getNum('deductions.L16_rents') || getNum('deductions.rents'),
        taxes_licenses: getNum('deductions.L17_taxes_licenses') || getNum('deductions.taxes_licenses'),
        interest_expense: getNum('deductions.L18_interest') || getNum('deductions.interest'),
        charitable_contrib: getNum('deductions.L19_charitable') || getNum('deductions.charitable'),
        depreciation: getNum('deductions.L20_depreciation') || getNum('deductions.depreciation'),
        depletion: getNum('deductions.L21_depletion') || getNum('deductions.depletion'),
        advertising: getNum('deductions.L22_advertising') || getNum('deductions.advertising'),
        pension_plans: getNum('deductions.L23_pension') || getNum('deductions.pension_plans'),
        employee_benefits: getNum('deductions.L24_employee_benefits') || getNum('deductions.employee_benefits'),
        other_deductions: getNum('deductions.L26_other_deductions') || getNum('deductions.other_deductions'),
        nol_deduction: getNum('tax.L29a_nol'), special_deductions: 0,
        estimated_tax_paid: getNum('schedJ.J13_prior_overpayment') + getNum('schedJ.J14_estimated_payments'),
        tax_year: taxYear,
      }
      engineResult = calc1120(engineInput)
    } else if (formType === '1120S') {
      engineInput = {
        gross_receipts: getNum('income.L1a_gross_receipts') || getNum('income.gross_receipts'),
        returns_allowances: getNum('income.L1b_returns') || getNum('income.returns_allowances'),
        cost_of_goods_sold: getNum('income.L2_cogs') || getNum('income.cost_of_goods_sold'),
        net_gain_4797: getNum('income.L4_net_gain_4797'),
        other_income: getNum('income.L5_other_income') || getNum('income.other_income'),
        officer_compensation: getNum('deductions.L7_officer_comp') || getNum('deductions.officer_compensation'),
        salaries_wages: getNum('deductions.L8_salaries') || getNum('deductions.salaries_wages'),
        repairs_maintenance: getNum('deductions.L9_repairs') || getNum('deductions.repairs_maintenance'),
        bad_debts: getNum('deductions.L10_bad_debts') || getNum('deductions.bad_debts'),
        rents: getNum('deductions.L11_rents') || getNum('deductions.rents'),
        taxes_licenses: getNum('deductions.L12_taxes') || getNum('deductions.taxes_licenses'),
        interest: getNum('deductions.L13_interest') || getNum('deductions.interest'),
        depreciation: getNum('deductions.L14_depreciation') || getNum('deductions.depreciation'),
        depletion: getNum('deductions.L15_depletion') || getNum('deductions.depletion'),
        advertising: getNum('deductions.L16_advertising') || getNum('deductions.advertising'),
        pension_plans: getNum('deductions.L17_pension') || getNum('deductions.pension_plans'),
        employee_benefits: getNum('deductions.L18_employee_benefits') || getNum('deductions.employee_benefits'),
        other_deductions: getNum('deductions.L20_other') || getNum('deductions.other_deductions'),
        charitable_contrib: getNum('schedule_k.charitable_contrib'),
        section_179: 0,
        shareholders: [{ name: doc.meta?.entity_name || 'Shareholder', pct: 100 }],
      }
      engineResult = calc1120S(engineInput)
    } else if (formType === '1040') {
      // For 1040, use the canonical keys from the updated mapper
      // Use 1z total wages (includes dependent care, tips) — NOT 1a W-2 box 1
      const wages = getNum('income.wages')  // 1z
      // Schedule 1 line 10 (additional income = K-1 + other)
      const schedule1 = getNum('income.schedule1_income') || getNum('schedule1.k1_income')
      // If we have AGI directly, use it to validate
      const extractedAgi = getNum('income.agi')
      engineInput = {
        filing_status: 'mfj', tax_year: taxYear,
        wages,
        taxable_interest: getNum('income.taxable_interest'),
        ordinary_dividends: getNum('income.ordinary_dividends'),
        qualified_dividends: getNum('income.qualified_dividends'),
        ira_distributions: 0, pensions_annuities: 0, social_security: 0,
        capital_gains: getNum('income.capital_gains'),
        schedule1_income: schedule1,
        student_loan_interest: 0, educator_expenses: 0,
        itemized_deductions: 0, use_itemized: false,
        qbi_from_k1: 0,
        k1_ordinary_income: 0,  // K-1 is already in schedule1_income — don't double count
        k1_w2_wages: 0, k1_ubia: 0,
        withholding: getNum('payments.w2_withholding') || getNum('payments.total_withholding'),
        estimated_payments: getNum('payments.estimated'),
      }
      engineResult = calc1040(engineInput)
    }

    // 3. Compare extracted vs engine computed
    const extracted: Record<string, number> = {}
    for (const f of mapped.fields) {
      if (typeof f.value === 'number') extracted[f.canonical_key] = f.value
    }

    const computed = engineResult?.computed || {}
    const discrepancies: Array<{field: string; extracted: number; computed: number; delta: number}> = []

    // Key fields to compare
    const compareKeys: Record<string, string[]> = {
      '1120': [['income.L3_gross_profit', 'gross_profit'], ['income.L11_total_income', 'total_income'],
               ['deductions.L27_total_deductions', 'total_deductions'],
               ['tax.L30_taxable_income', 'taxable_income'], ['tax.L31_total_tax', 'income_tax']].map(([a,b]) => a + '|' + b) as any,
      '1120S': [['income.L3_gross_profit', 'gross_profit'], ['income.L6_total_income', 'total_income'],
                ['deductions.L21_total', 'total_deductions'],
                ['tax.L22_ordinary_income', 'ordinary_income_loss']].map(([a,b]) => a + '|' + b) as any,
    }

    // Build discrepancy list
    const keyPairs = (compareKeys[formType] || []) as string[]
    for (const pair of keyPairs) {
      const [extractKey, computeKey] = pair.split('|')
      const ext = extracted[extractKey]
      const comp = computed[computeKey]
      if (ext !== undefined && comp !== undefined && ext !== comp) {
        discrepancies.push({ field: extractKey, extracted: ext, computed: comp, delta: comp - ext })
      }
    }

    // 4. Find entity — try exact match, then partial, then by form type
    let entityId = doc.entity_id
    if (!entityId && doc.meta?.entity_name) {
      // Try exact match first
      const { data: exact } = await supabase.from('tax_entity')
        .select('id').ilike('name', doc.meta.entity_name).single()
      if (exact) { entityId = exact.id }
      else {
        // Try partial match on first word
        const firstName = doc.meta.entity_name.split(' ')[0]
        const { data: partial } = await supabase.from('tax_entity')
          .select('id').ilike('name', `%${firstName}%`).single()
        if (partial) { entityId = partial.id }
      }
    }
    // Last resort: match by form type for this user
    if (!entityId && formType) {
      const { data: byForm } = await supabase.from('tax_entity')
        .select('id').eq('form_type', formType).eq('user_id', userId).single()
      if (byForm) { entityId = byForm.id }
    }

    // 5. Save tax_return — filed_import rows are write-once per ingest; each
    // /process call creates a new row (unique constraint was removed so
    // multiple filed_imports per year are allowed if the PDF is re-ingested
    // after corrections). Callers pick the authoritative one by computed_at.
    // Strip the redundant flat `computed` dict from the persisted shape —
    // every flat metric maps to a sectioned field_values line via
    // maps/metric_to_field.ts, so storing it twice was a second source of
    // truth. We keep citations / k1s / qbo_warnings for debug + scenario
    // structural data.
    const { computed: _processComputed, ...processComputedData } = (engineResult ?? {}) as any
    void _processComputed
    const processRaw = {
      input_data: engineInput,
      computed_data: processComputedData,
      field_values: extracted,
      verification: {
        mapper_stats: mapped.stats,
        discrepancies,
        extracted_count: mapped.fields.length,
        unmapped_count: mapped.unmapped.length,
      },
    }
    const processEnc = await encryptedFields(supabase, userId, processRaw, ENCRYPTED_RETURN_FIELDS)
    const { data: taxReturn, error } = await supabase.from('tax_return').insert({
      entity_id: entityId,
      tax_year: taxYear,
      form_type: formType,
      status: 'computed',
      source: 'filed_import',
      is_amended: false,
      ...processRaw,
      ...processEnc,
      ...extractAggregatesFromFv(extracted, formType),
      computed_at: new Date().toISOString(),
      pdf_s3_path: null,
    }).select().single()

    if (error) return res.status(500).json({ error: error.message })

    // Link document to entity
    if (entityId && !doc.entity_id) {
      await supabase.from('document').update({ entity_id: entityId }).eq('id', doc.id)
    }

    // 6. Extract secondary forms from the same textract data
    const secondaryForms: Array<{form: string; fields: Record<string, any>}> = []
    const kvs = doc.textract_data.kvs as Array<{key: string; value: string}>

    const parseDollar = (s: string): number | null => {
      if (!s) return null
      const c = s.replace(/[\$,\s]/g, '').replace(/\((.+)\)/, '-$1').replace(/\.$/, '')
      const n = parseFloat(c)
      return isNaN(n) ? null : Math.round(n)
    }

    // Define secondary form patterns
    const secPatterns: Record<string, Array<[RegExp, string]>> = {
      'schedule_2': [
        [/11\s+additional\s+medicare\s+tax/i, 'L11_additional_medicare'],
        [/12\s+net\s+investment\s+income\s+tax/i, 'L12_niit'],
        [/21\s+.*total\s+other\s+taxes/i, 'L21_total_other_taxes'],
      ],
      'schedule_b': [
        [/2\s+add\s+the\s+amounts\s+on\s+line\s+1\s+2/i, 'L2_total_interest'],
        [/6\s+add\s+the\s+amounts\s+on\s+line\s+5/i, 'L6_total_dividends'],
      ],
      'schedule_d': [
        [/7\s+net\s+short-term\s+capital\s+gain/i, 'L7_net_short_term'],
        [/15\s+net\s+long-term\s+capital\s+gain/i, 'L15_net_long_term'],
        [/16\s+combine\s+lines\s+7\s+and\s+15/i, 'L16_combined'],
      ],
      'schedule_e': [
        [/30\s+add\s+columns.*line\s+29a/i, 'L30_partnership_income'],
        [/32\s+total\s+partnership.*s\s+corporation/i, 'L32_total_partnership'],
        [/41\s+total\s+income/i, 'L41_total_income'],
      ],
      'form_8959': [
        [/1\s+medicare\s+wages.*from\s+.*w-2.*box\s+5/i, 'L1_medicare_wages'],
        [/7\s+additional\s+medicare\s+tax\s+on\s+medicare/i, 'L7_additional_medicare'],
        [/18\s+add\s+lines\s+7.*13.*17/i, 'L18_total'],
      ],
      'form_8960': [
        [/8\s+total\s+investment\s+income/i, 'L8_total_investment'],
        [/12\s+net\s+investment\s+income/i, 'L12_net_investment'],
        [/13\s+modified\s+adjusted\s+gross/i, 'L13_magi'],
        [/17\s+net\s+investment\s+income\s+tax/i, 'L17_niit'],
      ],
      'form_8995a': [
        [/27\s+total\s+qualified\s+business\s+income\s+component/i, 'L27_total_qbi'],
        [/33\s+taxable\s+income\s+before\s+qualified/i, 'L33_ti_before_qbi'],
        [/39\s+total\s+qualified\s+business\s+income\s+deduction/i, 'L39_total_qbi_deduction'],
      ],
      'form_7203': [
        [/1\s+stock\s+basis\s+at\s+the\s+beginning/i, 'L1_basis_boy'],
        [/3a\s+ordinary\s+business\s+income.*enter\s+losses/i, 'L3a_ordinary_income'],
        [/5\s+stock\s+basis\s+before\s+distributions/i, 'L5_basis_before_dist'],
        [/6\s+distributions.*excluding\s+dividend/i, 'L6_distributions'],
        [/15\s+stock\s+basis\s+at\s+the\s+end/i, 'L15_basis_eoy'],
      ],
      'form_1125a': [
        [/3\s+cost\s+of\s+labor/i, 'L3_labor'],
        [/5\s+other\s+costs/i, 'L5_other_costs'],
        [/8\s+cost\s+of\s+goods\s+sold.*subtract/i, 'L8_cogs'],
      ],
      'schedule_k1': [
        [/1\s+ordinary\s+business\s+income\s*\(/i, 'L1_ordinary_income'],
        [/4\s+interest\s+income\b/i, 'L4_interest'],
        [/5a\s+ordinary\s+dividends/i, 'L5a_dividends'],
      ],
    }

    for (const [formName, patterns] of Object.entries(secPatterns)) {
      const fields: Record<string, any> = {}
      for (const kv of kvs) {
        for (const [regex, fieldKey] of patterns) {
          if (regex.test(kv.key)) {
            const val = parseDollar(kv.value)
            if (val !== null) fields[fieldKey] = val
          }
        }
      }
      if (Object.keys(fields).length > 0) {
        secondaryForms.push({ form: formName, fields })
        // Save to tax_return_form
        if (taxReturn) {
          await supabase.from('tax_return_form').upsert({
            return_id: taxReturn.id,
            form_name: formName,
            form_year: taxYear,
            field_values: fields,
            status: 'extracted',
          }, { onConflict: 'return_id,form_name,form_year' as any }).then(() => {})
        }
      }
    }

    res.json({
      return: taxReturn,
      breakdown: {
        form_type: formType,
        tax_year: taxYear,
        entity: doc.meta?.entity_name || '',
        extracted: mapped.fields.map(f => ({
          key: f.canonical_key, value: f.value, confidence: f.confidence_level, source_key: f.source_key,
        })),
        computed: engineResult?.computed,
        discrepancies,
        mapper_stats: mapped.stats,
        secondary_forms: secondaryForms,
      }
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// List returns
router.get('/', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  // Get returns for entities owned by this user
  const { data: entities } = await supabase.from('tax_entity').select('id').eq('user_id', userId)
  const entityIds = entities?.map(e => e.id) || []

  if (!entityIds.length) return res.json({ returns: [] })

  const { data, error } = await supabase.from('tax_return')
    .select('*, tax_entity(name, form_type, ein)')
    .in('entity_id', entityIds)
    .order('tax_year', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ returns: data })
})

// Get single return with full breakdown
router.get('/:id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data } = await supabase.from('tax_return')
    .select('*, tax_entity(name, form_type, ein), tax_return_form(*)')
    .eq('id', req.params.id).single()

  if (!data) return res.status(404).json({ error: 'Not found' })
  res.json({ return: data })
})

// Multi-year comparison for an entity
router.get('/compare/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  const { data: allRows } = await supabase.from('tax_return')
    .select('*, tax_entity(name)')
    .eq('entity_id', req.params.entity_id)
    .order('tax_year', { ascending: true })
    .order('computed_at', { ascending: false })

  if (!allRows?.length) return res.json({ comparison: null })

  // Pick one authoritative row per tax_year. Preference order: filed_import >
  // latest amendment > latest proforma > extension. For side-by-side comparison
  // the most-recently-filed view wins, but every row is still returned in
  // `all_rows` for drill-down.
  const SOURCE_RANK: Record<string, number> = { filed_import: 0, amendment: 1, proforma: 2, extension: 3 }
  const byYear = new Map<number, any>()
  for (const r of allRows) {
    const existing = byYear.get(r.tax_year)
    const rank = SOURCE_RANK[r.source as string] ?? 9
    if (!existing || rank < (SOURCE_RANK[existing.source as string] ?? 9)) {
      byYear.set(r.tax_year, r)
    }
  }
  const returns = [...byYear.values()].sort((a, b) => a.tax_year - b.tax_year)

  const years = returns.map(r => r.tax_year)
  const metrics = COMPARE_METRICS as readonly string[]

  const matrix: Record<string, Record<number, number>> = {}
  for (const m of metrics) matrix[m] = {}

  // Read every metric from field_values (golden model) — never from
  // computed_data. The flat-metric → sectioned-key mapping is form-aware
  // and lives in maps/metric_to_field.ts.
  for (const r of returns) {
    for (const m of metrics) {
      const v = readMetric(r.field_values, r.form_type, m)
      if (v !== null) matrix[m][r.tax_year] = v
    }
  }

  // Year-over-year changes
  const changes: Record<string, Record<number, { value: number; prev: number; delta: number; pct: number }>> = {}
  for (const m of metrics) {
    changes[m] = {}
    for (let i = 1; i < years.length; i++) {
      const curr = matrix[m][years[i]]
      const prev = matrix[m][years[i - 1]]
      if (curr !== undefined && prev !== undefined) {
        changes[m][years[i]] = {
          value: curr, prev, delta: curr - prev,
          pct: prev !== 0 ? Math.round(((curr - prev) / Math.abs(prev)) * 100) : 0,
        }
      }
    }
  }

  res.json({
    entity: returns[0]?.tax_entity,
    years,
    returns: returns.map(r => ({
      id: r.id, entity_id: r.entity_id, tax_year: r.tax_year, year: r.tax_year,
      form: r.form_type, form_type: r.form_type, status: r.status,
      source: r.source, supersedes_id: r.supersedes_id, computed_at: r.computed_at,
      computed_data: r.computed_data, field_values: r.field_values,
    })),
    all_rows: allRows.map(r => ({
      id: r.id, entity_id: r.entity_id, tax_year: r.tax_year, year: r.tax_year,
      form: r.form_type, form_type: r.form_type, status: r.status,
      source: r.source, supersedes_id: r.supersedes_id, computed_at: r.computed_at,
      computed_data: r.computed_data, field_values: r.field_values,
    })),
    matrix,
    changes,
  })
})

// ─── Validate inputs before compute ───
router.post('/validate', async (req, res) => {
  const { form_type, tax_year, inputs } = req.body
  const errors: Array<{field: string; message: string}> = []
  const warnings: Array<{field: string; message: string}> = []

  if (!form_type) errors.push({ field: 'form_type', message: 'form_type is required (1040, 1120, or 1120S)' })
  if (!tax_year) errors.push({ field: 'tax_year', message: 'tax_year is required' })
  if (!inputs || typeof inputs !== 'object') errors.push({ field: 'inputs', message: 'inputs object is required' })

  if (errors.length) return res.json({ valid: false, errors, warnings })

  if (!TAX_TABLES[tax_year]) {
    errors.push({ field: 'tax_year', message: `No tax tables for year ${tax_year}. Supported: ${Object.keys(TAX_TABLES).join(', ')}` })
  }

  // Check required fields from schema
  const schema = INPUT_SCHEMAS[form_type]
  if (!schema) {
    errors.push({ field: 'form_type', message: `Unknown form type: ${form_type}. Supported: ${Object.keys(INPUT_SCHEMAS).join(', ')}` })
  } else {
    for (const field of schema.fields) {
      if (field.required && (inputs[field.name] === undefined || inputs[field.name] === null)) {
        errors.push({ field: field.name, message: `${field.name} is required for Form ${form_type}` })
      }
      if (inputs[field.name] !== undefined && field.type === 'number' && typeof inputs[field.name] !== 'number') {
        errors.push({ field: field.name, message: `${field.name} must be a number` })
      }
    }
    // Warn about unknown fields
    const knownFields = new Set(schema.fields.map((f: any) => f.name))
    for (const key of Object.keys(inputs)) {
      if (!knownFields.has(key)) {
        warnings.push({ field: key, message: `Unknown field "${key}" — will be ignored` })
      }
    }
  }

  // 1040-specific: check filing_status
  if (form_type === '1040' && inputs.filing_status) {
    const valid = ['single', 'mfj', 'mfs', 'hoh', 'qw']
    if (!valid.includes(inputs.filing_status)) {
      errors.push({ field: 'filing_status', message: `filing_status must be one of: ${valid.join(', ')}` })
    }
  }

  // 1120S-specific: check shareholders
  if (form_type === '1120S' && inputs.shareholders) {
    if (!Array.isArray(inputs.shareholders) || inputs.shareholders.length === 0) {
      errors.push({ field: 'shareholders', message: 'shareholders must be a non-empty array of {name, pct}' })
    } else {
      const totalPct = inputs.shareholders.reduce((s: number, sh: any) => s + (sh.pct || 0), 0)
      if (Math.abs(totalPct - 100) > 0.01) {
        warnings.push({ field: 'shareholders', message: `Shareholder percentages sum to ${totalPct}%, expected 100%` })
      }
    }
  }

  res.json({ valid: errors.length === 0, errors, warnings })
})

// ─── Compute return from structured inputs ───
router.post('/compute', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { entity_id, tax_year, form_type, inputs, save, return_id, amend_of, new_row } = req.body
  if (!form_type || !tax_year || !inputs) {
    return res.status(400).json({ error: 'form_type, tax_year, and inputs are required' })
  }

  if (!TAX_TABLES[tax_year]) {
    return res.status(400).json({ error: `No tax tables for year ${tax_year}` })
  }

  // ── Arithmetic validation: *_detail arrays vs scalar totals ───────
  // When a caller passes both `<bucket>_detail: [{label, amount}]` and
  // the scalar `<bucket>` (e.g. other_deductions_detail + other_deductions),
  // reject with a loud diagnostic if the sum of detail items doesn't
  // match the scalar. Prevents the class of silent failures where the
  // LLM manually totaled a line-item list and got it wrong (e.g.
  // $38,994 claimed vs $69,008 actual, producing phantom profit).
  //
  // Also validates Schedule L balance: assets_total vs liabilities_equity_total.
  {
    const validationErrors: Array<{ field: string; claimed: number; actual: number; delta: number; items?: number }> = []
    const TOLERANCE = 1  // $1 rounding allowance

    for (const [key, value] of Object.entries(inputs as Record<string, any>)) {
      if (!key.endsWith('_detail')) continue
      if (!Array.isArray(value)) continue
      const scalarKey = key.slice(0, -'_detail'.length)
      const scalar = (inputs as any)[scalarKey]
      if (typeof scalar !== 'number') continue  // no scalar to validate against
      let sum = 0
      for (const item of value) {
        const amt = parseFloat(String(item?.amount ?? item?.value ?? '0'))
        if (!isNaN(amt)) sum += amt
      }
      const delta = sum - scalar
      if (Math.abs(delta) > TOLERANCE) {
        validationErrors.push({
          field: scalarKey,
          claimed: scalar,
          actual: Math.round(sum * 100) / 100,
          delta: Math.round(delta * 100) / 100,
          items: value.length,
        })
      }
    }

    // Schedule L balance check: assets side vs L&E side.
    // The two totals are rolled up on lines 15 and 28 on 1120/1120S
    // Schedule L. Canonical keys: schedL.L15_total_eoy_d (assets) and
    // schedL.L28_total_eoy_d (L&E). Same for BOY (_boy_b).
    const schedLPairs: Array<['boy' | 'eoy', string, string]> = [
      ['eoy', 'schedL.L15_total_eoy_d', 'schedL.L28_total_eoy_d'],
      ['boy', 'schedL.L15_total_boy_b', 'schedL.L28_total_boy_b'],
    ]
    for (const [period, assetsKey, liabEquityKey] of schedLPairs) {
      const a = (inputs as any)[assetsKey]
      const l = (inputs as any)[liabEquityKey]
      if (typeof a === 'number' && typeof l === 'number' && Math.abs(a - l) > TOLERANCE) {
        validationErrors.push({
          field: `Schedule L ${period.toUpperCase()}`,
          claimed: a,
          actual: l,
          delta: a - l,
        })
      }
    }

    if (validationErrors.length) {
      return res.status(422).json({
        error: 'ARITHMETIC_MISMATCH',
        message: 'One or more *_detail arrays or Schedule L totals do not sum to the claimed scalar. Fix the mismatch before compute.',
        mismatches: validationErrors,
        hint: 'Either (a) correct the _detail array to sum to the scalar, (b) correct the scalar to match the detail sum, or (c) omit one side and let the other stand.',
      })
    }
  }

  // ── Target-row resolution ──────────────────────────────────────────
  // compute_return never mutates filed_import rows. Caller steers the write via:
  //   return_id   — update this specific row (must be proforma or amendment)
  //   amend_of    — create a new `amendment` row that supersedes this one
  //   new_row     — force INSERT a new proforma even if one exists
  //   (default)   — update latest proforma for (entity, year, form); insert if none
  let targetRow: { id: string; source: string; entity_id: string; tax_year: number; form_type: string } | null = null
  if (return_id) {
    const { data } = await supabase.from('tax_return')
      .select('id, source, entity_id, tax_year, form_type').eq('id', return_id).single()
    if (!data) return res.status(404).json({ error: `return_id ${return_id} not found` })
    if (data.source === 'filed_import') {
      return res.status(409).json({
        error: 'Cannot compute onto a filed_import row — filed returns are immutable archives.',
        hint: 'Pass amend_of=<return_id> to start a new amendment, or omit return_id to write a fresh proforma.',
      })
    }
    targetRow = data
  }
  let amendOfRow: { id: string; entity_id: string; tax_year: number; form_type: string; field_values: any } | null = null
  if (amend_of) {
    const { data } = await supabase.from('tax_return')
      .select('id, entity_id, tax_year, form_type, field_values').eq('id', amend_of).single()
    if (!data) return res.status(404).json({ error: `amend_of ${amend_of} not found` })
    amendOfRow = data
  }

  try {
    // Pull supporting documents for this entity+year and merge into inputs.
    // CRITICAL: seed from whichever row this compute will land on so that an
    // empty or partial `inputs` does not wipe previously-saved values.
    // Priority: explicit return_id > amend_of source > latest proforma.
    // The seed is populated regardless of `save` — a save:false compute
    // is still reading existing state, so it should reflect that state,
    // not zero it out. Only `new_row:true` skips the seed, since that's
    // the explicit "I want a fresh scenario baseline" flag.
    //
    // Contract: `inputs:{}` is a no-op merge (preserve existing). To
    // explicitly clear a field, pass `{ field: null }`.
    let existingInputData: Record<string, any> = {}
    if (!new_row && entity_id) {
      let seedId: string | null = null
      if (targetRow) seedId = targetRow.id
      else if (amendOfRow) seedId = amendOfRow.id
      else {
        const isExtensionForm = ['4868', '7004', '8868'].includes(form_type)
        const { data: latest } = await supabase.from('tax_return')
          .select('id').eq('entity_id', entity_id).eq('tax_year', tax_year)
          .eq('form_type', form_type).eq('source', isExtensionForm ? 'extension' : 'proforma')
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        if (latest?.id) seedId = latest.id
      }
      if (seedId) {
        const { data: seedRow } = await supabase.from('tax_return')
          .select('input_data').eq('id', seedId).single()
        existingInputData = (seedRow?.input_data || {}) as Record<string, any>
      }
    }
    let supportingDocs: any[] = []
    // Caller's inputs override existing; unspecified fields fall through to prior state.
    const mergedInputs: any = { ...existingInputData, ...inputs }
    const autoMergeLog: Array<{ field: string; value: number; sources: string[]; confidence?: string }> = []
    // Warnings from the QBO mapper — non-blocking context for the caller
    // (SSTB_SUSPECTED, OFFICER_COMP_UNSPLIT, CONTINGENCY_IN_REVENUE, ...)
    const qboWarnings: Array<{ code: string; message: string; fix_hint?: string }> = []

    const sum = (docs: any[], ...keys: string[]): number => {
      let total = 0
      for (const d of docs) {
        const kv = d.meta?.key_values || {}
        for (const k of keys) {
          const v = parseFloat(String(kv[k] ?? '').replace(/[\$,]/g, '')) || 0
          if (v) { total += v; break }  // first matching key wins per doc
        }
      }
      return Math.round(total)
    }
    // Caller-provided values (even 0) always win over auto-merge. Only fill
    // when the caller left the field undefined/null. Previously used `!x`
    // which incorrectly treated explicit 0 as unset — e.g. passing
    // salaries_wages:0 would get overridden by QBO's wages total.
    const setIfUnset = (field: string, value: number, sourceType: string, count: number, confidence?: string) => {
      if (value && (mergedInputs[field] === undefined || mergedInputs[field] === null)) {
        mergedInputs[field] = value
        autoMergeLog.push({ field, value, sources: [`${count} × ${sourceType}`], confidence })
      }
    }

    // ─── Pre-populate corporate inputs from QBO P&L + Balance Sheet ───
    // For 1120/1120S computes, if the entity has a QBO connection, run the
    // books through the qbo_to_inputs mapper. Fills:
    //   - P&L → 1120/1120S deduction buckets + other_income
    //   - Balance Sheet → Schedule L canonical keys (schedL.L1_cash_eoy_d, ...)
    //   - Emits warnings (SSTB_SUSPECTED, OFFICER_COMP_UNSPLIT, ...)
    // setIfUnset semantics: caller-provided inputs always win.
    if (entity_id && (form_type === '1120S' || form_type === '1120')) {
      try {
        const { data: conn } = await supabase.from('qbo_connection')
          .select('realm_id').eq('entity_id', entity_id).single()
        if (conn) {
          // Pull current + prior year balance sheets for Schedule L BOY/EOY,
          // plus the entity record to get business_code for SSTB warning.
          const [finResp, priorFinResp, entityRow] = await Promise.all([
            fetch(
              `${req.protocol}://${req.get('host')}/api/qbo/${entity_id}/financials?year=${tax_year}`,
              { headers: {
                'Authorization': req.headers.authorization || '',
                'x-api-key': (req.headers['x-api-key'] as string) || '',
              }},
            ).then(r => r.json()).catch(() => null),
            fetch(
              `${req.protocol}://${req.get('host')}/api/qbo/${entity_id}/financials?year=${tax_year - 1}`,
              { headers: {
                'Authorization': req.headers.authorization || '',
                'x-api-key': (req.headers['x-api-key'] as string) || '',
              }},
            ).then(r => r.json()).catch(() => null),
            (async () => {
              try {
                const r = await supabase.from('tax_entity').select('meta').eq('id', entity_id).eq('user_id', userId).single()
                return r.data
              } catch { return null }
            })(),
          ])

          const pnlItems = finResp?.profit_and_loss?.items
          const bsItems  = finResp?.balance_sheet?.items
          const priorBs  = priorFinResp?.balance_sheet?.items
          const businessCode: string | undefined = entityRow?.meta?.business_code

          if (pnlItems) {
            const { buildCorporateInputsFromQbo } = await import('../maps/qbo_to_inputs.js')
            const packet = buildCorporateInputsFromQbo({
              pnl: pnlItems,
              bs: bsItems,
              priorBs,
              form_type: form_type as '1120' | '1120S',
              business_code: businessCode,
            })
            // Write mapped inputs with setIfUnset semantics + carry each
            // audit entry's confidence into the caller-visible log.
            const auditByField = new Map<string, string>()
            for (const a of packet.audit) auditByField.set(a.tax_field, a.confidence)
            for (const [field, value] of Object.entries(packet.inputs)) {
              if (typeof value === 'number') {
                setIfUnset(field, value, 'QBO P&L/BS', 1, auditByField.get(field))
              }
            }
            // Surface warnings to the caller so the LLM can act on them.
            qboWarnings.push(...packet.warnings)
          }
        }
      } catch (_) { /* QBO not connected or fetch failed — caller still gets explicit inputs */ }
    }

    if (entity_id) {
      const supportedTypes = [
        'w2', 'k1',
        '1099', '1099_int', '1099_div', '1099_b', '1099_r',
        '1099_misc', '1099_nec', '1099_k', '1099_g', '1099_sa', '1099_oid',
      ]
      const { data: docs } = await supabase.from('document')
        .select('id, doc_type, meta, textract_data, filename')
        .eq('entity_id', entity_id)
        .eq('tax_year', tax_year)
        .in('doc_type', supportedTypes)
      if (docs?.length) {
        supportingDocs = docs
        const byType = (t: string) => docs.filter(d => d.doc_type === t)
        const isIndividual = form_type === '1040'

        if (isIndividual) {
          // W-2s → wages, withholding
          const w2s = byType('w2')
          setIfUnset('wages',       sum(w2s, 'wages', 'box_1'),      'W-2', w2s.length)
          setIfUnset('withholding', sum(w2s, 'federal_tax', 'box_2'), 'W-2', w2s.length)

          // 1099-INT → interest
          const int99 = [...byType('1099_int'), ...byType('1099')]
          setIfUnset('taxable_interest', sum(int99, 'interest', 'box_1'), '1099-INT', int99.length)

          // 1099-DIV → dividends
          const div99 = [...byType('1099_div'), ...byType('1099')]
          setIfUnset('ordinary_dividends', sum(div99, 'ordinary_dividends', 'box_1a'), '1099-DIV', div99.length)
          setIfUnset('qualified_dividends', sum(div99, 'qualified_dividends', 'box_1b'), '1099-DIV', div99.length)

          // 1099-B → capital gains (proceeds or gain/loss aggregation is complex — punt to net)
          const b99 = byType('1099_b')
          setIfUnset('capital_gains', sum(b99, 'net_gain_loss', 'gain_loss', 'proceeds'), '1099-B', b99.length)

          // 1099-R → IRA / pension distributions
          const r99 = byType('1099_r')
          setIfUnset('ira_distributions', sum(r99.filter(d => (d.meta?.key_values?.distribution_code || '').match(/[147]/)),
                                                'gross_distribution', 'box_1'), '1099-R (IRA)', r99.length)
          setIfUnset('pensions_annuities', sum(r99.filter(d => !(d.meta?.key_values?.distribution_code || '').match(/[147]/)),
                                                 'gross_distribution', 'box_1'), '1099-R (pension)', r99.length)

          // 1099-NEC → self-employment income (Schedule C)
          const nec99 = byType('1099_nec')
          setIfUnset('net_se_income', sum(nec99, 'nonemployee_comp', 'box_1'), '1099-NEC', nec99.length)

          // 1099-MISC → rents, royalties, other → schedule1_income aggregate.
          // Suppressed if caller supplied structured schedule_e: Schedule E's
          // L41 total is injected into schedule1_income downstream, so the
          // 1099-MISC rental amounts already round-trip through that path.
          const misc99 = byType('1099_misc')
          if (!mergedInputs.schedule_e) {
            const miscIncome = sum(misc99, 'rents', 'box_1') + sum(misc99, 'royalties', 'box_2')
                             + sum(misc99, 'other_income', 'box_3')
            setIfUnset('schedule1_income', miscIncome, '1099-MISC', misc99.length)
          } else if (misc99.length) {
            autoMergeLog.push({
              field: 'schedule1_income',
              value: 0,
              sources: [`${misc99.length} × 1099-MISC skipped — schedule_e provided; fold rental/royalty totals into schedule_e.rental_properties to avoid double count`],
            })
          }

          // K-1 → ordinary_income, w2_wages
          const k1s = byType('k1')
          const k1Total = sum(k1s, 'ordinary_income', 'box_1')
          const k1W2 = sum(k1s, 'w2_wages')
          if (k1Total && !mergedInputs.k1_ordinary_income) {
            mergedInputs.k1_ordinary_income = k1Total
            autoMergeLog.push({ field: 'k1_ordinary_income', value: k1Total, sources: [`${k1s.length} × K-1`] })
          }
          if (k1Total && !mergedInputs.schedule1_income) {
            mergedInputs.schedule1_income = (mergedInputs.schedule1_income || 0) + k1Total
          }
          setIfUnset('k1_w2_wages', k1W2, 'K-1', k1s.length)
        }

        // 1120/1120-S: corps that hold brokerage accounts or receive 1099s
        // (e.g. an S-Corp with a treasury/contingency account) get portfolio
        // income reported on Schedule K lines 4, 5a, 7, 8a, 10, 16a.
        if (!isIndividual) {
          const int99  = [...byType('1099_int'), ...byType('1099')]
          const div99  = [...byType('1099_div'), ...byType('1099')]
          const oid99  = byType('1099_oid')
          const b99    = byType('1099_b')

          // Portfolio interest — 1099-INT Box 1 + 1099-OID Box 1 + §1276 recharacterized AMD
          const intBox1    = sum(int99, 'box1_interest', 'interest', 'box_1')
          const oidBox1    = sum(oid99, 'box1_oid', 'oid', 'box_1')
          const amd1276    = sum(b99,   'amd_recharacterized_per_1276')
          const interestTotal = intBox1 + oidBox1 + amd1276

          if (form_type === '1120S') {
            setIfUnset('schedule_k_interest',             interestTotal,                                               '1099-INT/OID/B', int99.length + oid99.length + b99.length)
            setIfUnset('schedule_k_dividends_ordinary',   sum(div99, 'box1a_ordinary_dividends', 'ordinary_dividends'), '1099-DIV',       div99.length)
            setIfUnset('schedule_k_dividends_qualified',  sum(div99, 'box1b_qualified_dividends', 'qualified_dividends'), '1099-DIV',     div99.length)
            // Net short/long-term gain — fact provides `net_short_term_gain_loss` (can be negative)
            setIfUnset('schedule_k_st_cap_gain', sum(b99, 'net_short_term_gain_loss_short', 'net_short_term_gain_loss'), '1099-B', b99.length)
            setIfUnset('schedule_k_lt_cap_gain', sum(b99, 'net_long_term_gain_loss'),                                    '1099-B', b99.length)
          } else if (form_type === '1120') {
            setIfUnset('interest_income', interestTotal,                                                  '1099-INT/OID/B', int99.length + oid99.length + b99.length)
            setIfUnset('dividends',       sum(div99, 'box1a_ordinary_dividends', 'ordinary_dividends'),   '1099-DIV',       div99.length)
            setIfUnset('capital_gains',   sum(b99,   'net_short_term_gain_loss_short', 'net_short_term_gain_loss'), '1099-B', b99.length)
          }
        }
      }
    }

    // ─── NOL auto-carryforward (1120 only) ─────────────────────────────
    // If the prior year for this entity computed an NOL (taxable income
    // negative), auto-populate this year's nol_deduction with the prior
    // year's nol_generated via setIfUnset. Caller can override by
    // passing nol_deduction explicitly. The engine still caps at 80% of
    // TI per §172(a)(2), so even a too-high auto-pull can't under-tax.
    if (entity_id && form_type === '1120') {
      try {
        const { data: priorRet } = await supabase.from('tax_return')
          .select('id, field_values')
          .eq('entity_id', entity_id).eq('tax_year', tax_year - 1)
          .eq('form_type', '1120')
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        // NOL carryforward generated this year = max(0, -L28). Read from the
        // golden-model field_values rather than a separate computed dict.
        const priorTiBeforeNol = (priorRet?.field_values as any)?.['tax.L28_ti_before_nol']
        const priorNolGenerated = (typeof priorTiBeforeNol === 'number' && priorTiBeforeNol < 0)
          ? Math.abs(priorTiBeforeNol) : 0
        if (priorNolGenerated > 0) {
          setIfUnset('nol_deduction', Math.round(priorNolGenerated), `prior-year NOL (${tax_year - 1})`, 1, `cross_year:nol_carryforward`)
        }
      } catch {/* best-effort, skip silently */}
    }

    // ─── Prior-year Schedule L EOY (for BOY rollover) ──────────────────
    // Current BOY comes from prior year's QBO BS (line 912/970 below).
    // That can drift if QBO is edited after a year closes. The prior
    // year's tax_return.field_values carries the AS-FILED BOY equivalents
    // — those are the authoritative numbers. Use them to overlay BOY
    // columns on top of the QBO-derived ones. Maps prior._eoy_d → ._boy_b
    // and prior._eoy_c → ._boy_a (IRS Schedule L column convention).
    let priorSchedLEoy: Record<string, number> | null = null
    if (entity_id && (form_type === '1120' || form_type === '1120S')) {
      try {
        const { data: priorRet } = await supabase.from('tax_return')
          .select('id, field_values')
          .eq('entity_id', entity_id).eq('tax_year', tax_year - 1)
          .eq('form_type', form_type)
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        const fv = priorRet?.field_values
        if (fv && typeof fv === 'object') {
          priorSchedLEoy = fv as Record<string, number>
        }
      } catch {/* best-effort */}
    }
    const applyPriorEoyToBoy = (target: Record<string, number>) => {
      if (!priorSchedLEoy) return
      for (const [priorKey, priorVal] of Object.entries(priorSchedLEoy)) {
        if (typeof priorVal !== 'number' || priorVal === 0) continue
        // schedL.Lxxx_name_eoy_d → schedL.Lxxx_name_boy_b
        // schedL.Lxxx_name_eoy_c → schedL.Lxxx_name_boy_a
        let curKey: string | null = null
        if (priorKey.endsWith('_eoy_d')) curKey = priorKey.slice(0, -'_eoy_d'.length) + '_boy_b'
        else if (priorKey.endsWith('_eoy_c')) curKey = priorKey.slice(0, -'_eoy_c'.length) + '_boy_a'
        if (!curKey || !curKey.startsWith('schedL.')) continue
        // Only overwrite if caller didn't explicitly provide this BOY value
        if ((mergedInputs as any)[curKey] === undefined) {
          target[curKey] = priorVal
        }
      }
    }

    let engineResult: any = null

    if (form_type === '1120') {
      engineResult = calc1120({ ...mergedInputs, tax_year })

      // Auto-pull Schedule L from QBO if entity has a connection and inputs don't already have it
      if (entity_id && !mergedInputs['schedL.L15_total_eoy_d']) {
        try {
          const { data: conn } = await supabase.from('qbo_connection')
            .select('realm_id').eq('entity_id', entity_id).single()
          if (conn) {
            const { buildScheduleL } = await import('../maps/qbo_to_schedule_l.js')
            // Pull current year and prior year balance sheets
            const eoyResp = await fetch(`${req.protocol}://${req.get('host')}/api/qbo/${entity_id}/financials?year=${tax_year}`, {
              headers: {
                'Authorization': req.headers.authorization || '',
                'x-api-key': (req.headers['x-api-key'] as string) || '',
              },
            }).then(r => r.json()).catch(() => null)
            const boyResp = await fetch(`${req.protocol}://${req.get('host')}/api/qbo/${entity_id}/financials?year=${tax_year - 1}`, {
              headers: {
                'Authorization': req.headers.authorization || '',
                'x-api-key': (req.headers['x-api-key'] as string) || '',
              },
            }).then(r => r.json()).catch(() => null)

            if (eoyResp?.balance_sheet?.items) {
              const schedL = buildScheduleL(
                eoyResp.balance_sheet.items,
                boyResp?.balance_sheet?.items,
              )
              // Merge Schedule L into field_values (canonical keys pass through to PDF)
              if (!engineResult.field_values) engineResult.field_values = {}
              for (const [k, v] of Object.entries(schedL)) {
                if (v !== 0) engineResult.field_values[k] = v
              }
              // Overlay BOY from prior year's AS-FILED tax_return — more
              // authoritative than refetching prior-year QBO which can drift.
              applyPriorEoyToBoy(engineResult.field_values)

              // Schedule M-1: line 1 = net income per books, line 10 = taxable income
              const computed = engineResult.computed || {}
              engineResult.field_values['schedM1.L1_net_income_books'] = computed.taxable_income ?? 0
              engineResult.field_values['schedM1.L2_fed_tax_books'] = computed.income_tax ?? 0
              engineResult.field_values['schedM1.L10_income_line28'] = computed.taxable_income_before_nol ?? computed.taxable_income ?? 0

              // Schedule M-2: line 1 = BOY retained, line 8 = EOY retained
              engineResult.field_values['schedM2.L1_beg_balance'] =
                engineResult.field_values['schedL.L25_retained_boy_b']
                ?? schedL['schedL.L25_retained_boy_b'] ?? 0
              engineResult.field_values['schedM2.L8_end_balance'] = schedL['schedL.L25_retained_eoy_d'] || 0
            }
          }
        } catch (_) { /* QBO not connected or fetch failed — skip silently */ }
      }

      // Pass through any schedL/schedM/schedK keys from user inputs into field_values
      const scheduleKeys = Object.entries(mergedInputs).filter(([k]) =>
        k.startsWith('schedL.') || k.startsWith('schedM1.') || k.startsWith('schedM2.') || k.startsWith('schedK.')
      )
      if (scheduleKeys.length) {
        if (!engineResult.field_values) engineResult.field_values = {}
        for (const [k, v] of scheduleKeys) {
          engineResult.field_values[k] = v  // user-provided overrides QBO-derived
        }
      }
    } else if (form_type === '1120S') {
      engineResult = calc1120S(mergedInputs)

      // Auto-pull Schedule L from QBO (same logic as 1120)
      if (entity_id && !mergedInputs['schedL.L15_total_eoy_d']) {
        try {
          const { data: conn } = await supabase.from('qbo_connection')
            .select('realm_id').eq('entity_id', entity_id).single()
          if (conn) {
            const { buildScheduleL } = await import('../maps/qbo_to_schedule_l.js')
            const eoyResp = await fetch(`${req.protocol}://${req.get('host')}/api/qbo/${entity_id}/financials?year=${tax_year}`, {
              headers: {
                'Authorization': req.headers.authorization || '',
                'x-api-key': (req.headers['x-api-key'] as string) || '',
              },
            }).then(r => r.json()).catch(() => null)
            const boyResp = await fetch(`${req.protocol}://${req.get('host')}/api/qbo/${entity_id}/financials?year=${tax_year - 1}`, {
              headers: {
                'Authorization': req.headers.authorization || '',
                'x-api-key': (req.headers['x-api-key'] as string) || '',
              },
            }).then(r => r.json()).catch(() => null)

            if (eoyResp?.balance_sheet?.items) {
              const schedL = buildScheduleL(eoyResp.balance_sheet.items, boyResp?.balance_sheet?.items)
              if (!engineResult.field_values) engineResult.field_values = {}
              for (const [k, v] of Object.entries(schedL)) {
                if (v !== 0) engineResult.field_values[k] = v
              }
              // Overlay BOY from prior year's AS-FILED tax_return.
              applyPriorEoyToBoy(engineResult.field_values)
              // Reconciliation: L1 = ordinary income per books
              const computed = engineResult.computed || {}
              engineResult.field_values['schedM1.L1_net_income_books'] = computed.ordinary_income_loss ?? 0

              // Schedule K pro-rata share items from P&L categorization
              // Common non-ordinary income that should flow to separate K lines
              const pnl = eoyResp.profit_and_loss?.items || {}
              const findByPattern = (patterns: RegExp[]): number => {
                let total = 0
                for (const [k, v] of Object.entries(pnl)) {
                  if (typeof v !== 'number' || v === 0) continue
                  if (patterns.some(p => p.test(k))) total += Math.abs(v)
                }
                return Math.round(total)
              }
              const schedKInterest = findByPattern([/interest\s+income/i, /^interest\s+earned/i])
              const schedKDividends = findByPattern([/dividend\s+income/i, /^dividends/i])
              const schedKRoyalties = findByPattern([/royalt(y|ies)/i])
              if (schedKInterest) engineResult.field_values['schedK.L4_interest'] = schedKInterest
              if (schedKDividends) engineResult.field_values['schedK.L5a_dividends'] = schedKDividends
              if (schedKRoyalties) engineResult.field_values['schedK.L6_royalties'] = schedKRoyalties
            }
          }
        } catch (_) { /* skip */ }
      }

      // Pass through schedule keys from user inputs
      const scheduleKeys1120S = Object.entries(mergedInputs).filter(([k]) =>
        k.startsWith('schedL.') || k.startsWith('schedM1.') || k.startsWith('schedK.')
      )
      if (scheduleKeys1120S.length) {
        if (!engineResult.field_values) engineResult.field_values = {}
        for (const [k, v] of scheduleKeys1120S) engineResult.field_values[k] = v
      }
    } else if (form_type === '1040') {
      // Schedule E — compute first if structured inputs provided, then inject
      // its total into schedule1_income so it flows to Form 1040 line 8.
      let scheduleE: any = null
      if (mergedInputs.schedule_e && typeof mergedInputs.schedule_e === 'object') {
        scheduleE = calcScheduleE({ ...mergedInputs.schedule_e, tax_year } as ScheduleE_Inputs)
        const prior = mergedInputs.schedule1_income || 0
        mergedInputs.schedule1_income = prior + scheduleE.computed.L41_total_income_loss
      }
      engineResult = calc1040({ ...mergedInputs, tax_year })
      if (scheduleE) {
        engineResult.schedule_e = scheduleE
        engineResult.field_values = { ...(engineResult.field_values || {}), ...scheduleE.field_values }
      }

      // ── SSTB guardrail ─────────────────────────────────────────────
      // If the return picked up QBI on K-1 pass-through income AND the
      // caller didn't explicitly set is_sstb AND taxable income crosses
      // the §199A phaseout threshold, refuse to finalize. Silently
      // applying QBI to an SSTB (tax prep, law, consulting, etc.) above
      // the phaseout understates tax by up to ~$40k on a $1.7M AGI. The
      // guardrail forces the caller to confirm is_sstb:true or is_sstb:false
      // before the response returns. Flag-only — never auto-apply — per
      // §199A(d)(2)(B)'s "reputation or skill" catch-all, which NAICS
      // prefix matching can't cleanly identify.
      const callerPassedIsSstb = inputs && Object.prototype.hasOwnProperty.call(inputs, 'is_sstb')
      const qbiDeducted = engineResult?.computed?.qbi_deduction > 0
      if (qbiDeducted && !callerPassedIsSstb) {
        const ti = engineResult.computed.taxable_income || 0
        const filing = mergedInputs.filing_status as keyof typeof TAX_TABLES[number]['qbi_threshold']
        const yearTable = TAX_TABLES[tax_year]
        const phaseoutStart = yearTable?.qbi_threshold?.[filing] ?? Infinity
        const k1SrcAmount = (Number(mergedInputs.qbi_from_k1) || 0) + (Number(mergedInputs.k1_ordinary_income) || 0)
        if (ti > phaseoutStart && k1SrcAmount > 0) {
          // Try to surface a specific SSTB suspicion from any known S-Corp
          // entity in the user's account (best-effort — not a hard check).
          let sstbSuspect: { business_code?: string; category?: string; entity_name?: string } | null = null
          if (entity_id) {
            try {
              const { data: ents } = await supabase.from('tax_entity')
                .select('id, name, meta, form_type').eq('user_id', userId)
              const { isSstbByNaics } = await import('../engine/tax_tables.js')
              for (const e of ents || []) {
                if (e.form_type !== '1120S') continue
                const bc = e.meta?.business_code
                const hit = isSstbByNaics(bc)
                if (hit.match) {
                  sstbSuspect = { business_code: bc, category: hit.category, entity_name: e.name }
                  break
                }
              }
            } catch {/* best-effort */}
          }
          return res.status(409).json({
            error: 'SSTB_CONFIRMATION_REQUIRED',
            message: `Taxable income $${ti.toLocaleString()} exceeds the §199A QBI phaseout threshold $${phaseoutStart.toLocaleString()} (${filing}, TY${tax_year}) and K-1 pass-through income is present ($${k1SrcAmount.toLocaleString()}). The QBI deduction depends on whether the source trade or business is a Specified Service Trade or Business (SSTB — §199A(d)(2)). Pass is_sstb:true or is_sstb:false in inputs to confirm before compute finalizes.`,
            filing_status: filing,
            tax_year,
            taxable_income: ti,
            qbi_phaseout_start: phaseoutStart,
            computed_qbi_if_not_sstb: engineResult.computed.qbi_deduction,
            k1_pass_through_amount: k1SrcAmount,
            suspected_sstb_entity: sstbSuspect,
            hint: sstbSuspect
              ? `The S-Corp "${sstbSuspect.entity_name}" has business_code ${sstbSuspect.business_code} which matches "${sstbSuspect.category}" — likely SSTB. Confirm with is_sstb:true to zero out QBI, or is_sstb:false if you disagree.`
              : 'Check the business code of the source S-Corp. §199A(d)(2) categories: health, law, accounting/tax prep (541213), consulting, investment mgmt, performing arts, athletics, brokerage, and "reputation or skill"-based trades.',
          })
        }
      }
    } else if (['4868', '7004', '8868'].includes(form_type)) {
      engineResult = calcExtension({ ...inputs, extension_type: form_type as ExtensionType, tax_year })
    } else if (form_type === '4562') {
      engineResult = calc4562({ ...inputs, tax_year } as Form4562_Inputs)
    } else if (form_type === '8594') {
      engineResult = calc8594(inputs as Form8594_Inputs)
    } else {
      return res.status(400).json({ error: `Unsupported form_type: ${form_type}` })
    }

    let taxReturn = null
    if (save !== false && entity_id) {
      const isExtension = ['4868', '7004', '8868'].includes(form_type)
      // Merge schedule field_values from engine result into the field_values column.
      // Strip meta.* and preparer.* from existing — they should always come from
      // the entity record, never persist stale values from prior computes.
      const scheduleFieldValues = engineResult?.field_values || {}
      // Seed existing field_values from the row we're about to write.
      // Priority: explicit return_id > amend_of (copy from parent) > latest proforma for this year.
      let seededFieldValues: any = {}
      if (targetRow) {
        const { data } = await supabase.from('tax_return')
          .select('field_values').eq('id', targetRow.id).single()
        seededFieldValues = data?.field_values || {}
      } else if (amendOfRow) {
        seededFieldValues = amendOfRow.field_values || {}
      } else {
        const { data } = await supabase.from('tax_return')
          .select('field_values')
          .eq('entity_id', entity_id).eq('tax_year', tax_year).eq('form_type', form_type)
          .eq('source', isExtension ? 'extension' : 'proforma')
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        seededFieldValues = data?.field_values || {}
      }
      const rawExisting: Record<string, any> = seededFieldValues
      const existingFieldValues: Record<string, any> = {}
      for (const [k, v] of Object.entries(rawExisting)) {
        if (k.startsWith('meta.') || k.startsWith('preparer.')) continue
        existingFieldValues[k] = v
      }

      // Inject entity metadata so it's persisted and visible in the PDF
      const { data: ent } = await supabase.from('tax_entity').select('*').eq('id', entity_id).single()
      const metaFields: Record<string, any> = {}
      if (ent) {
        if (form_type === '1040') {
          // 1040: split name fields — auto-parse entity.name if first/last not explicit
          let first = ent.meta?.first_name
          let last = ent.meta?.last_name
          let spouseFirst = ent.meta?.spouse_first
          let spouseLast = ent.meta?.spouse_last
          if (!first && !last && ent.name) {
            // Handle "X & Y Razzaq" or "X Razzaq" patterns
            const match = ent.name.match(/^(\S+?)(?:\s+&\s+(\S+))?\s+(.+)$/)
            if (match) {
              first = match[1]
              last = match[3]
              if (match[2]) spouseFirst = match[2]
              if (match[2] && !spouseLast) spouseLast = match[3]  // shared surname
            }
          }
          if (first) metaFields['meta.first_name'] = first
          if (last) metaFields['meta.last_name'] = last
          if (spouseFirst) metaFields['meta.spouse_first'] = spouseFirst
          if (spouseLast) metaFields['meta.spouse_last'] = spouseLast
          if (ent.ein) metaFields['meta.ssn'] = ent.ein  // "ein" holds SSN for 1040
          if (ent.meta?.spouse_ssn) metaFields['meta.spouse_ssn'] = ent.meta.spouse_ssn
          if (ent.address) {
            // Split apartment/suite off if present
            const aptMatch = ent.address.match(/^(.+?)\s+(apt|ste|suite|unit|#)\s*(.+)$/i)
            if (aptMatch) {
              metaFields['meta.address'] = aptMatch[1]
              metaFields['meta.apt'] = aptMatch[3]
            } else {
              metaFields['meta.address'] = ent.address
            }
          }
          if (ent.city) metaFields['meta.city'] = ent.city
          if (ent.state) metaFields['meta.state'] = ent.state
          if (ent.zip) metaFields['meta.zip'] = ent.zip
        } else {
          // 1120/1120S: entity_name + address (split street/suite)
          if (ent.name) metaFields['meta.entity_name'] = ent.name
          if (ent.ein) metaFields['meta.ein'] = ent.ein
          if (ent.address) {
            // Parse "SUITE/STE/ROOM/UNIT/#X" off the end of the address string
            const suiteMatch = ent.address.match(/^(.+?)\s+(?:suite|ste|room|rm|unit|#)\s*([\w-]+)\s*$/i)
            if (suiteMatch) {
              metaFields['meta.address'] = suiteMatch[1].trim()
              metaFields['meta.suite'] = suiteMatch[2].trim()
            } else {
              metaFields['meta.address'] = ent.address
            }
          }
          if (ent.meta?.suite) metaFields['meta.suite'] = ent.meta.suite  // explicit override
          if (ent.city) metaFields['meta.city'] = ent.city
          if (ent.state) metaFields['meta.state'] = ent.state
          if (ent.zip) metaFields['meta.zip'] = ent.zip
          // city_state_zip is a legacy alias for forms that have a combined field.
          // Don't map it to a numeric field ID on forms that have separate cells.
          if (ent.city || ent.state || ent.zip)
            metaFields['meta.city_state_zip'] = [ent.city, ent.state, ent.zip].filter(Boolean).join(', ')
          if (ent.date_incorporated) metaFields['meta.date_incorporated'] = ent.date_incorporated
          if (ent.meta?.business_code) {
            metaFields['meta.business_activity_code'] = ent.meta.business_code
            metaFields['meta.business_code'] = ent.meta.business_code  // 1120S canonical key
          }
          // Country defaults to "United States" for domestic corps
          metaFields['meta.country'] = ent.meta?.country || 'United States'
          if (ent.meta?.s_election_date) metaFields['meta.s_election_date'] = ent.meta.s_election_date
          if (ent.meta?.num_shareholders) metaFields['meta.num_shareholders'] = ent.meta.num_shareholders
          // meta.total_assets (form line D) — auto-populate from Schedule L
          // EOY total (schedL.L15_total_eoy_d) so the header matches the
          // balance sheet. Entity.meta.total_assets overrides if explicitly set.
          const l15Total = (engineResult?.field_values || {})['schedL.L15_total_eoy_d']
          if (ent.meta?.total_assets) {
            metaFields['meta.total_assets'] = ent.meta.total_assets
          } else if (l15Total && l15Total !== 0) {
            metaFields['meta.total_assets'] = l15Total
          }
          if (ent.meta?.business_activity) metaFields['meta.business_activity'] = ent.meta.business_activity
          if (ent.meta?.product_service) metaFields['meta.product_service'] = ent.meta.product_service
          // Title is an officer title (e.g. PRESIDENT) — only applies to business returns
          if (ent.meta?.title) metaFields['meta.title'] = ent.meta.title
        }
        // Preparer info
        const prep = ent.meta?.preparer
        if (prep) {
          if (prep.name) metaFields['preparer.name'] = prep.name
          if (prep.ptin) metaFields['preparer.ptin'] = prep.ptin
          if (prep.firm_name) metaFields['preparer.firm_name'] = prep.firm_name
          if (prep.firm_ein) metaFields['preparer.firm_ein'] = prep.firm_ein
          if (prep.firm_address) metaFields['preparer.firm_address'] = prep.firm_address
          if (prep.firm_phone || prep.phone) metaFields['preparer.firm_phone'] = prep.firm_phone || prep.phone
          if (prep.phone) metaFields['preparer.phone'] = prep.phone
        }
      }
      Object.assign(scheduleFieldValues, metaFields)

      // Single canonical merge: parent's sectioned field_values seed, engine
      // output overwrites recomputed lines, anything the engine doesn't
      // touch passes through unchanged. No alias dance, no zero-default,
      // no preserve-seed gate — the field_values shape is canonical
      // (sectioned IRS-line keys per maps/canonical_schema.ts) on every
      // writer, so naive merge is correct.
      const mergedFieldValues = { ...existingFieldValues, ...scheduleFieldValues }

      // Validate before persist. Catches any writer that drifts back to
      // the old descriptive shape before bad data hits the DB. Logs and
      // continues — never blocks a compute on a schema warning.
      const { validateFieldValues } = await import('../maps/canonical_schema.js')
      const fvCheck = validateFieldValues(mergedFieldValues, form_type)
      if (!fvCheck.ok) {
        console.warn(`[compute] field_values shape drift on ${form_type}:`, fvCheck.errors.slice(0, 5))
      }

      // Strip the redundant flat `computed` dict from the persisted shape —
      // every flat metric maps to a sectioned field_values line via
      // maps/metric_to_field.ts. Keep citations / k1s / qbo_warnings for
      // debug + scenario structural data.
      const { computed: _computed, ...computedDataPayload } = (engineResult ?? {}) as any
      void _computed
      const rawPayload = {
        entity_id,
        tax_year,
        form_type,
        status: 'computed',
        input_data: mergedInputs,
        computed_data: computedDataPayload,
        field_values: mergedFieldValues,
        computed_at: new Date().toISOString(),
        pdf_s3_path: null,
        reviewed_at: null,
      }
      const encPayload = await encryptedFields(supabase, userId, rawPayload, ENCRYPTED_RETURN_FIELDS)
      const rowPayload = {
        ...rawPayload,
        ...encPayload,
        ...extractAggregatesFromFv(mergedFieldValues, form_type),
      }

      // Route the write: UPDATE an existing row, INSERT an amendment, or
      // find-or-insert the latest proforma. Never mutates filed_import.
      let data: any = null, error: any = null
      if (targetRow) {
        ;({ data, error } = await supabase.from('tax_return').update(rowPayload)
          .eq('id', targetRow.id).select().single())
      } else if (amendOfRow) {
        ;({ data, error } = await supabase.from('tax_return').insert({
          ...rowPayload,
          source: 'amendment',
          is_amended: true,
          supersedes_id: amendOfRow.id,
        }).select().single())
      } else {
        // Find latest proforma/extension for this year; update if present & new_row not requested
        const src = isExtension ? 'extension' : 'proforma'
        const { data: existingRow } = new_row ? { data: null } : await supabase.from('tax_return')
          .select('id').eq('entity_id', entity_id).eq('tax_year', tax_year)
          .eq('form_type', form_type).eq('source', src)
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        if (existingRow?.id) {
          ;({ data, error } = await supabase.from('tax_return').update(rowPayload)
            .eq('id', existingRow.id).select().single())
        } else {
          ;({ data, error } = await supabase.from('tax_return').insert({
            ...rowPayload,
            source: src,
            is_amended: false,
          }).select().single())
        }
      }

      if (error) return res.status(500).json({ error: error.message })
      taxReturn = data
    }

    // Check PDF coverage — what fields would be filled vs missing
    const { getEngineToCanonicalMap } = await import('../maps/engine_to_pdf.js')
    const { getFieldMap } = await import('../maps/field_maps.js')
    const engineMap = getEngineToCanonicalMap(form_type)
    const formName = form_type === '1120S' ? 'f1120s' : `f${form_type.toLowerCase()}`
    const fieldMapEntries = getFieldMap(formName, tax_year)
    const filledCanonKeys = new Set<string>()
    const computed = engineResult?.computed || {}
    for (const [k, v] of Object.entries({ ...inputs, ...computed })) {
      const canon = engineMap[k]
      if (canon && v !== undefined && v !== null) filledCanonKeys.add(canon)
    }
    // Count schedule field_values (already canonical-keyed)
    const schedFv = engineResult?.field_values || {}
    for (const [k, v] of Object.entries(schedFv)) {
      if (v !== undefined && v !== null && v !== 0) filledCanonKeys.add(k)
    }
    const totalMapFields = fieldMapEntries.length
    const filledCount = filledCanonKeys.size
    const coveragePct = totalMapFields > 0 ? Math.round((filledCount / totalMapFields) * 100) : 0

    // List which major sections have data vs are empty
    const sections: Record<string, { filled: number; total: number }> = {}
    for (const entry of fieldMapEntries) {
      const section = entry.label.split('.')[0] || 'other'
      if (!sections[section]) sections[section] = { filled: 0, total: 0 }
      sections[section].total++
    }

    // Fetch the prior year's return (if any) for comparison
    const isExtensionForm = ['4868', '7004', '8868'].includes(form_type)
    let priorYearInputs: Record<string, any> = {}
    // priorYearComputed retired — readers now bridge via INPUT_TO_CANONICAL +
    // priorYearFieldValues (sectioned IRS-line keys, the golden model).
    const priorYearComputed: Record<string, any> = {}
    let priorYearFieldValues: Record<string, any> = {}
    if (entity_id && !isExtensionForm) {
      // Prefer the filed return as the YOY baseline; if none, fall back to the
      // most recent computed row for that year. An entity can have multiple
      // prior-year rows (filed_import + amendment + proforma scenarios), so
      // .single() was rejecting the lookup — hence every prior_year_value was
      // null and the baseline cross-check never fired.
      const { data: priorRows } = await supabase.from('tax_return')
        .select('input_data, computed_data, field_values, source, updated_at')
        .eq('entity_id', entity_id).eq('tax_year', tax_year - 1).eq('form_type', form_type)
      if (priorRows && priorRows.length) {
        const rank = (r: any) =>
          r.source === 'filed_import' ? 0 :
          r.source === 'amendment'    ? 1 :
          r.source === 'proforma'     ? 2 : 3
        const priorRet = [...priorRows].sort((a, b) => {
          const dr = rank(a) - rank(b)
          if (dr !== 0) return dr
          return (b.updated_at || '').localeCompare(a.updated_at || '')
        })[0]
        priorYearInputs = priorRet.input_data || {}
        priorYearFieldValues = priorRet.field_values || {}
      }
    }

    // Canonical-key bridge for filed_import rows. filed_import stores values
    // under IRS canonical keys (deductions.L13_salaries) rather than engine
    // input names (salaries_wages). Without this bridge, the YOY baseline
    // skips every field that didn't have an explicit input on the filed row.
    // Note: line numbers differ between 1120 (L7/L12/L13/L17/L22/L24) and
    // 1120S (L7/L8/L11/L12/L16/L18) so we cover both.
    const INPUT_TO_CANONICAL: Record<string, string[]> = {
      gross_receipts:        ['income.L1a_gross_receipts'],
      returns_allowances:    ['income.L1b_returns'],
      cost_of_goods_sold:    ['income.L2_cogs', 'cogs.L8_cogs'],
      officer_compensation:  ['deductions.L12_officer_comp', 'deductions.L7_officer_comp'],
      salaries_wages:        ['deductions.L13_salaries', 'deductions.L8_salaries'],
      repairs_maintenance:   ['deductions.L14_repairs', 'deductions.L9_repairs'],
      bad_debts:             ['deductions.L15_bad_debts', 'deductions.L10_bad_debts'],
      rents:                 ['deductions.L16_rents', 'deductions.L11_rents'],
      taxes_licenses:        ['deductions.L17_taxes_licenses', 'deductions.L12_taxes'],
      interest_expense:      ['deductions.L18_interest'],
      interest:              ['deductions.L13_interest'],
      charitable_contrib:    ['deductions.L19_charitable'],
      depreciation:          ['deductions.L20_depreciation', 'deductions.L14_depreciation'],
      depletion:             ['deductions.L21_depletion', 'deductions.L15_depletion'],
      advertising:           ['deductions.L22_advertising', 'deductions.L16_advertising'],
      pension_plans:         ['deductions.L23_pension', 'deductions.L17_pension'],
      employee_benefits:     ['deductions.L24_employee_benefits', 'deductions.L18_employee_benefits'],
      other_deductions:      ['deductions.L26_other_deductions', 'deductions.L20_other'],
      nol_deduction:         ['tax.L29a_nol'],
      estimated_tax_paid:    ['payments.L14_estimated', 'schedJ.J14_estimated_payments'],
    }
    const priorByInputName = (name: string): number | null => {
      if (typeof priorYearInputs[name] === 'number') return priorYearInputs[name]
      if (typeof priorYearComputed[name] === 'number') return priorYearComputed[name]
      const canonicals = INPUT_TO_CANONICAL[name]
      if (canonicals) {
        for (const ck of canonicals) {
          const v = priorYearFieldValues[ck]
          if (typeof v === 'number' && !isNaN(v)) return v
        }
      }
      return null
    }

    // Fields that materially affect tax and shouldn't silently zero-default.
    // Used to mark severity on the missing-fields review.
    const criticalByForm: Record<string, Set<string>> = {
      '1040':  new Set(['wages', 'withholding', 'estimated_payments', 'ira_distributions', 'pensions_annuities', 'social_security', 'net_se_income', 'k1_ordinary_income', 'num_dependents', 'is_sstb']),
      '1120':  new Set(['gross_receipts', 'cost_of_goods_sold', 'officer_compensation', 'salaries_wages', 'depreciation', 'nol_deduction', 'estimated_tax_paid', 'foreign_tax_credit', 'general_business_credit']),
      '1120S': new Set(['gross_receipts', 'cost_of_goods_sold', 'officer_compensation', 'salaries_wages', 'depreciation', 'shareholders']),
    }
    const critical = criticalByForm[form_type] || new Set<string>()

    // Build human-readable missing-fields review list.
    // For each input schema field that's currently 0/undefined, include its
    // description so Claude can walk the user through what's blank.
    // Skip structural/computed fields — focus on fields the user actually provides.
    const missingFields: Array<{
      field: string
      description: string
      irs_line?: string
      category: string
      current_value: number
      prior_year_value?: number | null
      severity: 'critical' | 'normal'
      note?: string
    }> = []
    const schema = INPUT_SCHEMAS[form_type]
    if (schema) {
      for (const f of schema.fields) {
        if (f.type !== 'number') continue
        const v = mergedInputs[f.name]
        if (v === undefined || v === null || v === 0) {
          const prior = priorByInputName(f.name)
          const severity = critical.has(f.name) || (typeof prior === 'number' && Math.abs(prior) >= 1000)
            ? 'critical' : 'normal'
          let note: string | undefined
          if (typeof prior === 'number' && prior !== 0) {
            note = Math.abs(prior) >= 10000
              ? `YOY_ZEROED: prior year filed $${prior.toLocaleString()} on this line — currently $0. Confirm this is intentional.`
              : `Prior year had $${prior.toLocaleString()} — confirm this year is truly $0`
          } else if (critical.has(f.name)) {
            note = 'Material line — do not silently default to 0'
          }
          missingFields.push({
            field: f.name,
            description: f.description,
            irs_line: f.irs_line,
            category: f.category,
            current_value: 0,
            prior_year_value: typeof prior === 'number' ? prior : null,
            severity,
            note,
          })
        }
      }
      // Sort: critical first, then fields with prior-year values, then alphabetical
      missingFields.sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
        const ap = a.prior_year_value ?? 0, bp = b.prior_year_value ?? 0
        if (ap !== bp) return bp - ap
        return a.field.localeCompare(b.field)
      })
    }

    const isExtension = ['4868', '7004', '8868'].includes(form_type)
    res.json({
      return_id: taxReturn?.id || null,
      form_type,
      tax_year,
      source: isExtension ? 'extension' : 'proforma',
      saved: save !== false && !!entity_id,
      computed,
      schedule_e: engineResult?.schedule_e ? {
        computed: engineResult.schedule_e.computed,
        field_values: engineResult.schedule_e.field_values,
      } : undefined,
      citations: engineResult?.citations,
      supporting_documents: supportingDocs.length > 0 ? {
        count: supportingDocs.length,
        types: supportingDocs.map(d => d.doc_type),
        auto_merged: autoMergeLog,  // [{field, value, sources, confidence?}]
        merged_fields: Object.keys(mergedInputs).filter(k => !(k in inputs)),
        note: autoMergeLog.length > 0
          ? 'Values auto-merged from uploaded tax docs. CONFIRM with user before finalizing — a typo or misread value flows straight into the return.'
          : 'Documents found but no numeric fields extracted. Check doc classification.',
      } : undefined,
      // Warnings from the QBO → inputs mapper (SSTB_SUSPECTED,
      // OFFICER_COMP_UNSPLIT, CONTINGENCY_IN_REVENUE, etc.). Non-blocking.
      qbo_warnings: qboWarnings.length > 0 ? qboWarnings : undefined,
      pdf_coverage: {
        filled: filledCount,
        total: totalMapFields,
        pct: coveragePct,
        note: coveragePct < 30
          ? 'Most PDF fields will be blank — provide more inputs or connect QuickBooks'
          : coveragePct < 60
          ? 'Some PDF sections will be incomplete'
          : undefined,
      },
      missing_fields: missingFields.length > 0 ? {
        count: missingFields.length,
        fields: missingFields,
        note: missingFields.length > 3
          ? 'Before generating the PDF, walk the user through these missing/zero fields. For each, ask: (a) leave blank/zero, (b) use prior year, or (c) provide a value now. Do not silently default to 0 for material tax lines.'
          : 'Low-impact — confirm with user before finalizing, but OK to proceed if they confirm no activity.',
      } : undefined,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── One-shot: pull QBO → map → apply overrides → compute ───
// Collapses the two-step pattern (GET /api/qbo/:entity_id/qbo-to-tax-inputs
// → edit → POST /api/returns/compute) into a single call. Use when the
// caller trusts the default mapping or has a small set of field-level
// overrides. Response includes the full compute payload PLUS the mapper
// audit and warnings so the caller can iterate without a second round-trip.
//
// Body: { entity_id, tax_year, form_type, overrides?, return_id?,
//         amend_of?, new_row?, save? }
// overrides: Record<string, number|string|boolean> — shallow-merged onto
//            the mapper-derived inputs before compute. Caller can also
//            pass inputs:{} in the body and achieve the same thing; the
//            overrides alias is provided for clarity.
router.post('/compute_from_qbo', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { entity_id, tax_year, form_type, overrides, return_id, amend_of, new_row, save } = req.body
  if (!entity_id || !tax_year || !form_type) {
    return res.status(400).json({ error: 'entity_id, tax_year, form_type required' })
  }
  if (form_type !== '1120' && form_type !== '1120S') {
    return res.status(400).json({
      error: 'compute_from_qbo currently supports 1120 and 1120S only',
      hint: 'For 1040 pass-through from K-1s, use compute with manual inputs or rely on the existing auto-merge of K-1 facts.',
    })
  }

  // Pull the mapper packet (same code path as GET /qbo-to-tax-inputs).
  try {
    const base = `${req.protocol}://${req.get('host')}`
    const hdrs = {
      'Authorization': req.headers.authorization || '',
      'x-api-key': (req.headers['x-api-key'] as string) || '',
    }
    const [finResp, priorFinResp, entityRow] = await Promise.all([
      fetch(`${base}/api/qbo/${entity_id}/financials?year=${tax_year}`, { headers: hdrs })
        .then(r => r.json()).catch(() => null),
      fetch(`${base}/api/qbo/${entity_id}/financials?year=${tax_year - 1}`, { headers: hdrs })
        .then(r => r.json()).catch(() => null),
      (async () => {
        try {
          const r = await supabase.from('entity').select('meta').eq('id', entity_id).single()
          return r.data
        } catch { return null }
      })(),
    ])
    const pnl = finResp?.profit_and_loss?.items
    if (!pnl) {
      return res.status(404).json({
        error: 'QBO P&L not available — entity may not be connected or no data for this year',
      })
    }

    const { buildCorporateInputsFromQbo } = await import('../maps/qbo_to_inputs.js')
    const packet = buildCorporateInputsFromQbo({
      pnl,
      bs: finResp?.balance_sheet?.items,
      priorBs: priorFinResp?.balance_sheet?.items,
      form_type: form_type as '1120' | '1120S',
      business_code: entityRow?.meta?.business_code,
    })

    // Shallow-merge caller overrides onto mapper inputs.
    const mergedInputs = { ...packet.inputs, ...(overrides || {}) }

    // Forward to /compute internally (loopback call).
    const computeBody = {
      entity_id, tax_year, form_type,
      inputs: mergedInputs,
      return_id, amend_of, new_row, save,
    }
    const computeResp = await fetch(`${base}/api/returns/compute`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify(computeBody),
    }).then(r => r.json())

    // Reconciliation: the dollar-level "did the QBO P&L make it onto the
    // tax form?" check. Without this, a missing $200K of operating expenses
    // produces a quietly-too-high amendment that's invisible to the caller.
    const qboNoiTotal = (() => {
      // QBO "Net Operating Income" = Income (Total) - Expenses (Total)
      // (excludes OtherIncome and OtherExpenses below NOI). We use NOI +
      // OtherIncome - OtherExpenses ≈ "Net Income" because everything
      // operational flows through the form.
      const inc      = pnl['Income (Total)']        || 0
      const exp      = pnl['Expenses (Total)']      || 0
      const otherInc = pnl['OtherIncome (Total)']   || 0
      const otherExp = pnl['OtherExpenses (Total)'] || 0
      return inc - exp + otherInc - otherExp
    })()
    const computed = (computeResp?.computed_data?.computed) || (computeResp?.result?.computed) || {}
    const formOrdinary: number =
      typeof computed.ordinary_income_loss === 'number' ? computed.ordinary_income_loss
      : typeof computed.taxable_income === 'number'      ? computed.taxable_income
      : 0
    // Schedule K portfolio total (1120S) — interest + dividends + cap gains
    // + royalties + tax-exempt interest. For 1120 these flow to L4/L5 and
    // are already in formOrdinary, so portfolio total stays 0.
    const schedKPortfolio: number = form_type === '1120S'
      ? (mergedInputs.schedule_k_interest || 0)
        + (mergedInputs.schedule_k_dividends_ordinary || 0)
        + (mergedInputs.schedule_k_lt_cap_gain || 0)
        + (mergedInputs.schedule_k_st_cap_gain || 0)
        + (mergedInputs.schedule_k_royalties || 0)
        + (mergedInputs.schedule_k_tax_exempt_interest || 0)
      : 0
    const reconciliationDelta = Math.round(qboNoiTotal - formOrdinary - schedKPortfolio)
    const deltaExplanation: string[] = []
    if (Math.abs(reconciliationDelta) > 1000) {
      deltaExplanation.push(
        `Δ ≈ $${reconciliationDelta.toLocaleString()} of QBO P&L did not reach the form. Common causes: meals 50% disallowance, depreciation differences (book vs MACRS), Schedule M-1 add-backs, parent-direct postings, capital items expensed in books.`,
      )
    }

    res.json({
      ...computeResp,
      qbo_mapper: {
        audit: packet.audit,
        dropped: packet.dropped,
        warnings: packet.warnings,
        overrides_applied: Object.fromEntries(
          Object.entries(overrides || {}).map(([k, v]) => [
            k,
            { from_qbo: packet.inputs[k] ?? null, to: v },
          ]),
        ),
        sources: {
          report: 'profit-and-loss',
          basis: finResp?.profit_and_loss?.accounting_method || null,
          pnl_as_of: finResp?.profit_and_loss?.fetched_at || null,
          bs_as_of: finResp?.balance_sheet?.fetched_at || null,
          prior_bs_as_of: priorFinResp?.balance_sheet?.fetched_at || null,
          business_code: entityRow?.meta?.business_code || null,
        },
      },
      reconciliation: {
        qbo_net_income:        Math.round(qboNoiTotal),
        form_ordinary_income:  Math.round(formOrdinary),
        schedule_k_portfolio:  Math.round(schedKPortfolio),
        delta:                 reconciliationDelta,
        delta_explanation:     deltaExplanation,
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Copy fields from prior-year return into current-year inputs ───
router.post('/use-prior-year', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { entity_id, tax_year, form_type, fields, save } = req.body
  if (!entity_id || !tax_year || !form_type) {
    return res.status(400).json({ error: 'entity_id, tax_year, form_type required' })
  }

  // Fetch prior-year rows and pick the authoritative one.
  // Preference: filed_import > latest amendment > latest proforma.
  const { data: priorRows } = await supabase.from('tax_return')
    .select('id, input_data, computed_data, field_values, tax_year, source, computed_at')
    .eq('entity_id', entity_id).eq('tax_year', tax_year - 1).eq('form_type', form_type)
    .order('computed_at', { ascending: false })
  if (!priorRows?.length) {
    return res.status(404).json({ error: `No ${tax_year - 1} ${form_type} return found for this entity` })
  }
  const SOURCE_RANK: Record<string, number> = { filed_import: 0, amendment: 1, proforma: 2, extension: 3 }
  const priorRet = [...priorRows].sort((a, b) => {
    const ra = SOURCE_RANK[a.source as string] ?? 9
    const rb = SOURCE_RANK[b.source as string] ?? 9
    return ra - rb  // lower rank = preferred
  })[0]

  // Fetch current-year return (latest proforma/amendment, not filed_import)
  const { data: currentRows } = await supabase.from('tax_return')
    .select('input_data, source')
    .eq('entity_id', entity_id).eq('tax_year', tax_year).eq('form_type', form_type)
    .in('source', ['proforma', 'amendment', 'extension'])
    .order('computed_at', { ascending: false }).limit(1)
  const currentRet = currentRows?.[0] || null

  const priorInputs: Record<string, any> = priorRet.input_data || {}
  const priorFieldValues: Record<string, any> = (priorRet as any).field_values || {}
  const currentInputs: Record<string, any> = currentRet?.input_data || {}
  // For filed_import rows, input_data carries archival metadata not engine keys —
  // bridge via canonical PDF keys so "use last year's depreciation" still works.
  const { getEngineToCanonicalMap } = await import('../maps/engine_to_pdf.js')
  const engineToCanon = getEngineToCanonicalMap(form_type)

  // If no specific fields requested, copy every numeric input that's currently blank
  const schema = INPUT_SCHEMAS[form_type]
  const allNumeric = schema ? schema.fields.filter((f: any) => f.type === 'number').map((f: any) => f.name) : []
  const targetFields: string[] = fields && fields.length ? fields : allNumeric

  const copied: Record<string, { from_prior: number; via?: string }> = {}
  const updatedInputs = { ...currentInputs }
  for (const f of targetFields) {
    // Resolve prior-year value: engine input first, then sectioned field_values
    // via the engine→canonical map. computed_data is no longer consulted —
    // every total maps to a sectioned field_values line per the golden model.
    let priorVal: any = priorInputs[f]
    let via: string | undefined
    if ((priorVal === undefined || priorVal === null) && engineToCanon[f]) {
      priorVal = priorFieldValues[engineToCanon[f]]
      if (priorVal !== undefined) via = `field_values.${engineToCanon[f]}`
    }
    if (typeof priorVal === 'number' && priorVal !== 0) {
      const cur = updatedInputs[f]
      if (cur === undefined || cur === null || cur === 0) {
        updatedInputs[f] = priorVal
        copied[f] = { from_prior: priorVal, ...(via ? { via } : {}) }
      }
    }
  }

  res.json({
    prior_tax_year: priorRet.tax_year,
    prior_source: priorRet.source,
    target_tax_year: tax_year,
    copied_count: Object.keys(copied).length,
    copied,
    merged_inputs: save ? undefined : updatedInputs,
    note: save
      ? 'Call compute again with these values to update the return'
      : Object.keys(copied).length > 0
      ? `Copied ${Object.keys(copied).length} fields from ${priorRet.tax_year}. Pass merged_inputs to compute_return to update the ${tax_year} return.`
      : 'No fields copied — either all requested fields were already set, or prior year had $0 for them too',
  })
})

// ─── Generate filled PDF and return download URL ───
const S3_BUCKET = process.env.S3_BUCKET || 'tax-api-storage-2026'

router.get('/:id/pdf', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  // Load the return
  const { data: taxReturn } = await supabase.from('tax_return')
    .select('*').eq('id', req.params.id).single()
  if (!taxReturn) return res.status(404).json({ error: 'Return not found' })

  // Verify ownership via entity
  const { data: entity } = await supabase.from('tax_entity')
    .select('user_id').eq('id', taxReturn.entity_id).single()
  if (!entity || entity.user_id !== userId) return res.status(403).json({ error: 'Forbidden' })

  // ─── Completeness gate ─────────────────────────────────────
  // Block PDF generation only when there's STRONG evidence something is wrong:
  //   - Prior year had the value ≥ $1,000 and current year is $0 (suggests missed entry)
  // Mere presence in a hard-coded "critical" set isn't enough — many critical
  // fields are legitimately $0 (no NOL, no foreign tax credit, etc.).
  //
  // Bypass paths:
  //   - skip_review=true query param
  //   - tax_return.reviewed_at is set (confirmed previously, cleared on recompute)
  //   - extensions (4868/7004/8868 — minimal by design)
  const isExtensionType = ['4868', '7004', '8868'].includes(taxReturn.form_type)
  const skipReview = req.query.skip_review === 'true' || taxReturn.reviewed_at
  if (!isExtensionType && !skipReview) {
    const apiKey = req.headers['x-api-key'] as string || req.headers.authorization?.replace('Bearer ', '') || ''
    const reviewResp = await fetch(`${req.protocol}://${req.get('host')}/api/returns/compute`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: taxReturn.entity_id,
        tax_year: taxReturn.tax_year,
        form_type: taxReturn.form_type,
        inputs: taxReturn.input_data || {},
        save: false,
      }),
    }).then(r => r.json()).catch(() => null)

    const mf = reviewResp?.missing_fields
    // Only block on fields where prior year had real money AND current is blank.
    // That's strong evidence of a missed entry vs. a genuinely zero year.
    const suspicious = (mf?.fields || []).filter((f: any) =>
      typeof f.prior_year_value === 'number' && f.prior_year_value >= 1000
    )

    if (suspicious.length > 0) {
      return res.status(400).json({
        error: `Return has ${suspicious.length} field(s) that were non-zero in prior year but are now blank — confirm with user before finalizing`,
        suspicious_fields: suspicious,
        all_missing: mf,
        pdf_coverage: reviewResp?.pdf_coverage,
        how_to_proceed: [
          '1. Review each suspicious_fields entry: prior year had this value, this year is $0',
          '2. Ask user: is this genuinely $0, or did we miss something?',
          '3. If $0 is correct: call mark_reviewed(return_id) or retry with skip_review=true',
          '4. If data was missed: provide values and call compute_return again',
        ],
      })
    }
  }

  // If we already have a cached PDF, return presigned URL (skip with ?regenerate=true)
  if (taxReturn.pdf_s3_path && req.query.regenerate !== 'true') {
    try {
      const { runPython } = await import('../lib/run_python.js')
      const script = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
url = s3.generate_presigned_url('get_object', Params={
    'Bucket': '${S3_BUCKET}', 'Key': '${taxReturn.pdf_s3_path}'
}, ExpiresIn=3600)
print(json.dumps({'url': url}))
`
      const result = runPython(script, { timeout: 10000 })
      return res.json(JSON.parse(result.trim()))
    } catch {}
  }

  // Generate the PDF using the full builder (same code that produces verified returns)
  try {
    // Get entity data
    const { data: entityData } = await supabase.from('tax_entity')
      .select('name, ein, address, city, state, zip, date_incorporated, meta')
      .eq('id', taxReturn.entity_id).single()
    if (!entityData) return res.status(404).json({ error: 'Entity not found' })

    // Try to get raw textract KVs from the source document
    let textractKvs: Array<{ key: string; value: string }> | undefined
    const { data: docs } = await supabase.from('document')
      .select('textract_data')
      .eq('entity_id', taxReturn.entity_id)
      .eq('tax_year', taxReturn.tax_year)
      .not('textract_data', 'is', null)
      .limit(1)
    if (docs?.[0]?.textract_data?.kvs) {
      textractKvs = docs[0].textract_data.kvs
    }

    // Pull Schedule L from QBO if connected (BOY = prior year EOY, EOY = current year)
    let schedLOverrides: Record<string, number> = {}
    try {
      const { data: qboConn } = await supabase.from('qbo_connection')
        .select('id').eq('entity_id', taxReturn.entity_id).eq('is_active', true).single()
      if (qboConn) {
        const API_BASE = `http://localhost:${process.env.PORT || 3737}`
        const apiKey = req.headers['x-api-key'] as string || req.headers.authorization?.replace('Bearer ', '') || ''
        const [eoyResp, boyResp] = await Promise.all([
          fetch(`${API_BASE}/api/qbo/${taxReturn.entity_id}/financials?year=${taxReturn.tax_year}`, {
            headers: { 'x-api-key': apiKey },
          }),
          fetch(`${API_BASE}/api/qbo/${taxReturn.entity_id}/financials?year=${taxReturn.tax_year - 1}`, {
            headers: { 'x-api-key': apiKey },
          }),
        ])
        const eoyData = await eoyResp.json() as any
        const boyData = await boyResp.json() as any
        const eoyBs = eoyData?.balance_sheet?.items || {}
        const boyBs = boyData?.balance_sheet?.items || {}
        if (Object.keys(eoyBs).length > 0) {
          schedLOverrides = buildScheduleL(eoyBs, boyBs)
        }
      }
    } catch (e: any) {
      console.error('QBO Schedule L failed:', e.message)
    }

    // Build PDF — dispatch to extension builder or return builder
    const isExtension = ['4868', '7004', '8868'].includes(taxReturn.form_type)
    let pdf: any, filled: number, pages: number, forms: string[]

    if (isExtension) {
      const { buildExtensionPdf } = await import('../builders/build_extension.js')
      const extInputs = {
        extension_type: taxReturn.form_type as any,
        tax_year: taxReturn.tax_year,
        ...taxReturn.input_data,
      }
      const extResult = await buildExtensionPdf(extInputs, taxReturn.tax_year)
      pdf = extResult.pdf
      filled = extResult.filled
      pages = pdf.getPageCount()
      forms = [`Form ${taxReturn.form_type}`]
    } else {
      const result = await buildReturnPdf({
        formType: taxReturn.form_type,
        taxYear: taxReturn.tax_year,
        entity: entityData,
        inputData: taxReturn.input_data,
        // Pass the full computed_data (without the deprecated `.computed`
        // flat dict) so structural payloads like schedule_e survive — the
        // builder still reads computedData?.schedule_e for nested rentals/
        // partnerships data. Flat metrics flow via fieldValues only.
        computedData: taxReturn.computed_data,
        fieldValues: { ...taxReturn.field_values, ...schedLOverrides },
        textractKvs,
      })
      pdf = result.pdf; filled = result.filled; pages = result.pages; forms = result.forms
    }

    // Upload to S3
    const pdfBytes = await pdf.save()
    const s3Key = `returns/${userId}/${taxReturn.id}.pdf`

    const { runPython } = await import('../lib/run_python.js')
    const { writeFileSync } = await import('fs')
    const tmpPath = `/tmp/${taxReturn.id}.pdf`
    writeFileSync(tmpPath, Buffer.from(pdfBytes))

    const uploadScript = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
s3.upload_file('${tmpPath}', '${S3_BUCKET}', '${s3Key}', ExtraArgs={'ContentType': 'application/pdf'})
url = s3.generate_presigned_url('get_object', Params={
    'Bucket': '${S3_BUCKET}', 'Key': '${s3Key}'
}, ExpiresIn=3600)
print(json.dumps({'url': url}))
`
    const result = runPython(uploadScript, { timeout: 30000 })
    const { url } = JSON.parse(result.trim())

    // Cache the S3 path on the return
    await supabase.from('tax_return').update({ pdf_s3_path: s3Key }).eq('id', req.params.id)

    res.json({ url, filled, pages, forms, year: taxReturn.tax_year })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Extension forms (4868, 7004, 8868) ───

// Validate extension inputs
router.post('/extension/validate', async (req, res) => {
  const { extension_type, inputs } = req.body
  const errors: Array<{field: string; message: string}> = []
  const warnings: Array<{field: string; message: string}> = []

  const validTypes: ExtensionType[] = ['4868', '7004', '8868']
  if (!extension_type || !validTypes.includes(extension_type)) {
    errors.push({ field: 'extension_type', message: `extension_type must be one of: ${validTypes.join(', ')}` })
  }
  if (!inputs || typeof inputs !== 'object') {
    errors.push({ field: 'inputs', message: 'inputs object is required' })
  }

  if (errors.length) return res.json({ valid: false, errors, warnings })

  const schema = INPUT_SCHEMAS[extension_type]
  if (schema) {
    for (const field of schema.fields) {
      if (field.required && (inputs[field.name] === undefined || inputs[field.name] === null || inputs[field.name] === '')) {
        errors.push({ field: field.name, message: `${field.name} is required for Form ${extension_type}` })
      }
    }
    const knownFields = new Set(schema.fields.map((f: any) => f.name))
    for (const key of Object.keys(inputs)) {
      if (!knownFields.has(key)) {
        warnings.push({ field: key, message: `Unknown field "${key}" — will be ignored` })
      }
    }
  }

  res.json({ valid: errors.length === 0, errors, warnings })
})

// Compute + optionally fill extension form
router.post('/extension', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { extension_type, tax_year = 2025, inputs, entity_id, generate_pdf = false, save = true } = req.body

  const validTypes: ExtensionType[] = ['4868', '7004', '8868']
  if (!extension_type || !validTypes.includes(extension_type)) {
    return res.status(400).json({ error: `extension_type must be one of: ${validTypes.join(', ')}` })
  }
  if (!inputs || typeof inputs !== 'object') {
    return res.status(400).json({ error: 'inputs object is required' })
  }

  try {
    // Build engine inputs
    const engineInputs: ExtensionInputs = {
      extension_type,
      tax_year,
      taxpayer_name:           inputs.taxpayer_name || '',
      taxpayer_id:             inputs.taxpayer_id || '',
      address:                 inputs.address || '',
      city:                    inputs.city || '',
      state:                   inputs.state || '',
      zip:                     inputs.zip || '',
      estimated_tax_liability: inputs.estimated_tax_liability || 0,
      total_payments:          inputs.total_payments || 0,
      amount_paying:           inputs.amount_paying || 0,
      // 4868 specific
      spouse_ssn:              inputs.spouse_ssn,
      out_of_country:          inputs.out_of_country,
      form_1040nr_no_wages:    inputs.form_1040nr_no_wages,
      // 7004 specific
      form_code:               inputs.form_code,
      calendar_year:           inputs.calendar_year,
      is_foreign_corp:         inputs.is_foreign_corp,
      is_consolidated_parent:  inputs.is_consolidated_parent,
      // 8868 specific
      return_code:             inputs.return_code,
      org_books_care_of:       inputs.org_books_care_of,
      telephone:               inputs.telephone,
      fax:                     inputs.fax,
      extension_date:          inputs.extension_date,
    }

    const result = calcExtension(engineInputs)

    // Optionally generate PDF and upload to S3
    let pdfUrl = null
    let pdfFilled = 0
    if (generate_pdf) {
      const { buildExtensionPdf } = await import('../builders/build_extension.js')
      const { pdf, filled } = await buildExtensionPdf(engineInputs, tax_year)
      pdfFilled = filled
      const pdfBytes = await pdf.save()

      const { writeFileSync } = await import('fs')
      const tmpPath = `/tmp/ext_${extension_type}_${tax_year}_${Date.now()}.pdf`
      writeFileSync(tmpPath, Buffer.from(pdfBytes))

      const s3Key = `extensions/${userId}/${extension_type}_${tax_year}_${Date.now()}.pdf`
      const { runPython } = await import('../lib/run_python.js')
      const uploadScript = `
import boto3, json
s3 = boto3.client('s3', region_name='us-east-1')
s3.upload_file('${tmpPath}', '${S3_BUCKET}', '${s3Key}', ExtraArgs={'ContentType': 'application/pdf'})
url = s3.generate_presigned_url('get_object', Params={
    'Bucket': '${S3_BUCKET}', 'Key': '${s3Key}'
}, ExpiresIn=3600)
print(json.dumps({'url': url}))
`
      const uploadResult = runPython(uploadScript, { timeout: 30000 })
      pdfUrl = JSON.parse(uploadResult.trim()).url
    }

    // Optionally save to database — find-or-insert the latest extension for
    // (entity, year, form_type); update if present, else insert.
    let taxReturn = null
    if (save && entity_id) {
      // Strip the flat computed dict for symmetry with proforma/amendment
      // persists; keeps citations + qbo_warnings if any.
      const { computed: _extComputed, ...extComputedData } = (result ?? {}) as any
      void _extComputed
      const extRaw = { input_data: inputs, computed_data: extComputedData }
      const extEnc = await encryptedFields(supabase, userId, extRaw, ENCRYPTED_RETURN_FIELDS)
      const rowPayload = {
        entity_id,
        tax_year,
        form_type: extension_type,
        status: 'computed',
        source: 'extension',
        is_amended: false,
        ...extRaw,
        ...extEnc,
        // Extensions don't populate agg_* — those are full-return metrics.
        // The helper returns all-null for unknown form types, which matches
        // the prior behavior (extension result.computed never had these keys).
        ...extractAggregatesFromFv(null, extension_type),
        computed_at: new Date().toISOString(),
        pdf_s3_path: null,
      }
      const { data: existing } = await supabase.from('tax_return')
        .select('id').eq('entity_id', entity_id).eq('tax_year', tax_year)
        .eq('form_type', extension_type).eq('source', 'extension')
        .order('computed_at', { ascending: false }).limit(1).maybeSingle()
      const q = existing?.id
        ? supabase.from('tax_return').update(rowPayload).eq('id', existing.id)
        : supabase.from('tax_return').insert(rowPayload)
      const { data, error } = await q.select().single()
      if (error) return res.status(500).json({ error: error.message })
      taxReturn = data
    }

    res.json({
      return_id: taxReturn?.id || null,
      extension_type,
      tax_year,
      saved: save && !!entity_id,
      computed: result.computed,
      citations: result.citations,
      pdf_url: pdfUrl,
      pdf_filled: pdfFilled,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Mark return as reviewed (bypass completeness gate) ───
router.post('/:id/review', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { data: ret } = await supabase.from('tax_return')
    .select('entity_id').eq('id', req.params.id).single()
  if (!ret) return res.status(404).json({ error: 'Return not found' })

  const { data: ent } = await supabase.from('tax_entity')
    .select('user_id').eq('id', ret.entity_id).single()
  if (!ent || ent.user_id !== userId) return res.status(403).json({ error: 'Forbidden' })

  const { error } = await supabase.from('tax_return')
    .update({ reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true, reviewed_at: new Date().toISOString() })
})

// ─── Delete a return ───
router.delete('/:id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  // Verify ownership via entity
  const { data: ret } = await supabase.from('tax_return')
    .select('id, entity_id, form_type, tax_year, source')
    .eq('id', req.params.id).single()
  if (!ret) return res.status(404).json({ error: 'Return not found' })

  const { data: entity } = await supabase.from('tax_entity')
    .select('user_id').eq('id', ret.entity_id).single()
  if (!entity || entity.user_id !== userId) return res.status(403).json({ error: 'Forbidden' })

  // Cascade: delete scenarios that reference this return as their base
  await supabase.from('scenario').delete().eq('base_return_id', req.params.id)

  // Delete the return itself
  const { error } = await supabase.from('tax_return').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  res.json({
    success: true,
    deleted: { id: ret.id, form_type: ret.form_type, tax_year: ret.tax_year, source: ret.source },
  })
})

export default router
