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

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../../data/field_maps')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

interface FieldEntry {
  page: number
  field_id: string
  label: string
}

// Cache loaded maps
const cache: Record<string, FieldEntry[]> = {}

/**
 * Invalidate a cached field map so it reloads on next access.
 */
export function invalidateCache(formYear: string) {
  delete cache[formYear]
}

/**
 * Load all field maps from Supabase into cache on startup.
 * This ensures discovered forms (not in git) are available via the sync path.
 */
export async function seedCacheFromSupabase() {
  try {
    const { data } = await supabase.from('field_map')
      .select('form_name, tax_year, page, field_id, label')
      .eq('verified', true)
      .order('form_name').order('tax_year').order('page').order('field_id')
    if (!data?.length) return

    // Group by form_name + tax_year
    const groups: Record<string, FieldEntry[]> = {}
    for (const row of data) {
      const key = `${row.form_name}_${row.tax_year}`
      if (!groups[key]) groups[key] = []
      groups[key].push({ page: row.page, field_id: row.field_id, label: row.label })
    }

    // Only cache entries that don't already have a JSON file
    let seeded = 0
    for (const [key, entries] of Object.entries(groups)) {
      const jsonPath = join(DATA_DIR, `${key}_fields.json`)
      if (!existsSync(jsonPath) && !cache[key]?.length) {
        cache[key] = entries
        seeded++
      }
    }
    if (seeded > 0) console.log(`  Field maps: seeded ${seeded} from Supabase (not in JSON)`)
  } catch (e: any) {
    console.error('Failed to seed field maps from Supabase:', e.message)
  }
}

async function loadMapFromSupabase(formName: string, year: number): Promise<FieldEntry[]> {
  const { data } = await supabase.from('field_map')
    .select('page, field_id, label')
    .eq('form_name', formName)
    .eq('tax_year', year)
    .order('page')
    .order('field_id')
  return (data as FieldEntry[]) || []
}

function loadMap(formYear: string): FieldEntry[] {
  if (!cache[formYear]) {
    const jsonPath = join(DATA_DIR, `${formYear}_fields.json`)
    if (existsSync(jsonPath)) {
      try {
        const raw = readFileSync(jsonPath, 'utf-8')
        cache[formYear] = JSON.parse(raw)
      } catch {
        cache[formYear] = []
      }
    } else {
      // Will try Supabase fallback via async path
      cache[formYear] = []
    }
  }
  return cache[formYear]
}

/**
 * Load field map with Supabase fallback if JSON file is missing.
 */
async function loadMapAsync(formYear: string): Promise<FieldEntry[]> {
  if (cache[formYear]?.length) return cache[formYear]

  const jsonPath = join(DATA_DIR, `${formYear}_fields.json`)
  if (existsSync(jsonPath)) {
    try {
      const raw = readFileSync(jsonPath, 'utf-8')
      cache[formYear] = JSON.parse(raw)
      return cache[formYear]
    } catch {}
  }

  // Supabase fallback — parse "formName_year" from formYear
  const match = formYear.match(/^(.+)_(\d+)$/)
  if (match) {
    const entries = await loadMapFromSupabase(match[1], parseInt(match[2]))
    if (entries.length) {
      cache[formYear] = entries
      return entries
    }
  }

  cache[formYear] = []
  return []
}

/**
 * Get all Textract-verified field mappings for a form+year.
 * Returns array of { page, field_id, label } entries.
 */
export function getFieldMap(form: string, year: number): FieldEntry[] {
  return loadMap(`${form}_${year}`)
}

/**
 * Async version with Supabase fallback for discovered forms.
 */
export async function getFieldMapAsync(form: string, year: number): Promise<FieldEntry[]> {
  return loadMapAsync(`${form}_${year}`)
}

/**
 * Check if a field map exists (JSON file or in cache).
 */
export function hasFieldMap(form: string, year: number): boolean {
  const key = `${form}_${year}`
  if (cache[key]?.length) return true
  return existsSync(join(DATA_DIR, `${key}_fields.json`))
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

export type FormType = string
export type TaxYear = number

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

export const FORM_INVENTORY: Record<string, { name: string; years: number[]; maps: number[] }> = {
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
  f4562:    { name: 'Form 4562',    years: [2024,2025], maps: [2024,2025] },
  f1120sg:  { name: 'Schedule G',   years: [2024,2025], maps: [] },
  f1120sk1: { name: 'Schedule K-1', years: [2024,2025], maps: [2025] },

  // Asset acquisition
  f8594:    { name: 'Form 8594',    years: [2025], maps: [2025] },

  // Passive activity loss limitation
  f8582:    { name: 'Form 8582',    years: [2025], maps: [2025] },

  // Extension forms
  f4868:    { name: 'Form 4868',    years: [2025], maps: [2025] },
  f7004:    { name: 'Form 7004',    years: [2025], maps: [2025] },
  f8868:    { name: 'Form 8868',    years: [2025], maps: [2025] },
}

/**
 * Register a newly discovered form+year in the inventory.
 * Called by the discovery pipeline after a successful map is saved.
 */
export function registerDiscoveredForm(formName: string, year: number, displayName?: string) {
  if (!FORM_INVENTORY[formName]) {
    FORM_INVENTORY[formName] = { name: displayName || formName, years: [year], maps: [year] }
  } else {
    if (!FORM_INVENTORY[formName].years.includes(year)) {
      FORM_INVENTORY[formName].years.push(year)
      FORM_INVENTORY[formName].years.sort()
    }
    if (!FORM_INVENTORY[formName].maps.includes(year)) {
      FORM_INVENTORY[formName].maps.push(year)
      FORM_INVENTORY[formName].maps.sort()
    }
  }
  invalidateCache(`${formName}_${year}`)
}
