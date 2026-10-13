/**
 * Turn a computed return into something you can read or load somewhere else.
 *
 * `tax_return.field_values` is a flat bag of canonical keys —
 * `schedL.L25_retained_eoy_d`, `deductions.L20_other`. That is the right
 * storage shape and a hostile thing to hand anybody. There was no way at all
 * to get a return's line values out through the API or MCP: you could compute
 * one, validate one and render one to PDF, but the only way to see what was
 * actually ON it was to read the database or parse the rendered form back into
 * text. Every discrepancy found during a filing review this week was found
 * that way.
 *
 * So: one row per populated line, carrying the canonical key (authoritative),
 * the schedule, the IRS line number and column, and the value.
 *
 * Labels are derived from the key rather than looked up in a table of IRS
 * wording. That is deliberate. A wrong label on a tax line is worse than a
 * plain one — the same session mis-remembered which line "other deductions"
 * sits on for an 1120-S and had to check the printed form. The canonical key
 * is the identifier; the label is a convenience and is never authoritative.
 */

export interface ExportLine {
  section: string
  section_label: string
  line: string | null
  column: string | null
  key: string
  label: string
  value: number | string
}

export interface ExportDetail {
  bucket: string
  line: string | null
  label: string
  /** null for a row that itemizes facts rather than an amount — a Schedule O
   *  group member, say — and carries them in `attributes`. */
  value: number | null
  /** Every other field the caller gave the item (Form 1125-E time and stock
   *  percentages, a member's EIN suffix). Absent when there are none. */
  attributes?: Record<string, string | number | boolean>
}

export interface ReturnExport {
  entity: { name: string; form_type: string; ein: string | null }
  return: {
    id: string
    tax_year: number
    form_type: string
    source: string
    status: string
    computed_at: string | null
  }
  lines: ExportLine[]
  details: ExportDetail[]
  k1s: any[]
  line_count: number
}

/**
 * Which IRS line each detail bucket supports. The same knowledge the statement
 * page in build_return_pdf uses — "(attach statement)" lines.
 */
const DETAIL_LINES: Record<string, Record<string, string>> = {
  other_deductions: { '1120S': '20', '1120': '26' },
  other_costs:      { '1120S': '5',  '1120': '5' },   // Form 1125-A
  other_income:     { '1120S': '5',  '1120': '10', '1040': 'Sch 1 8z' },
  // 1120 supporting statements and forms that exist only as itemizations
  officer_compensation: { '1120': '12 (Form 1125-E)', '1120S': '7 (Form 1125-E)' },
  taxes_licenses:       { '1120': '17', '1120S': '12' },
  employee_benefits:    { '1120': '24', '1120S': '18' },
  amortization:         { '1120': 'Form 4562 Part VI', '1120S': 'Form 4562 Part VI' },
  controlled_group:     { '1120': 'Sch K 28 (Schedule O)' },
  schedL_other_current_assets:      { '1120': 'Sch L 6',  '1120S': 'Sch L 6' },
  schedL_other_assets:              { '1120': 'Sch L 14', '1120S': 'Sch L 14' },
  schedL_other_current_liabilities: { '1120': 'Sch L 18', '1120S': 'Sch L 18' },
  taxable_interest:     { '1040': 'Sch B 1' },
  ordinary_dividends:   { '1040': 'Sch B 5' },
  capital_transactions: { '1040': 'Form 8949 / Sch D' },
}

/** Schedules in the order they appear on the return. Unknown ones sort last. */
const SECTION_LABELS: Record<string, string> = {
  meta: 'Entity information',
  income: 'Income',
  cogs: 'Cost of goods sold (Form 1125-A)',
  deductions: 'Deductions',
  tax: 'Tax and payments',
  payments: 'Payments',
  penalty: 'Penalty',
  owed: 'Amount owed',
  overpayment: 'Overpayment',
  refund: 'Refund',
  dep: 'Depreciation (Form 4562)',
  credits: 'Credits',
  sched1: 'Schedule 1 (Form 1040)',
  sched2: 'Schedule 2 (Form 1040)',
  sched3: 'Schedule 3 (Form 1040)',
  schedB: 'Schedule B',
  schedD: 'Schedule D (Form 1040)',
  f8959: 'Form 8959 (Additional Medicare Tax)',
  f8960: 'Form 8960 (Net Investment Income Tax)',
  f8995a: 'Form 8995-A (QBI deduction)',
  schedK: 'Schedule K',
  schedule_k1: 'Schedule K-1',
  schedL: 'Schedule L (balance sheet)',
  schedM1: 'Schedule M-1',
  schedM2: 'Schedule M-2',
  amended: 'Form 1120-X',
  preparer: 'Preparer',
}
const SECTION_ORDER = Object.keys(SECTION_LABELS)

/**
 * Superseded canonical key → the key that replaces it.
 *
 * Several Schedule K lines exist under two spellings: one the engine computes
 * and one the filed-return extractor produces. Only one of each pair is mapped
 * to a PDF field, and the other lingers in field_values holding whatever it
 * was last set to — usually zero. Left in an export they show up as a second
 * entry for the same IRS line with a different number, which is precisely the
 * confusion that had Schedule K line 18 printing 0 against a $1.3M
 * reconciliation and line 5a printing double the dividends.
 *
 * Dropped from the export only when the surviving key is actually present, so
 * a filed import that carries just the extractor's spelling keeps its value.
 * Nothing is deleted from storage — the PDF field map still reads some of
 * these, and the twin-fill in build_return_pdf depends on them being there.
 */
const SUPERSEDED_KEYS: Record<string, string> = {
  'schedK.L18_reconciliation': 'schedK.L18_income_loss',
  'schedK.L7_st_gain': 'schedK.L7_st_capital_gain',
  'schedK.L8a_lt_gain': 'schedK.L8a_lt_capital_gain',
  'schedK.L16a_tax_exempt_int': 'schedK.L16a_tax_exempt_interest',
  'schedK.L11_179': 'schedK.L11_section_179',
  'schedK.L12a_cash_charity': 'schedK.L12a_charitable',
  'schedK.L5a_dividends': 'schedK.L5a_ordinary_dividends',
  'schedK.L5b_qual_div': 'schedK.L5b_qualified_dividends',
  'schedK.L10_other_amount': 'schedK.L10_other_income',
  'schedM1.L1_net_income': 'schedM1.L1_net_income_books',
  'schedM1.L8_income_line18': 'schedM1.L8_income_K18',
}

/**
 * 1040 lines that exist under a year's two spellings (2025 split 7/7a, 11/11b,
 * 12/12e, 13/13a) or under an older alias. Unlike SUPERSEDED_KEYS these are
 * dropped only when they hold nothing the survivor doesn't — a zero, or the
 * same figure — because on a 2024 filed import the unsuffixed key IS the line
 * and its twin is the stray zero.
 */
const TWIN_ZEROS: Record<string, string> = {
  'income.L7_capital_gains': 'income.L7a_capital_gains',
  'income.L11_agi': 'income.L11b_agi',
  'deductions.L12_standard': 'deductions.L12e_standard',
  'deductions.L13_qbi': 'deductions.L13a_qbi',
  'payments.L31_sched3_15': 'payments.L31_sched3',
}

/** Schedule L runs four columns; keep them in the order the form prints them. */
const COLUMN_ORDER = ['boy_a', 'boy_b', 'eoy_c', 'eoy_d', 'a', 'b', 'c']
const COLUMN_RE = /_(boy_a|boy_b|eoy_c|eoy_d)$/
const AMENDED_COLUMN_RE = /_(a|b|c)$/

/** `schedL.L25_retained_eoy_d` → section schedL, line 25, column eoy_d, "retained". */
export function parseCanonicalKey(key: string): Omit<ExportLine, 'value'> {
  const dot = key.indexOf('.')
  const section = dot === -1 ? '' : key.slice(0, dot)
  let rest = dot === -1 ? key : key.slice(dot + 1)

  let line: string | null = null
  const lineMatch = rest.match(/^L(\d{1,2}[a-z]?)_(.*)$/)
  if (lineMatch) {
    line = lineMatch[1]
    rest = lineMatch[2]
  }

  let column: string | null = null
  // Form 1120-X Part I runs columns A (as reported), B (change), C (correct).
  const colMatch = rest.match(section === 'amended' ? AMENDED_COLUMN_RE : COLUMN_RE)
  if (colMatch) {
    column = colMatch[1]
    rest = rest.slice(0, -colMatch[0].length)
  }

  return {
    section,
    section_label: SECTION_LABELS[section] || section || '(unsectioned)',
    line,
    column,
    key,
    label: rest.replace(/_/g, ' ').trim() || key,
  }
}

/** "10b" sorts after "10" and "2a" after "2"; unnumbered lines lead. */
function lineRank(line: string | null): [number, string] {
  if (!line) return [-1, '']
  const m = line.match(/^(\d+)([a-z]?)$/)
  return m ? [parseInt(m[1], 10), m[2]] : [Number.MAX_SAFE_INTEGER, line]
}

function compareLines(a: ExportLine, b: ExportLine): number {
  const sa = SECTION_ORDER.indexOf(a.section)
  const sb = SECTION_ORDER.indexOf(b.section)
  if (sa !== sb) {
    if (sa === -1) return 1
    if (sb === -1) return -1
    return sa - sb
  }
  const [an, al] = lineRank(a.line)
  const [bn, bl] = lineRank(b.line)
  if (an !== bn) return an - bn
  if (al !== bl) return al < bl ? -1 : 1
  const ca = a.column ? COLUMN_ORDER.indexOf(a.column) : -1
  const cb = b.column ? COLUMN_ORDER.indexOf(b.column) : -1
  if (ca !== cb) return ca - cb
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * @param k1s Shareholder K-1 amounts. These are NOT stored on the return —
 *   computed_data holds inputs, field_values, liabilities and citations, and
 *   the K-1s only ever existed in the compute response. The caller re-derives
 *   them from the saved inputs, the same way the K-1 PDF route does. Reading
 *   them off computed_data looks right and silently yields nothing.
 */
export function buildReturnExport(row: any, entity: any, k1s: any[] = []): ReturnExport {
  const fv = (row?.field_values || {}) as Record<string, unknown>

  const lines: ExportLine[] = []
  for (const [key, value] of Object.entries(fv)) {
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'object') continue      // nested payloads are not lines
    const survivor = SUPERSEDED_KEYS[key]
    if (survivor && fv[survivor] !== undefined && fv[survivor] !== null) continue
    const twin = TWIN_ZEROS[key]
    if (twin && fv[twin] !== undefined && fv[twin] !== null && (Number(value) === 0 || value === fv[twin])) continue
    lines.push({ ...parseCanonicalKey(key), value: value as number | string })
  }
  lines.sort(compareLines)

  return {
    entity: {
      name: entity?.name ?? '',
      form_type: entity?.form_type ?? row?.form_type ?? '',
      ein: entity?.ein ?? null,
    },
    return: {
      id: row?.id,
      tax_year: row?.tax_year,
      form_type: row?.form_type,
      source: row?.source,
      status: row?.status,
      computed_at: row?.computed_at ?? null,
    },
    lines,
    details: extractDetails(row),
    k1s: Array.isArray(k1s) ? k1s : [],
    line_count: lines.length,
  }
}

/**
 * Pull the `<bucket>_detail` arrays out of the saved inputs.
 *
 * These are the itemisations behind an "(attach statement)" line — the arrays
 * compute_validation checks sum to the scalar and the statement page prints.
 * They live in input_data, NOT field_values, so an export built only from
 * field_values shows the line as a single figure and the breakdown exists
 * nowhere the API can reach. Line 20 came back as one number, 283,661, and the
 * only itemisation was a spreadsheet somebody had built by hand.
 */
function extractDetails(row: any): ExportDetail[] {
  const inputs = (row?.input_data || {}) as Record<string, unknown>
  const formType = String(row?.form_type || '')
  const out: ExportDetail[] = []

  for (const [key, value] of Object.entries(inputs)) {
    if (!key.endsWith('_detail') || !Array.isArray(value)) continue
    const bucket = key.slice(0, -'_detail'.length)
    const line = DETAIL_LINES[bucket]?.[formType] ?? null
    for (const item of value) {
      if (Array.isArray(item)) {
        const amt = Number(item[1])
        if (isFinite(amt)) out.push({ bucket, line, label: String(item[0] ?? ''), value: amt })
        continue
      }
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, any>
      // A broker sale carries proceeds and basis, not an amount.
      const amt = o.amount === undefined && o.value === undefined && o.proceeds !== undefined
        ? Number(o.proceeds) - Number(o.basis ?? 0) + Number(o.adjustment ?? 0)
        : parseFloat(String(o.amount ?? o.value ?? ''))
      const attributes: Record<string, string | number | boolean> = {}
      for (const [k, v] of Object.entries(o)) {
        if (DETAIL_CORE_FIELDS.has(k)) continue
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attributes[k] = v
      }
      const hasAttrs = Object.keys(attributes).length > 0
      // Without an amount the row is only worth keeping for what it describes.
      if (!isFinite(amt) && !hasAttrs) continue
      out.push({
        bucket, line,
        label: String(o.label ?? o.description ?? o.name ?? ''),
        value: isFinite(amt) ? Math.round(amt * 100) / 100 : null,
        ...(hasAttrs ? { attributes } : {}),
      })
    }
  }
  // A 1040's K-1 portfolio income is a Schedule B payer like any 1099. Without
  // these rows the payer list stops short of line 2 / line 6 by the K-1 amount.
  const k1 = inputs.k1_portfolio as Record<string, any> | undefined
  if (formType === '1040' && k1 && typeof k1 === 'object') {
    const name = String(k1.name || 'Schedule K-1')
    const interest = Number(k1.interest), dividends = Number(k1.ordinary_dividends)
    if (interest) out.push({ bucket: 'taxable_interest', line: DETAIL_LINES.taxable_interest['1040'], label: name, value: interest })
    if (dividends) out.push({ bucket: 'ordinary_dividends', line: DETAIL_LINES.ordinary_dividends['1040'], label: name, value: dividends })
  }
  return out
}

/** Fields extractDetails already reads into label/value; the rest are attributes. */
const DETAIL_CORE_FIELDS = new Set([
  'label', 'description', 'name', 'amount', 'value', 'proceeds', 'basis', 'adjustment',
])

/** RFC 4180: quote anything containing a comma, quote or newline; double the quotes. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportToCsv(exp: ReturnExport): string {
  const rows: string[] = []
  rows.push(['entity', 'tax_year', 'form_type', 'source', 'section', 'line', 'column', 'canonical_key', 'label', 'value'].join(','))
  for (const l of exp.lines) {
    rows.push([
      exp.entity.name, exp.return.tax_year, exp.return.form_type, exp.return.source,
      l.section_label, l.line ?? '', l.column ?? '', l.key, l.label, l.value,
    ].map(csvCell).join(','))
  }
  // The itemisation behind an "(attach statement)" line. Without these the CSV
  // repeats the single rolled-up figure and the breakdown is lost.
  for (const d of exp.details) {
    rows.push([
      exp.entity.name, exp.return.tax_year, exp.return.form_type, exp.return.source,
      `Detail: ${d.bucket.replace(/_/g, ' ')}`, d.line ?? '', '',
      `${d.bucket}_detail`,
      d.attributes
        ? `${d.label} (${Object.entries(d.attributes).map(([k, v]) => `${k}: ${v}`).join('; ')})`
        : d.label,
      d.value ?? '',
    ].map(csvCell).join(','))
  }

  // K-1s carry per-shareholder amounts that are not field_values lines, so
  // they would vanish from a CSV built only from the form. Append them with
  // the shareholder in the line column.
  for (const k1 of exp.k1s) {
    for (const [field, value] of Object.entries(k1)) {
      if (value === null || value === undefined || typeof value === 'object') continue
      if (field === 'name') continue
      rows.push([
        exp.entity.name, exp.return.tax_year, exp.return.form_type, exp.return.source,
        'Schedule K-1', '', k1.name ?? '', `k1.${field}`, String(field).replace(/_/g, ' '), value,
      ].map(csvCell).join(','))
    }
  }
  return rows.join('\n') + '\n'
}
