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
import { mapToCanonical, type TextractOutput } from '../intake/json_model_mapper.js'
import { calc1120, calc1120S, calc1040, calcExtension, calc4562, calc8594, calcScheduleE, type ExtensionInputs, type ExtensionType, type Form4562_Inputs, type Form8594_Inputs, type ScheduleE_Inputs } from '../engine/tax_engine.js'
import { encryptedFields, hydrate, ENCRYPTED_RETURN_FIELDS, ENCRYPTED_ENTITY_FIELDS, RETURN_ENC_COLS } from '../lib/row_crypto.js'
import { extractAggregates as extractAggregatesFromFv, readMetric, COMPARE_METRICS } from '../maps/metric_to_field.js'

/** Decrypt a tax_return row in place. Ownership runs through the entity, so
 *  the user id has to be passed — the row has no user_id of its own. */
async function hydrateReturn(row: any, userId: string): Promise<void> {
  await hydrate(supabase, row, { ...ENCRYPTED_RETURN_FIELDS, userId })
}

/** Strip ciphertext blobs before sending a row to a client — they are large,
 *  opaque, and of no use once the row has been decrypted. */
function stripEnc<T extends Record<string, any>>(row: T): T {
  if (!row) return row
  for (const k of Object.keys(row)) if (k.endsWith('_enc')) delete (row as any)[k]
  return row
}

/** The nested tax_entity(ein) on a joined select is encrypted too, and
 *  hydrate() does not reach into nested objects. */
async function hydrateNestedEntity(row: any, userId: string): Promise<void> {
  if (row?.tax_entity) await hydrate(supabase, row.tax_entity, { ...ENCRYPTED_ENTITY_FIELDS, userId })
}

/** Same for a list of rows. */
async function hydrateReturns(rows: any[] | null | undefined, userId: string): Promise<void> {
  for (const r of rows || []) await hydrateReturn(r, userId)
}
import { TAX_TABLES } from '../engine/tax_tables.js'
import { INPUT_SCHEMAS } from './schema.js'
import { buildCanonicalModel, buildReturnPdf } from '../builders/build_return_pdf.js'
import { buildScheduleL } from '../maps/qbo_to_schedule_l.js'
import { sendError, sendDbError } from '../lib/http_error.js'
import { getFinancials } from './qbo.js'
import { computeReturn } from '../services/compute_return.js'
import { serviceClient, requestUserId as getUser } from '../lib/supabase.js'

const supabase = serviceClient()


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

    if (error) return sendDbError(res, error)

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
    sendError(res, e)
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
    .select('*, tax_entity(name, form_type, ein, ein_enc)')
    .in('entity_id', entityIds)
    .order('tax_year', { ascending: false })

  if (error) return sendDbError(res, error)
  await hydrateReturns(data, userId)
  for (const r of data || []) { await hydrateNestedEntity(r, userId); stripEnc((r as any).tax_entity) }
  res.json({ returns: (data || []).map(stripEnc) })
})

// Get single return with full breakdown
router.get('/:id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  // tax_return has no user_id of its own — ownership runs through the
  // entity. This route checked that the CALLER was signed in and then never
  // checked the record was theirs, and because every route module uses the
  // service-role key (which bypasses RLS) the database did not object
  // either. Any account could read any return by id.
  const { data } = await supabase.from('tax_return')
    .select('*, tax_entity(name, form_type, ein, ein_enc, user_id), tax_return_form(*)')
    .eq('id', req.params.id).single()

  if (!data) return res.status(404).json({ error: 'Not found' })
  if ((data as any).tax_entity?.user_id !== userId) {
    // 404 rather than 403: a stranger should not learn the id exists.
    return res.status(404).json({ error: 'Not found' })
  }
  // Do not hand the owner column back to the client.
  if ((data as any).tax_entity) delete (data as any).tax_entity.user_id
  await hydrateReturn(data, userId)
  await hydrateNestedEntity(data, userId)
  stripEnc((data as any).tax_entity)
  res.json({ return: stripEnc(data as any) })
})

// Multi-year comparison for an entity
router.get('/compare/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  
  if (!userId) return res.status(401).json({ error: "Unauthorized" })

  // Same exposure as GET /:id — filtering on entity_id alone returned any
  // entity's full return history, name and figures included, to any signed-in
  // account. Confirm the entity is this user's before reading anything.
  const { data: ownerRow } = await supabase.from('tax_entity')
    .select('id, name').eq('id', req.params.entity_id).eq('user_id', userId).maybeSingle()
  if (!ownerRow) return res.status(404).json({ error: 'Entity not found' })

  const { data: allRows } = await supabase.from('tax_return')
    .select('*, tax_entity(name)')
    .eq('entity_id', req.params.entity_id)
    .order('tax_year', { ascending: true })
    .order('computed_at', { ascending: false })

  // Decrypt before anything reads field_values / computed_data below.
  await hydrateReturns(allRows, userId)

  // An entity with no returns yet used to answer { comparison: null }, a
  // shape with no all_rows. The Compare page iterates all_rows directly, so
  // this threw during render and unmounted the WHOLE app — a blank white
  // page with no nav and no error boundary. Keep the shape constant and the
  // page renders its empty state instead.
  if (!allRows?.length) {
    // Send the entity even when there is nothing to compare: the page titles
    // itself from it, and an explicit null here is just as unreadable to that
    // code as the missing key it replaced.
    return res.json({
      comparison: null,
      entity: { name: ownerRow.name },
      years: [], returns: [], all_rows: [], matrix: {}, changes: {},
    })
  }

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
  const out = await computeReturn(userId, req.body)
  res.status(out.status).json(out.body)
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
    const [finResp, priorFinResp, entityRow] = await Promise.all([
      getFinancials(entity_id, tax_year, { userId }).catch(() => null),
      getFinancials(entity_id, tax_year - 1, { userId }).catch(() => null),
      (async () => {
        try {
          // Was querying a nonexistent table 'entity' — always null, which
          // silently disabled the business_code/SSTB handling on this path.
          const r = await supabase.from('tax_entity')
            .select('meta').eq('id', entity_id).eq('user_id', userId).single()
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

    const computeResp = (await computeReturn(userId, {
      entity_id, tax_year, form_type,
      inputs: mergedInputs,
      return_id, amend_of, new_row, save,
    })).body

    // Reconciliation: the dollar-level "did the QBO P&L make it onto the
    // tax form?" check. Without this, a missing $200K of operating expenses
    // produces a quietly-too-high amendment that's invisible to the caller.
    const qboNoiTotal = (() => {
      // QBO "Net Income" = Income - COGS - Expenses + OtherIncome - OtherExpenses.
      // QBO's standard P&L lists COGS as its own section between Income and
      // Expenses (yielding Gross Profit, then Net Operating Income, then
      // Net Income). Forgetting to subtract COGS made the reconciliation
      // delta look like the entire COGS total — fooling readers into
      // thinking ~$2.9M of expenses had gone missing.
      const inc      = pnl['Income (Total)']        || 0
      const cogs     = pnl['COGS (Total)']          || 0
      const exp      = pnl['Expenses (Total)']      || 0
      const otherInc = pnl['OtherIncome (Total)']   || 0
      const otherExp = pnl['OtherExpenses (Total)'] || 0
      return inc - cogs - exp + otherInc - otherExp
    })()
    // /compute (loopback) returns engine output at top-level `computed`.
    // Older shapes also nested it under computed_data.computed or
    // result.computed; check all three for forward/backward compat.
    const computed = computeResp?.computed
      || computeResp?.computed_data?.computed
      || computeResp?.result?.computed
      || {}
    // For reconciliation we compare current-period book NOI to current-period
    // taxable income BEFORE NOL. NOL is a carryforward from prior years —
    // applying it would make the delta = nol_applied for any return that
    // uses a carryforward, which is misleading (the deduction is real, just
    // not a current-period book/tax difference).
    //   1120S → ordinary_income_loss (no NOL deduction at the entity level)
    //   1120  → taxable_income_before_nol
    //   1040  → taxable_income (1040 NOL is a Schedule 1 line item; treat
    //           same as 1120S for now)
    const formOrdinary: number =
      typeof computed.ordinary_income_loss === 'number'      ? computed.ordinary_income_loss
      : typeof computed.taxable_income_before_nol === 'number' ? computed.taxable_income_before_nol
      : typeof computed.taxable_income === 'number'          ? computed.taxable_income
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
          // accounting_method is top-level on the financials result; the old
          // code read it under profit_and_loss and always got null.
          basis: finResp?.accounting_method || null,
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
    sendError(res, e)
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
    .select(`id, input_data, computed_data, field_values, tax_year, source, computed_at, ${RETURN_ENC_COLS}`)
    .eq('entity_id', entity_id).eq('tax_year', tax_year - 1).eq('form_type', form_type)
    .order('computed_at', { ascending: false })
  if (!priorRows?.length) {
    return res.status(404).json({ error: `No ${tax_year - 1} ${form_type} return found for this entity` })
  }
  await hydrateReturns(priorRows, userId)
  const SOURCE_RANK: Record<string, number> = { filed_import: 0, amendment: 1, proforma: 2, extension: 3 }
  const priorRet = [...priorRows].sort((a, b) => {
    const ra = SOURCE_RANK[a.source as string] ?? 9
    const rb = SOURCE_RANK[b.source as string] ?? 9
    return ra - rb  // lower rank = preferred
  })[0]

  // Fetch current-year return (latest proforma/amendment, not filed_import)
  const { data: currentRows } = await supabase.from('tax_return')
    .select(`input_data, source, ${RETURN_ENC_COLS}`)
    .eq('entity_id', entity_id).eq('tax_year', tax_year).eq('form_type', form_type)
    .in('source', ['proforma', 'amendment', 'extension'])
    .order('computed_at', { ascending: false }).limit(1)
  await hydrateReturns(currentRows, userId)
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

  // Post-cutover the plaintext columns are null — without this the PDF builder
  // below reads empty input_data/computed_data/field_values and fills nothing.
  await hydrateReturn(taxReturn, userId)

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
    const reviewResp = await computeReturn(userId, {
      entity_id: taxReturn.entity_id,
      tax_year: taxReturn.tax_year,
      form_type: taxReturn.form_type,
      inputs: taxReturn.input_data || {},
      save: false,
    }).then(o => o.body).catch(() => null)

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
      const { s3PresignGet } = await import('../lib/s3.js')
      return res.json({ url: await s3PresignGet(taxReturn.pdf_s3_path, 3600) })
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
        const [eoyData, boyData] = await Promise.all([
          getFinancials(taxReturn.entity_id, taxReturn.tax_year, { userId }).catch(() => null),
          getFinancials(taxReturn.entity_id, taxReturn.tax_year - 1, { userId }).catch(() => null),
        ]) as any[]
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

    // Body upload — no more /tmp PDF that was never unlinked.
    const { s3PutObject, s3PresignGet } = await import('../lib/s3.js')
    await s3PutObject(s3Key, Buffer.from(pdfBytes), 'application/pdf')
    const url = await s3PresignGet(s3Key, 3600)

    // Cache the S3 path on the return
    await supabase.from('tax_return').update({ pdf_s3_path: s3Key }).eq('id', req.params.id)

    res.json({ url, filled, pages, forms, year: taxReturn.tax_year })
  } catch (e: any) {
    sendError(res, e)
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

      const s3Key = `extensions/${userId}/${extension_type}_${tax_year}_${Date.now()}.pdf`
      const { s3PutObject, s3PresignGet } = await import('../lib/s3.js')
      await s3PutObject(s3Key, Buffer.from(pdfBytes), 'application/pdf')
      pdfUrl = await s3PresignGet(s3Key, 3600)
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
      if (error) return sendDbError(res, error)
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
    sendError(res, e)
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
  if (error) return sendDbError(res, error)
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
  if (error) return sendDbError(res, error)

  res.json({
    success: true,
    deleted: { id: ret.id, form_type: ret.form_type, tax_year: ret.tax_year, source: ret.source },
  })
})

export default router
