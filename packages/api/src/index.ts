/**
 * Tax API — Core Modules
 *
 * Architecture:
 *   Intake (fuzzy) → Canonical Model (structured) → Engine (compute) → PDF (deterministic)
 *
 * Directory structure:
 *   src/engine/     — tax computation (tax_engine.ts, tax_tables.ts)
 *   src/intake/     — OCR/textract → canonical model (json_model_mapper.ts)
 *   src/maps/       — canonical key → PDF field ID maps (per year, per form)
 *   src/builders/   — PDF fill + package assembly
 *   data/field_maps/ — Textract-verified field map JSONs
 *   data/irs_forms/  — blank IRS PDF forms (2020-2025)
 */

// Engine
export { calc1120, calc1120S, calc1040, calcCascade } from './engine/tax_engine.js'
export { ordinaryTax, ltcgTax, niitTax, qbiDeduction, standardDeduction, seTax, TAX_TABLES } from './engine/tax_tables.js'

// Intake
export { mapToCanonical, mergeResults } from './intake/json_model_mapper.js'
export type { TextractOutput, GeminiOutput, QBOReport, MappingResult } from './intake/json_model_mapper.js'
