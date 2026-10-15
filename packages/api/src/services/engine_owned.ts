/**
 * Field-value sections the engine computes IN FULL from the inputs.
 *
 * compute_return persists `{ ...existing, ...engine }`, and the engine only
 * writes the lines that are non-zero. So a line that drops to zero keeps its
 * previous value forever. The 2025 joint return found this after the
 * filed-return parity sprint (2026-10-15): Form 8960 line 7 kept the 123 of
 * substitute payments from an earlier compute after the input was
 * reclassified. The form's own line 8 total (computed fresh) no longer
 * included it, so the printed form did not add up.
 *
 * For a section the engine owns outright, nothing in the stored row is a
 * user-supplied value: every line is a function of the inputs. Those
 * sections are therefore cleared before the merge, and the engine's output
 * is the whole section. Sections that mix engine lines with passthrough
 * inputs (Schedule M-1, Schedule L, ...) are NOT listed. Clearing those
 * would delete what the caller stored.
 */
export const ENGINE_OWNED_SECTIONS: Record<string, readonly string[]> = {
  '1040': ['f7203.', 'f8812.', 'f8959.', 'f8960.', 'f8995a.'],
}

export function dropEngineOwned(existing: Record<string, any>, formType: string): Record<string, any> {
  const owned = ENGINE_OWNED_SECTIONS[formType]
  if (!owned) return existing
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(existing)) {
    if (owned.some(p => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}
