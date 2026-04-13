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
import { calc1120, calc1120S, calc1040 } from '../engine/tax_engine.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

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

    // 5. Save tax_return
    const { data: taxReturn, error } = await supabase.from('tax_return').upsert({
      entity_id: entityId,
      tax_year: taxYear,
      form_type: formType,
      status: 'computed',
      input_data: engineInput,
      computed_data: engineResult,
      field_values: extracted,
      verification: {
        mapper_stats: mapped.stats,
        discrepancies,
        extracted_count: mapped.fields.length,
        unmapped_count: mapped.unmapped.length,
      },
      computed_at: new Date().toISOString(),
    }, { onConflict: 'entity_id,tax_year,form_type,is_amended' }).select().single()

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

  const { data: returns } = await supabase.from('tax_return')
    .select('*, tax_entity(name)')
    .eq('entity_id', req.params.entity_id)
    .eq('is_amended', false)
    .order('tax_year', { ascending: true })

  if (!returns?.length) return res.json({ comparison: null })

  // Build comparison matrix
  const years = returns.map(r => r.tax_year)
  const metrics = ['gross_profit', 'total_income', 'total_deductions', 'taxable_income',
    'income_tax', 'total_tax', 'overpayment', 'balance_due', 'ordinary_income_loss']

  const matrix: Record<string, Record<number, number>> = {}
  for (const m of metrics) matrix[m] = {}

  for (const r of returns) {
    const c = r.computed_data?.computed || {}
    for (const m of metrics) {
      if (c[m] !== undefined) matrix[m][r.tax_year] = c[m]
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
    returns: returns.map(r => ({ id: r.id, year: r.tax_year, form: r.form_type, status: r.status })),
    matrix,
    changes,
  })
})

export default router
