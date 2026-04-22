/**
 * Gemini gap-fill for canonical tax field values.
 *
 * Flow:
 *   1. Textract produces KV pairs and tables from the filed return PDF.
 *   2. Regex/table mapper fills whatever canonical keys match its rules
 *      (see json_model_mapper.ts).
 *   3. This helper computes the DELTA between what the engine/field-map
 *      expects for the form type and what the mapper actually produced,
 *      then asks Gemini to fill the gaps using the same KV pairs as
 *      grounding — no image, no second PDF parse.
 *
 * The call is cheap: ~50KB text payload, one round-trip, bounded
 * output (only the missing canonical keys).
 */
import { GoogleGenerativeAI } from '@google/generative-ai'
import * as maps2024 from '../maps/pdf_field_map_2024.js'
import * as maps2025 from '../maps/pdf_field_map_2025.js'

export interface GapFillInput {
  textractKvs: Array<{ key: string; value: string }>
  formType: string           // '1120', '1120S', '1040'
  taxYear:  number
  currentFieldValues: Record<string, any>
}

export interface GapFillResult {
  filled:       Record<string, number>
  gaps_total:   number
  gaps_filled:  number
  model:        string
  error?:       string
}

const EXPECTED_KEY_CACHE: Record<string, string[]> = {}

/**
 * Union of canonical keys we consider "expected" for a given form+year.
 * Drawn from the Textract-verified PDF field maps (pdf_field_map_YYYY.ts),
 * which is the authoritative list of lines that exist on the physical form.
 */
function getExpectedCanonicalKeys(formType: string, year: number): string[] {
  const cacheKey = `${formType}_${year}`
  if (EXPECTED_KEY_CACHE[cacheKey]) return EXPECTED_KEY_CACHE[cacheKey]

  const base = `F${formType.replace('-', '').toUpperCase()}`
  // Try exact year first, then fall back to 2025 and 2024 maps (Schedule L
  // and most lines are stable across years).
  const candidates = [
    (maps2025 as any)[`${base}_${year}`],
    (maps2024 as any)[`${base}_${year}`],
    (maps2025 as any)[`${base}_2025`],
    (maps2024 as any)[`${base}_2024`],
  ].filter(m => m && Object.keys(m).length > 0)

  const keys = candidates.length ? Object.keys(candidates[0]) : []
  // Drop meta/preparer keys — they're not what we care about for gap-fill
  // (entity name, address, preparer info come from elsewhere).
  const taxKeys = keys.filter(k => !k.startsWith('meta.') && !k.startsWith('preparer.'))
  EXPECTED_KEY_CACHE[cacheKey] = taxKeys
  return taxKeys
}

/**
 * Generate a plain-English description of a canonical key so Gemini can
 * map it back to the right Textract KV. We stay close to the canonical
 * key spelling so the model can ground on substring matches.
 */
function describeCanonicalKey(key: string): string {
  const sectionNames: Record<string, string> = {
    income:     'Income (page 1)',
    deductions: 'Deductions (page 1)',
    cogs:       'Form 1125-A Cost of Goods Sold',
    tax:        'Tax computation (page 1)',
    credits:    'Credits',
    payments:   'Payments & refundable credits (page 1)',
    refund:     'Refund',
    owed:       'Balance due',
    result:     'Final result (1040)',
    schedJ:     'Schedule J (tax computation)',
    schedL:     'Schedule L (balance sheet)',
    schedM1:    'Schedule M-1 (book-to-tax reconciliation)',
    schedM2:    'Schedule M-2 (retained earnings / accumulated adj)',
    schedK:     'Schedule K',
    schedB:     'Schedule B',
  }
  const [section, rest] = key.split('.', 2)
  const sectionLabel = sectionNames[section] || section
  if (!rest) return sectionLabel

  // Parse "L<n><sub?>_<descriptor>" into "line <n><sub> (descriptor)"
  const m = rest.match(/^L([0-9]+)([a-c]?)_(.+)$/)
  if (m) {
    const [, n, sub, descriptor] = m
    const line = `line ${n}${sub}`
    const desc = descriptor
      .replace(/_boy_a$/, ' — Beginning of year, column (a) gross')
      .replace(/_boy_b$/, ' — Beginning of year, column (b) net')
      .replace(/_eoy_c$/, ' — End of year, column (c) gross')
      .replace(/_eoy_d$/, ' — End of year, column (d) net')
      .replace(/_/g, ' ')
    return `${sectionLabel} ${line}: ${desc}`
  }
  // Schedule J pattern "J1a_income_tax"
  const jm = rest.match(/^J([0-9]+[a-c]?)_(.+)$/)
  if (jm) return `${sectionLabel} line ${jm[1]}: ${jm[2].replace(/_/g, ' ')}`
  return `${sectionLabel} ${rest.replace(/_/g, ' ')}`
}

/**
 * Call Gemini with the raw KV pairs and a list of canonical keys to fill.
 * Returns a map of filled canonical keys → numeric values.
 */
export async function gapFillWithGemini(input: GapFillInput): Promise<GapFillResult> {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) {
    return { filled: {}, gaps_total: 0, gaps_filled: 0, model: '', error: 'GEMINI_API_KEY not set' }
  }

  const expected = getExpectedCanonicalKeys(input.formType, input.taxYear)
  const have = new Set(
    Object.entries(input.currentFieldValues)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k]) => k)
  )
  const gaps = expected.filter(k => !have.has(k))

  if (gaps.length === 0) {
    return { filled: {}, gaps_total: 0, gaps_filled: 0, model: '' }
  }

  // Keep only numeric-ish KVs (values with at least one digit) to keep the
  // prompt compact. Entity-metadata pairs and page headers aren't useful for
  // numeric gap-fill.
  const numericKvs = input.textractKvs
    .filter(kv => kv && kv.value && /[0-9]/.test(String(kv.value)))
    .slice(0, 600)

  const prompt = `You are filling numeric gaps in a tax return extraction for IRS Form ${input.formType} (tax year ${input.taxYear}).

The following key-value pairs were extracted from the filed return PDF by AWS Textract. Each is a label-value pair from somewhere on the form:

${numericKvs.map(kv => `${JSON.stringify(kv.key)} => ${JSON.stringify(kv.value)}`).join('\n')}

Regex-based mapping already filled many canonical keys. Your job is to find the values for the remaining lines listed below. Every line is an IRS form field identified by a canonical key.

LINES TO FILL:
${gaps.map(k => `  ${k} — ${describeCanonicalKey(k)}`).join('\n')}

Respond with ONLY a valid JSON object mapping canonical key to numeric value. No markdown, no prose, no code fences.

Rules:
- Whole-dollar integers only. Strip $, commas, periods, "USD".
- Parenthesized values are negative: "(1,500.)" → -1500.
- If the matching line on the form is blank/empty, use 0.
- If you genuinely cannot find the value in the KVs above, OMIT the key — do not guess.
- Schedule L columns: column (a) and (c) are GROSS amounts on "gross-with-less"
  lines (2a, 10a, 13a) — the net flows to the following sub-line (2b, 10b, 13b)
  in columns (b) and (d). Most other lines have values only in columns (b) and (d).

Output format:
{"deductions.L22_advertising": 1226, "schedL.L1_cash_boy_b": 847391}`

  const genAI = new GoogleGenerativeAI(GEMINI_KEY)
  const modelName = 'gemini-3.1-flash-lite-preview'
  const model = genAI.getGenerativeModel({ model: modelName })

  try {
    const result = await model.generateContent([{ text: prompt }])
    const raw = result.response.text().trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
    const parsed = JSON.parse(raw)

    const filled: Record<string, number> = {}
    const gapSet = new Set(gaps)
    for (const [k, v] of Object.entries(parsed)) {
      if (!gapSet.has(k)) continue    // ignore any keys Gemini invented
      if (typeof v === 'number' && !isNaN(v)) {
        filled[k] = Math.round(v)
      } else if (typeof v === 'string') {
        const n = parseFloat(v.replace(/[$,]/g, '').replace(/\((.+)\)/, '-$1'))
        if (!isNaN(n)) filled[k] = Math.round(n)
      }
    }

    return {
      filled,
      gaps_total:  gaps.length,
      gaps_filled: Object.keys(filled).length,
      model:       modelName,
    }
  } catch (e: any) {
    return { filled: {}, gaps_total: gaps.length, gaps_filled: 0, model: modelName, error: e.message }
  }
}
