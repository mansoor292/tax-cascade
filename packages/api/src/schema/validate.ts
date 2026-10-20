/**
 * Every field_values key resolved to the golden schema — or rejected.
 *
 * Owner's rule (2026-10-20): field_values is the golden model, so a key the
 * schema does not know is not stored there. A key resolves when it is a
 * schema key or alias of a form in the return's family, an old descriptive
 * name the alias tables translate (`income.gross_receipts`), or a
 * documented non-box value (data/schema/derived.json: carryforwards,
 * header data). Anything else is rejected: moved out of field_values into
 * computed_data.schema_rejected — kept and reported, never silently dropped,
 * never blocking a compute.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CANONICAL_ALIAS_1120, CANONICAL_ALIAS_1120S, CANONICAL_ALIAS_1040, CANONICAL_ALIAS_1065 } from '../maps/engine_to_pdf.js'
import { SCHEMA_DIR, goldenKey } from './index.js'
import { formOfKey } from './golden.js'

const DESCRIPTIVE: Record<string, Record<string, string>> = { '1120': CANONICAL_ALIAS_1120, '1120S': CANONICAL_ALIAS_1120S, '1040': CANONICAL_ALIAS_1040, '1065': CANONICAL_ALIAS_1065 }

let derivedCache: Set<string> | null = null
export function derivedKeys(): Set<string> {
  if (derivedCache) return derivedCache
  const file = join(SCHEMA_DIR, 'derived.json')
  const d = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { all?: Record<string, string> } : {}
  derivedCache = new Set(Object.keys(d.all ?? {}))
  return derivedCache
}

/** The golden key a stored name stands for, through every alias layer. */
export function resolveKey(formType: string, key: string): { form: string; key: string } | undefined {
  const direct = formOfKey(formType, key)
  if (direct) return { form: direct, key: goldenKey(direct, key) }
  const sectioned = DESCRIPTIVE[formType]?.[key]
  if (sectioned) {
    const f = formOfKey(formType, sectioned)
    if (f) return { form: f, key: goldenKey(f, sectioned) }
  }
  return undefined
}

export type KeyClass = 'golden' | 'derived' | 'rejected'
export function classifyKey(formType: string, key: string): KeyClass {
  if (resolveKey(formType, key)) return 'golden'
  if (derivedKeys().has(key)) return 'derived'
  return 'rejected'
}

/** Split field_values into what the golden model keeps and what it rejects. */
export function splitBySchema<T>(fv: Record<string, T>, formType: string): { kept: Record<string, T>; rejected: Record<string, T> } {
  const kept: Record<string, T> = {}
  const rejected: Record<string, T> = {}
  // a return type the schema does not cover (1065: no engine) is left as is
  if (!['1120', '1120S', '1040'].includes(formType)) return { kept: { ...fv }, rejected }
  for (const [k, v] of Object.entries(fv)) (classifyKey(formType, k) === 'rejected' ? rejected : kept)[k] = v
  return { kept, rejected }
}
