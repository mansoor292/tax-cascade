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
import { mergeDocuments, SUPPORTED_DOC_TYPES } from './document_merge.js'
import { calc1120, calc1120X, form1120XColumn, calc1120S, calc1040, calcExtension, calc4562, calc8594, calcScheduleE, type ExtensionType, type Form4562_Inputs, type Form8594_Inputs, type ScheduleE_Inputs } from '../engine/tax_engine.js'
import { TAX_TABLES } from '../engine/tax_tables.js'
import { encryptedFields, hydrate, ENCRYPTED_RETURN_FIELDS, ENCRYPTED_ENTITY_FIELDS, ENCRYPTED_DOC_FIELDS, RETURN_ENC_COLS, DOC_ENC_COLS } from '../lib/row_crypto.js'
import { errorOutcome, type HttpOutcome } from '../lib/http_error.js'
import { lazyServiceClient } from '../lib/supabase.js'
import { getFinancials } from '../routes/qbo.js'
import { validateInputArithmetic } from './compute_validation.js'
import { deriveSupportingSchedules, type ReconciliationIssue } from './reconciliation.js'
import { entityIdentityFields } from '../builders/entity_identity.js'
import { extractAggregates as extractAggregatesFromFv } from '@taxengine/shared'
import { INPUT_SCHEMAS } from '../routes/schema.js'

const supabase = lazyServiceClient()

/** Decrypt a tax_return row in place. Ownership runs through the entity, so
 *  the user id has to be passed — the row has no user_id of its own. */
async function hydrateReturn(row: any, userId: string): Promise<void> {
  await hydrate(supabase, row, { ...ENCRYPTED_RETURN_FIELDS, userId })
}

async function hydrateReturns(rows: any[] | null | undefined, userId: string): Promise<void> {
  for (const r of rows || []) await hydrateReturn(r, userId)
}

/**
 * Canonical keys a caller may set directly on an 1120/1120-S: the balance
 * sheet and reconciliations, Schedule K, and the supporting forms the engine
 * does not compute (1125-A cost of goods sold, 4562 depreciation/amortization).
 */
export function isPassthroughScheduleKey(k: string): boolean {
  return /^(schedL|schedM1|schedM2|schedK|cogs|dep|amort)\./.test(k)
}

/**
 * Schedule J and payment lines a caller may set only where the engine left
 * them alone.
 *
 * A return computed onto an existing row keeps every line the engine does
 * not recompute. Edgewater Ventures' 2024 amendment was seeded from the
 * filed return and kept its Schedule J line 13 (176,667 prior-year credit)
 * and line 37 (107,876 refunded) after the corrected payments were put on
 * line 14, so the row counted the credit twice, and no input could clear
 * it. Lines the engine computes (J14, L33, L36…) stay the engine's; the
 * caller can only fill or zero the ones it never touches.
 */
export function overlayUncomputedLines(
  engineFv: Record<string, any>,
  inputs: Record<string, any>,
): void {
  for (const [k, v] of Object.entries(inputs)) {
    if (!/^(schedJ|payments)\./.test(k)) continue
    if (k in engineFv) continue
    engineFv[k] = v
  }
}

export async function computeReturn(userId: string, body: any): Promise<HttpOutcome> {
  const { entity_id, tax_year, form_type, inputs, save, return_id, amend_of, new_row } = body || {}
  // merge_sources:false — compute from the inputs given and nothing else: no
  // books (QBO), no documents, no NOL carry-in. An amendment built from its
  // base (services/amendment_base.ts) uses it: the books may agree with the
  // filed return or not, and that is shown beside it, never mixed into it.
  const mergeSources = body?.merge_sources !== false
  // amend_base: start an amendment from these figures when there is no
  // filed_import row to amend (a filed return held only in the catalog).
  const amendBase: { values: Record<string, number>; meta: Record<string, unknown> } | undefined = body?.amend_base
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
  let targetRow: { id: string; source: string; entity_id: string; tax_year: number; form_type: string; supersedes_id?: string | null } | null = null
  if (return_id) {
    const { data } = await supabase.from('tax_return')
      .select('id, source, entity_id, tax_year, form_type, supersedes_id').eq('id', return_id).single()
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
  if (!amendOfRow && !targetRow && amendBase) {
    amendOfRow = { id: null as unknown as string, entity_id, tax_year, form_type, field_values: amendBase.values }
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
      else if (amendOfRow) seedId = amendBase ? null : amendOfRow.id || null
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

    // Re-validate against the MERGED inputs, not just the caller's.
    //
    // The first pass above only saw what this caller typed. A caller who
    // updates `other_deductions` to a new figure without restating
    // `other_deductions_detail` passes that check — there is no detail array
    // in their payload to check — and then the stored detail is merged back in
    // underneath. The return is saved with an itemisation that contradicts the
    // line it supports, and nothing ever looked. That is exactly how line 20
    // came to read 212,475 over a breakdown totalling 208,550.
    //
    // The same applies to a Schedule L where only some lines are restated.
    // Validate what will actually be persisted.
    {
      const mergedErrors = validateInputArithmetic(mergedInputs as Record<string, any>)
      if (mergedErrors.length) {
        return { status: 422, body: {
          error: 'ARITHMETIC_MISMATCH',
          message: 'The saved inputs this compute would produce do not add up. '
                 + 'These fields come from merging your inputs over the ones already '
                 + 'stored on the return, so a figure you did not resend may be the '
                 + 'one that no longer agrees.',
          mismatches: mergedErrors,
          hint: 'Restate the detail array alongside the scalar you changed (or send '
              + 'an empty array to drop it), or correct whichever side is wrong.',
        } }
      }
    }
    const autoMergeLog: Array<{ field: string; value: number; sources: string[]; confidence?: string }> = []
    // Warnings from the QBO mapper — non-blocking context for the caller
    // (SSTB_SUSPECTED, OFFICER_COMP_UNSPLIT, CONTINGENCY_IN_REVENUE, ...)
    const qboWarnings: Array<{ code: string; message: string; fix_hint?: string }> = []

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
    if (mergeSources && entity_id && (form_type === '1120S' || form_type === '1120')) {
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

    if (mergeSources && entity_id) {
      const supportedTypes = SUPPORTED_DOC_TYPES
      // The _enc twins + hydrate are LOAD-BEARING: post-cutover the
      // plaintext meta/textract_data columns are null, and this query read
      // them bare — auto-merge silently saw zero key_values on every
      // encrypted document. A tester uploaded a full 2024 source package
      // (W-2, 1099-INTs, 1099-K) and computed $0 fills; the values were
      // sitting in meta_enc the whole time.
      const { data: docs } = await supabase.from('document')
        .select(`id, doc_type, meta, textract_data, filename, ${DOC_ENC_COLS}`)
        .eq('entity_id', entity_id)
        .eq('tax_year', tax_year)
        .in('doc_type', supportedTypes)
      for (const d of docs || []) {
        await hydrate(supabase, d, { ...ENCRYPTED_DOC_FIELDS, userId })
      }
      if (docs?.length) {
        supportingDocs = docs
        mergeDocuments(docs, form_type, { mergedInputs, setIfUnset, autoMergeLog })
      }
    }

    // ─── NOL auto-carryforward (1120 only) ─────────────────────────────
    // If the prior year for this entity computed an NOL (taxable income
    // negative), auto-populate this year's nol_deduction with the prior
    // year's nol_generated via setIfUnset. Caller can override by
    // passing nol_deduction explicitly. The engine still caps at 80% of
    // TI per §172(a)(2), so even a too-high auto-pull can't under-tax.
    if (mergeSources && entity_id && form_type === '1120') {
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

        // A prior year can hand forward an NOL WITHOUT having made a loss: the
        // 80% cap leaves part of an existing carryforward unused. Only the
        // loss case was carried, so a chain of profitable years slowly dropped
        // the balance — Edgewater Ventures lost $63,642 of carryforward into
        // 2024 that way. Both sources add: a loss generates new NOL, and the
        // unused balance survives alongside it.
        const priorRemaining = Number((priorRet?.field_values as any)?.['nol.carryover_next_year'])
        const carried = priorNolGenerated + (Number.isFinite(priorRemaining) && priorRemaining > 0 ? priorRemaining : 0)
        if (carried > 0) {
          const why = priorNolGenerated > 0 && priorRemaining > 0 ? 'loss + unused carryforward'
            : priorNolGenerated > 0 ? 'loss' : 'unused carryforward'
          setIfUnset('nol_deduction', Math.round(carried), `prior-year NOL (${tax_year - 1}, ${why})`, 1, `cross_year:nol_carryforward`)
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
    let reconciliationIssues: ReconciliationIssue[] = []

    if (form_type === '1120') {
      engineResult = calc1120({ ...mergedInputs, tax_year })

      // Auto-pull Schedule L from QBO if entity has a connection and inputs don't already have it
      if (mergeSources && entity_id && !mergedInputs['schedL.L15_total_eoy_d']) {
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

              // Schedule M-1 placeholder until the caller states book income:
              // books = taxable income after tax, so lines 1 + 2 come to page 1
              // line 28 with no other differences. (Line 1 used to be taxable
              // income itself, which only "tied" because line 10 was typed in
              // rather than added up; deriveReconciliation1120 adds it up.)
              const computed = engineResult.computed || {}
              const line28 = computed.taxable_income_before_nol ?? computed.taxable_income ?? 0
              engineResult.field_values['schedM1.L1_net_income_books'] = line28 - (computed.income_tax ?? 0)
              engineResult.field_values['schedM1.L2_fed_tax_books'] = computed.income_tax ?? 0

              // Schedule M-2: line 1 = BOY retained, line 8 = EOY retained
              engineResult.field_values['schedM2.L1_beg_balance'] =
                engineResult.field_values['schedL.L25_retained_boy_b']
                ?? schedL['schedL.L25_retained_boy_b'] ?? 0
              engineResult.field_values['schedM2.L8_end_balance'] = schedL['schedL.L25_retained_eoy_d'] || 0
            }
          }
        } catch (_) { /* QBO not connected or fetch failed — skip silently */ }
      }

      // Pass through schedule keys from user inputs into field_values.
      // cogs./dep./amort. carry Form 1125-A and Form 4562: without them the
      // return could state line 2 and line 20 but not the forms behind them,
      // and the attached 1125-A/4562 printed blank.
      const scheduleKeys = Object.entries(mergedInputs).filter(([k]) => isPassthroughScheduleKey(k))
      if (scheduleKeys.length) {
        if (!engineResult.field_values) engineResult.field_values = {}
        for (const [k, v] of scheduleKeys) {
          engineResult.field_values[k] = v  // user-provided overrides QBO-derived
        }
      }
      if (engineResult.field_values) overlayUncomputedLines(engineResult.field_values, mergedInputs)

      // The supporting schedules' arithmetic — M-1/M-2 totals, Form 1125-A
      // lines 6 and 8, Form 4562's limits and totals (services/reconciliation.ts).
      if (engineResult.field_values) {
        reconciliationIssues = deriveSupportingSchedules('1120', engineResult.field_values, mergedInputs, tax_year,
          engineResult.computed)
      }

      // What is left of the NOL after this year must be recorded on this year.
      //
      // §172(a)(2) caps the deduction at 80% of taxable income, so a profitable
      // year with a carryforward uses part of it and leaves the rest. The
      // engine computes that remainder as nol_carryforward_remaining and it was
      // discarded: computed_data is not persisted, so nothing in the vault ever
      // said how much was left. Edgewater Ventures carried $587,582 into 2022,
      // used $279,413, carried $258,381 into 2023, used $191,261 — and the
      // $63,642 still outstanding simply vanished, so 2024 computed with no NOL
      // at all and overstated tax by ~$17,500.
      //
      // It goes in field_values because that is what survives, what the export
      // shows, and where next year's compute looks for it.
      if (engineResult.computed) {
        if (!engineResult.field_values) engineResult.field_values = {}
        engineResult.field_values['nol.carryover_next_year'] =
          Math.round(engineResult.computed.nol_carryforward_remaining ?? 0)
      }

      // An amendment also carries its Form 1120-X (engine/tax_engine.ts
      // calc1120X): column A from `amended_x.original` when the caller gives
      // it — the figures as filed or as the IRS later adjusted them — or else
      // from the return this one supersedes.
      if (engineResult.field_values && (targetRow?.source === 'amendment' || amendOfRow)) {
        const xIn = (mergedInputs.amended_x || {}) as Record<string, any>
        let original = xIn.original
        if (!original) {
          let origFv = amendOfRow?.field_values
          if (!origFv && targetRow?.supersedes_id) {
            const { data: orig } = await supabase.from('tax_return')
              .select(`field_values, ${RETURN_ENC_COLS}`).eq('id', targetRow.supersedes_id).single()
            await hydrateReturn(orig, userId)
            origFv = orig?.field_values
          }
          if (origFv) original = form1120XColumn(origFv)
        }
        if (original) {
          const x = calc1120X({ ...xIn, original, corrected: form1120XColumn(engineResult.field_values) } as any)
          Object.assign(engineResult.field_values, x.field_values)
        }
      }
    } else if (form_type === '1120S') {
      engineResult = calc1120S(mergedInputs)

      // Auto-pull Schedule L from QBO (same logic as 1120)
      if (mergeSources && entity_id && !mergedInputs['schedL.L15_total_eoy_d']) {
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
              // The P&L summary lists every account TWICE — once bare
              // ("Dividend Income") and once under its section path
              // ("OtherIncome > Dividend Income") — plus "(Total)" roll-ups
              // that contain their own children. Summing across all of them
              // double counts: a single $511.16 dividend account came out as
              // $1,164 on Schedule K line 5a, while the engine's own line 18
              // reconciliation used the correct figure. Count the bare leaf
              // keys only.
              const findByPattern = (patterns: RegExp[]): number => {
                let total = 0
                for (const [k, v] of Object.entries(pnl)) {
                  if (typeof v !== 'number' || v === 0) continue
                  if (k.includes(' > ') || k.includes('(Total)')) continue
                  if (patterns.some(p => p.test(k))) total += Math.abs(v)
                }
                return Math.round(total)
              }
              // These are a fallback for entities that supplied nothing: an
              // explicit input is a stated fact and a pattern match over
              // account names is a guess, so the guess must never overwrite it.
              const stated = (k: string) => mergedInputs[k] !== undefined && mergedInputs[k] !== null
              const schedKInterest = findByPattern([/interest\s+income/i, /^interest\s+earned/i])
              const schedKDividends = findByPattern([/dividend\s+income/i, /^dividends/i])
              const schedKRoyalties = findByPattern([/royalt(y|ies)/i])
              if (schedKInterest && !stated('schedule_k_interest')) {
                engineResult.field_values['schedK.L4_interest'] = schedKInterest
              }
              if (schedKDividends && !stated('schedule_k_dividends_ordinary')) {
                engineResult.field_values['schedK.L5a_dividends'] = schedKDividends
              }
              if (schedKRoyalties && !stated('schedule_k_royalties')) {
                engineResult.field_values['schedK.L6_royalties'] = schedKRoyalties
              }
            }
          }
        } catch (_) { /* skip */ }
      }

      // Pass through schedule keys from user inputs. schedM2 was missing from
      // this list while the 1120 path had it, so there was no way to put an
      // accumulated adjustments account on an S corporation return — the one
      // form where that schedule carries real weight, since AAA is what
      // determines how much a shareholder can draw out tax-free.
      const scheduleKeys1120S = Object.entries(mergedInputs).filter(([k]) => isPassthroughScheduleKey(k))
      if (scheduleKeys1120S.length) {
        if (!engineResult.field_values) engineResult.field_values = {}
        for (const [k, v] of scheduleKeys1120S) engineResult.field_values[k] = v
      }

      // Schedules M-1 and M-2 follow the income statement. They were pure
      // pass-through, so when the figures above them changed the caller's
      // earlier values stayed put — a recompute moved ordinary income by
      // $33,450 and left M-1 line 8 and M-2 line 2 on the old number, with the
      // ending AAA (and the shareholder's basis) built on income the return no
      // longer reported. The lines the form computes are derived here; the
      // facts only the caller knows are left alone.
      if (engineResult.field_values) {
        reconciliationIssues = deriveSupportingSchedules('1120S', engineResult.field_values, mergedInputs, tax_year,
          engineResult.computed)
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
              : 'Check the business code of the source S-Corp. §199A(d)(2) categories: health, law, accounting/tax prep (NAICS 5412), consulting, investment mgmt, performing arts, athletics, brokerage, and "reputation or skill"-based trades.',
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
    let schemaRejectedKeys: string[] = []
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
      // Sections the engine computes in full are restated, never inherited:
      // see services/engine_owned.ts for the stale-line bug this prevents.
      const { dropEngineOwned } = await import('./engine_owned.js')
      const rawExisting: Record<string, any> = dropEngineOwned(seededFieldValues, form_type)
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
      // field_values is the golden model (src/schema): a key the golden
      // schema does not know is rejected from it — moved to
      // computed_data.schema_rejected, kept and reported, never blocking a
      // compute. A parent return seeded from an old import is the usual source.
      const { splitBySchema } = await import('../schema/validate.js')
      const { kept: mergedFieldValues, rejected: schemaRejected } = splitBySchema({ ...existingFieldValues, ...scheduleFieldValues }, form_type)
      schemaRejectedKeys = Object.keys(schemaRejected)
      if (Object.keys(schemaRejected).length) {
        console.warn(`[compute] ${Object.keys(schemaRejected).length} field_values key(s) not in the golden schema on ${form_type} moved to computed_data.schema_rejected:`, Object.keys(schemaRejected).slice(0, 10))
      }

      // Shape check (descriptive keys that should have been translated at the boundary).
      const { validateFieldValues } = await import('../maps/canonical_schema.js')
      const fvCheck = validateFieldValues(mergedFieldValues, form_type)
      if (!fvCheck.ok) {
        console.warn(`[compute] field_values shape drift on ${form_type}:`, fvCheck.errors.slice(0, 5))
      }

      // Strip the redundant flat `computed` dict from the persisted shape —
      // every flat metric maps to a sectioned field_values line via
      // @taxengine/shared metrics. Keep citations / k1s / qbo_warnings for
      // debug + scenario structural data.
      const { computed: _computed, ...engineData } = (engineResult ?? {}) as any
      void _computed
      const withBase = amendBase?.meta ? { ...engineData, amendment_base: amendBase.meta } : engineData
      const computedDataPayload = Object.keys(schemaRejected).length ? { ...withBase, schema_rejected: schemaRejected } : withBase
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
      // A 1040 scalar the engine derives from source documents is not missing.
      const derivedFrom: Record<string, string[]> = {
        wages: ['w2s'], withholding: ['w2s'],
        taxable_interest: ['taxable_interest_detail', 'k1_portfolio'],
        ordinary_dividends: ['ordinary_dividends_detail', 'k1_portfolio'],
        qualified_dividends: ['ordinary_dividends_detail', 'k1_portfolio'],
        capital_gains: ['capital_transactions_detail', 'k1_portfolio'],
        ltcg_portion: ['capital_transactions_detail', 'k1_portfolio'],
        qbi_from_k1: ['k1_ordinary_income'],
      }
      const hasSource = (name: string) => (derivedFrom[name] || []).some(src => {
        const v = mergedInputs[src]
        return Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v
      })
      for (const f of schema.fields) {
        if (f.type !== 'number') continue
        if (form_type === '1040' && hasSource(f.name)) continue
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
      // field_values keys the golden schema does not know, moved to
      // computed_data.schema_rejected instead of being stored as lines.
      schema_rejected: schemaRejectedKeys.length > 0 ? schemaRejectedKeys : undefined,
      // Schedule M-1 line 8 is labelled "Income (loss) (Schedule K, line 18)".
      // When the reconciling items do not bridge book income to that total,
      // say so rather than forcing the number and hiding it.
      reconciliation_issues: reconciliationIssues.length > 0 ? reconciliationIssues : undefined,
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
