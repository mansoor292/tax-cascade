/**
 * computeReturn — the POST /api/returns/compute body, as a callable service.
 *
 * Moved verbatim out of routes/returns.ts (where it was a 1,000-line
 * handler) with only the mechanical changes: `return res.status(N).json(X)`
 * became `return { status: N, body: X }`, the arithmetic-validation block
 * became services/compute_validation.ts, and the thrown-error path returns
 * errorOutcome(e). The route handler and the two places that used to
 * HTTP-POST this server's own /compute endpoint (compute_from_qbo, the PDF
 * completeness gate) now call this directly.
 *
 * Behavior contracts preserved from the handler era — see the inline
 * comments; in particular filed_import rows are never written, and
 * `inputs:{}` is a no-op merge over the seeded row.
 */
import { calc1120, calc1120S, calc1040, calcExtension, calc4562, calc8594, calcScheduleE, type ExtensionInputs, type ExtensionType, type Form4562_Inputs, type Form8594_Inputs, type ScheduleE_Inputs } from '../engine/tax_engine.js'
import { TAX_TABLES } from '../engine/tax_tables.js'
import { encryptedFields, hydrate, ENCRYPTED_RETURN_FIELDS, ENCRYPTED_ENTITY_FIELDS, RETURN_ENC_COLS } from '../lib/row_crypto.js'
import { errorOutcome, type HttpOutcome } from '../lib/http_error.js'
import { serviceClient } from '../lib/supabase.js'
import { getFinancials } from '../routes/qbo.js'
import { validateInputArithmetic } from './compute_validation.js'
import { entityIdentityFields } from '../builders/entity_identity.js'
import { extractAggregates as extractAggregatesFromFv } from '../maps/metric_to_field.js'
import { INPUT_SCHEMAS } from '../routes/schema.js'

const supabase = serviceClient()

/** Decrypt a tax_return row in place. Ownership runs through the entity, so
 *  the user id has to be passed — the row has no user_id of its own. */
async function hydrateReturn(row: any, userId: string): Promise<void> {
  await hydrate(supabase, row, { ...ENCRYPTED_RETURN_FIELDS, userId })
}

async function hydrateReturns(rows: any[] | null | undefined, userId: string): Promise<void> {
  for (const r of rows || []) await hydrateReturn(r, userId)
}

export async function computeReturn(userId: string, body: any): Promise<HttpOutcome> {
  const { entity_id, tax_year, form_type, inputs, save, return_id, amend_of, new_row } = body || {}
  if (!form_type || !tax_year || !inputs) {
    return { status: 400, body: { error: 'form_type, tax_year, and inputs are required' } }
  }

  if (!TAX_TABLES[tax_year]) {
    return { status: 400, body: { error: `No tax tables for year ${tax_year}` } }
  }

  // ── Arithmetic validation (pure — see services/compute_validation.ts) ──
  {
    const validationErrors = validateInputArithmetic(inputs as Record<string, any>)
    if (validationErrors.length) {
      return { status: 422, body: {
        error: 'ARITHMETIC_MISMATCH',
        message: 'One or more *_detail arrays or Schedule L totals do not sum to the claimed scalar. Fix the mismatch before compute.',
        mismatches: validationErrors,
        hint: 'Either (a) correct the _detail array to sum to the scalar, (b) correct the scalar to match the detail sum, or (c) omit one side and let the other stand.',
      } }
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
    if (!data) return { status: 404, body: { error: `return_id ${return_id} not found` } }
    if (data.source === 'filed_import') {
      return { status: 409, body: {
        error: 'Cannot compute onto a filed_import row — filed returns are immutable archives.',
        hint: 'Pass amend_of=<return_id> to start a new amendment, or omit return_id to write a fresh proforma.',
      } }
    }
    targetRow = data
  }
  let amendOfRow: { id: string; entity_id: string; tax_year: number; form_type: string; field_values: any } | null = null
  if (amend_of) {
    const { data } = await supabase.from('tax_return')
      .select(`id, entity_id, tax_year, form_type, field_values, ${RETURN_ENC_COLS}`).eq('id', amend_of).single()
    if (!data) return { status: 404, body: { error: `amend_of ${amend_of} not found` } }
    await hydrateReturn(data, userId)
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
          .select(`input_data, ${RETURN_ENC_COLS}`).eq('id', seedId).single()
        await hydrateReturn(seedRow, userId)
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
            getFinancials(entity_id, tax_year, { userId }).catch(() => null),
            getFinancials(entity_id, tax_year - 1, { userId }).catch(() => null),
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
          .select(`id, field_values, ${RETURN_ENC_COLS}`)
          .eq('entity_id', entity_id).eq('tax_year', tax_year - 1)
          .eq('form_type', '1120')
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        await hydrateReturn(priorRet, userId)
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
          .select(`id, field_values, ${RETURN_ENC_COLS}`)
          .eq('entity_id', entity_id).eq('tax_year', tax_year - 1)
          .eq('form_type', form_type)
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        await hydrateReturn(priorRet, userId)
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
            const eoyResp = await getFinancials(entity_id, tax_year, { userId }).catch(() => null)
            const boyResp = await getFinancials(entity_id, tax_year - 1, { userId }).catch(() => null)

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
            const eoyResp = await getFinancials(entity_id, tax_year, { userId }).catch(() => null)
            const boyResp = await getFinancials(entity_id, tax_year - 1, { userId }).catch(() => null)

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
          return { status: 409, body: {
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
          } }
        }
      }
    } else if (['4868', '7004', '8868'].includes(form_type)) {
      engineResult = calcExtension({ ...inputs, extension_type: form_type as ExtensionType, tax_year })
    } else if (form_type === '4562') {
      engineResult = calc4562({ ...inputs, tax_year } as Form4562_Inputs)
    } else if (form_type === '8594') {
      engineResult = calc8594(inputs as Form8594_Inputs)
    } else {
      return { status: 400, body: { error: `Unsupported form_type: ${form_type}` } }
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
          .select(`field_values, ${RETURN_ENC_COLS}`).eq('id', targetRow.id).single()
        await hydrateReturn(data, userId)
        seededFieldValues = data?.field_values || {}
      } else if (amendOfRow) {
        seededFieldValues = amendOfRow.field_values || {}
      } else {
        const { data } = await supabase.from('tax_return')
          .select(`field_values, ${RETURN_ENC_COLS}`)
          .eq('entity_id', entity_id).eq('tax_year', tax_year).eq('form_type', form_type)
          .eq('source', isExtension ? 'extension' : 'proforma')
          .order('computed_at', { ascending: false }).limit(1).maybeSingle()
        await hydrateReturn(data, userId)
        seededFieldValues = data?.field_values || {}
      }
      const rawExisting: Record<string, any> = seededFieldValues
      const existingFieldValues: Record<string, any> = {}
      for (const [k, v] of Object.entries(rawExisting)) {
        if (k.startsWith('meta.') || k.startsWith('preparer.')) continue
        existingFieldValues[k] = v
      }

      // Inject entity metadata so it's persisted and visible in the PDF.
      // Hydrate first: ein is encrypted at rest, and without this the PDF
      // header's EIN/SSN went blank once the plaintext column was nulled.
      const { data: ent } = await supabase.from('tax_entity').select('*').eq('id', entity_id).single()
      await hydrate(supabase, ent, { ...ENCRYPTED_ENTITY_FIELDS, userId })
      const metaFields: Record<string, any> = entityIdentityFields(ent, form_type, engineResult?.field_values || {})
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

      if (error) return errorOutcome({ message: error.message })
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
        .select(`input_data, computed_data, field_values, source, updated_at, ${RETURN_ENC_COLS}`)
        .eq('entity_id', entity_id).eq('tax_year', tax_year - 1).eq('form_type', form_type)
      await hydrateReturns(priorRows, userId)
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
    return { status: 200, body: {
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
    } }
  } catch (e: any) {
    return errorOutcome(e)
  }
}
