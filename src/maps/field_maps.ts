/**
 * PDF Field Maps — Textract-Verified
 *
 * Every field_id → form_label mapping was confirmed by:
 *   1. Printing each field's ID into the blank PDF
 *   2. Sending the labeled PDF to AWS Textract
 *   3. Textract reported which form label each field ID occupied
 *
 * Maps are stored as JSON in data/field_maps/ and loaded here.
 * This module provides a clean API for looking up field IDs by
 * canonical key, form type, and tax year.
 *
 * NO fuzzy logic on output. Lookup is deterministic.
 */

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../../data/field_maps')

interface FieldEntry {
  page: number
  field_id: string
  label: string
}

// Cache loaded maps
const cache: Record<string, FieldEntry[]> = {}

function loadMap(formYear: string): FieldEntry[] {
  if (!cache[formYear]) {
    try {
      const raw = readFileSync(join(DATA_DIR, `${formYear}_fields.json`), 'utf-8')
      cache[formYear] = JSON.parse(raw)
    } catch {
      cache[formYear] = []
    }
  }
  return cache[formYear]
}

/**
 * Get all Textract-verified field mappings for a form+year.
 * Returns array of { page, field_id, label } entries.
 */
export function getFieldMap(form: string, year: number): FieldEntry[] {
  return loadMap(`${form}_${year}`)
}

/**
 * Find the field_id for a given line by matching the label text.
 * Uses exact substring match — no fuzzy logic.
 */
export function findFieldByLabel(form: string, year: number, labelMatch: string): string | undefined {
  const map = getFieldMap(form, year)
  const lower = labelMatch.toLowerCase()
  const entry = map.find(e => e.label.toLowerCase().includes(lower))
  return entry?.field_id
}

/**
 * List all available form+year combinations.
 */
export function listAvailableMaps(): string[] {
  return readdirSync(DATA_DIR)
    .filter((f: string) => f.endsWith('_fields.json'))
    .map((f: string) => f.replace('_fields.json', ''))
}

// ═══════════════════════════════════════════════════════════════
// CANONICAL KEY → FIELD ID MAPS
// These are the structured output maps — deterministic, no fuzzy.
// One per form type per year.
// ═══════════════════════════════════════════════════════════════

export type FormType = '1040' | '1120' | '1120S'
export type TaxYear = 2024 | 2025

/**
 * Get the canonical → field_id map for a form+year.
 * Returns a Record<canonicalKey, fieldId>.
 *
 * These maps are maintained in the per-year map files
 * (pdf_field_map_2024.ts, pdf_field_map_2025.ts) and
 * re-exported here for convenience.
 */
/**
 * Get canonical → field_id map from the JSON field maps.
 * This loads the Textract-verified JSON and returns a label → field_id lookup.
 */
export function getCanonicalMap(form: string, year: number): Record<string, string> {
  const map = getFieldMap(form, year)
  const result: Record<string, string> = {}
  for (const entry of map) {
    result[entry.label] = entry.field_id
  }
  return result
}

// ═══════════════════════════════════════════════════════════════
// SUPPORTED FORMS INVENTORY
// ═══════════════════════════════════════════════════════════════

export const FORM_INVENTORY = {
  // Main returns
  f1040:    { name: 'Form 1040',    years: [2020,2021,2022,2023,2024,2025], maps: [2024,2025] },
  f1120:    { name: 'Form 1120',    years: [2020,2021,2022,2023,2024,2025], maps: [2024,2025] },
  f1120s:   { name: 'Form 1120-S',  years: [2020,2021,2022,2023,2024,2025], maps: [2024,2025] },

  // 1040 supporting schedules
  f1040s1:  { name: 'Schedule 1',   years: [2024,2025], maps: [2025] },
  f1040s2:  { name: 'Schedule 2',   years: [2024,2025], maps: [2025] },
  f1040s3:  { name: 'Schedule 3',   years: [2024,2025], maps: [2025] },
  f1040sb:  { name: 'Schedule B',   years: [2024,2025], maps: [2025] },
  f1040sd:  { name: 'Schedule D',   years: [2024,2025], maps: [2025] },
  f1040se:  { name: 'Schedule E',   years: [2024,2025], maps: [2025] },
  f1040x:   { name: 'Form 1040-X',  years: [2024,2025], maps: [] },

  // 1040 supporting forms
  f8959:    { name: 'Form 8959',    years: [2024,2025], maps: [2025] },
  f8960:    { name: 'Form 8960',    years: [2024,2025], maps: [2025] },
  f8995a:   { name: 'Form 8995-A',  years: [2024,2025], maps: [2025] },
  f7203:    { name: 'Form 7203',    years: [2025],      maps: [2025] },

  // Business supporting forms
  f1125a:   { name: 'Form 1125-A',  years: [2024,2025], maps: [2025] },
  f1125e:   { name: 'Form 1125-E',  years: [2024,2025], maps: [] },
  f4562:    { name: 'Form 4562',    years: [2024,2025], maps: [] },
  f1120sg:  { name: 'Schedule G',   years: [2024,2025], maps: [] },
  f1120sk1: { name: 'Schedule K-1', years: [2024,2025], maps: [2025] },
} as const
