/**
 * One-way translation: descriptive canonical keys → sectioned IRS-line keys.
 *
 * Applied at the THREE boundaries where descriptive shape enters the system:
 *
 *   - `intake/json_model_mapper.ts` — Textract → canonical
 *   - `maps/qbo_to_inputs.ts`       — QBO → tax inputs packet
 *   - `routes/returns.ts`           — POST /api/returns/compute request body
 *
 * After translation, internal storage and consumers (engine I/O,
 * `tax_return.field_values`, PDF builder, validators, Compare UI) speak
 * sectioned only. There is no inverse translation anywhere — sectioned is
 * the canonical shape from this point on.
 *
 * Reuses the alias maps that already live in engine_to_pdf.ts so the
 * descriptive ↔ sectioned vocabulary stays in one place. Eventually
 * those maps should move here and engine_to_pdf becomes pure PDF
 * mapping; not done in this commit to keep the diff focused.
 */

import { CANONICAL_ALIAS_1120, CANONICAL_ALIAS_1120S, CANONICAL_ALIAS_1040 } from './engine_to_pdf.js'

function aliasMap(form_type: string): Record<string, string> {
  switch (form_type) {
    case '1120':  return CANONICAL_ALIAS_1120
    case '1120S': return CANONICAL_ALIAS_1120S
    case '1040':  return CANONICAL_ALIAS_1040
    default: return {}
  }
}

/**
 * Translate a descriptive field_values dict to its sectioned equivalent.
 *
 * Behavior:
 *   - keys that are already sectioned (`income.L1a_gross_receipts`,
 *     `schedL.L25_retained_eoy_d`, etc.) pass through unchanged
 *   - keys that have a descriptive→sectioned alias get rewritten
 *   - keys that are unknown (no alias, not already sectioned) pass through
 *     so we don't silently drop preparer/meta/preparer.* or schedK.* keys.
 *     Validation in canonical_schema.ts catches unrecognized keys at write.
 *
 * If both the descriptive and sectioned shapes appear in the input dict
 * (legacy callers), the sectioned value wins — the engine and PDF builder
 * speak sectioned, so that's the source of truth.
 */
export function descriptiveToSectioned(
  values: Record<string, any> | null | undefined,
  form_type: string,
): Record<string, any> {
  if (!values) return {}
  const aliases = aliasMap(form_type)
  const out: Record<string, any> = {}

  // First pass: copy already-sectioned (and unmappable) keys.
  for (const [k, v] of Object.entries(values)) {
    if (aliases[k]) continue // descriptive — handled in second pass
    out[k] = v
  }

  // Second pass: descriptive keys → sectioned. Skip if the sectioned form
  // already came through above (sectioned wins).
  for (const [descriptive, sectioned] of Object.entries(aliases)) {
    if (!(descriptive in values)) continue
    if (sectioned in out) continue // already-sectioned beat us, leave it
    out[sectioned] = values[descriptive]
  }

  return out
}

/**
 * Same translation applied to an INPUTS object (the descriptive engine-input
 * shape — `gross_receipts`, `officer_compensation`, etc.). Engine inputs use
 * a flat shape (no `income.` prefix), so the alias map doesn't help directly.
 *
 * For now this is a no-op — engine inputs ARE the descriptive shape and
 * the engine itself knows how to map them onto sectioned field_values.
 * This export exists so the boundary is explicit and a future refactor
 * (where engine inputs become sectioned) only changes one helper.
 */
export function inputsToCanonical<T extends Record<string, any>>(
  inputs: T,
  _form_type: string,
): T {
  return inputs
}
