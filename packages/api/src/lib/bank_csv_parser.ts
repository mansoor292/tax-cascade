/**
 * Minimal bank CSV parser
 *
 * Heuristic column detection — no per-bank hardcoded parsers. Works for
 * ~95% of US bank CSV exports because they all have the same three things:
 * a date column, an amount (or debit/credit pair) column, and a
 * description/payee column. The detector looks at the header row for
 * keyword matches.
 *
 * Returns canonical `BankTxn` rows plus a list of issues when columns
 * couldn't be mapped, so the caller can fall back to a Gemini parse
 * for weird formats instead of failing silently.
 */

export interface BankTxn {
  date: string           // ISO YYYY-MM-DD
  amount: number         // signed: positive = credit/deposit, negative = debit/withdrawal
  description: string
  raw: Record<string, string>
}

export interface ParseResult {
  rows: BankTxn[]
  format_detected: 'chase_like' | 'boa_like' | 'split_debit_credit' | 'generic_signed' | 'unknown'
  issues: string[]
}

// Column-role keyword matches — lowercased regex OR strings, ORed.
const ROLE_HINTS: Record<string, RegExp[]> = {
  date:        [/^post(ed|ing)?[ _-]?date/, /^transaction[ _-]?date/, /^date$/, /^trans[ _-]?date/, /^as[ _-]?of[ _-]?date/],
  amount:      [/^amount$/, /^amt$/, /^transaction[ _-]?amount/, /^signed[ _-]?amount/],
  debit:       [/^debit/, /^withdrawal/, /^payment/, /^money[ _-]?out/],
  credit:      [/^credit/, /^deposit/, /^money[ _-]?in/],
  description: [/^descript/, /^payee/, /^memo/, /^details?$/, /^narrative/, /^transaction$/, /^reference/],
}

/** Parse a single CSV row respecting quoted fields with commas/quotes inside. */
function parseCsvRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (c === ',' && !inQuote) {
      cells.push(cur); cur = ''
    } else {
      cur += c
    }
  }
  cells.push(cur)
  return cells.map(s => s.trim())
}

/** Try to parse a date string into YYYY-MM-DD. Accepts MM/DD/YYYY, YYYY-MM-DD, etc. */
function normalizeDate(s: string): string | null {
  if (!s) return null
  const trimmed = s.trim().replace(/"/g, '')
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  // US MM/DD/YYYY or M/D/YY
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (us) {
    const [, mm, dd, yy] = us
    const year = yy.length === 2 ? (parseInt(yy) >= 70 ? '19' + yy : '20' + yy) : yy
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }
  // DD/MM/YYYY (European)
  // We don't guess — US-only heuristic. Weirder formats go to issues.
  const d = new Date(trimmed)
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return null
}

/** Parse a numeric cell, handling parens for negatives, currency symbols, commas. */
function parseAmount(s: string): number | null {
  if (s === undefined || s === null || s === '') return null
  const raw = String(s).trim().replace(/[\$€£,]/g, '').replace(/"/g, '')
  if (raw === '') return null
  // Parentheses = negative (accounting convention)
  if (/^\(.+\)$/.test(raw)) {
    const n = parseFloat(raw.slice(1, -1))
    return isNaN(n) ? null : -n
  }
  const n = parseFloat(raw)
  return isNaN(n) ? null : n
}

export function parseBankCsv(csvText: string): ParseResult {
  const issues: string[] = []
  const lines = csvText.split(/\r?\n/).map(l => l).filter(l => l.trim() !== '')
  if (lines.length < 2) {
    return { rows: [], format_detected: 'unknown', issues: ['CSV has fewer than 2 non-empty rows — nothing to parse'] }
  }

  // Scan forward up to 5 rows to find the header. Bank CSVs sometimes
  // have a preamble (e.g. "Account: 1234\n\nPosting Date,Description,...")
  let headerIdx = -1
  let headerCells: string[] = []
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const cells = parseCsvRow(lines[i])
    const lower = cells.map(c => c.toLowerCase())
    const hasDate = lower.some(c => ROLE_HINTS.date.some(r => r.test(c)))
    const hasMoney = lower.some(c => ROLE_HINTS.amount.some(r => r.test(c))
      || ROLE_HINTS.debit.some(r => r.test(c))
      || ROLE_HINTS.credit.some(r => r.test(c)))
    const hasDesc = lower.some(c => ROLE_HINTS.description.some(r => r.test(c)))
    if (hasDate && hasMoney && hasDesc) {
      headerIdx = i
      headerCells = cells
      break
    }
  }
  if (headerIdx === -1) {
    return { rows: [], format_detected: 'unknown', issues: ['Could not detect a header row with date/amount/description columns in the first 5 lines'] }
  }

  // Map each column index to a role.
  const roleOfCol: Array<'date' | 'amount' | 'debit' | 'credit' | 'description' | null> = headerCells.map(h => {
    const lower = h.toLowerCase()
    for (const [role, patterns] of Object.entries(ROLE_HINTS)) {
      if (patterns.some(r => r.test(lower))) return role as any
    }
    return null
  })

  const dateCol = roleOfCol.indexOf('date')
  const amountCol = roleOfCol.indexOf('amount')
  const debitCol = roleOfCol.indexOf('debit')
  const creditCol = roleOfCol.indexOf('credit')
  const descCol = roleOfCol.indexOf('description')

  let format: ParseResult['format_detected'] = 'unknown'
  if (amountCol >= 0) format = descCol >= 0 && headerCells[descCol].toLowerCase().includes('description') ? 'chase_like' : 'generic_signed'
  else if (debitCol >= 0 && creditCol >= 0) format = 'split_debit_credit'
  if (/payee/i.test(headerCells[descCol] || '')) format = 'boa_like'

  const rows: BankTxn[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i])
    if (cells.every(c => !c)) continue
    const rawMap: Record<string, string> = {}
    for (let j = 0; j < headerCells.length; j++) rawMap[headerCells[j]] = cells[j] ?? ''

    const date = dateCol >= 0 ? normalizeDate(cells[dateCol] ?? '') : null
    let amount: number | null = null
    if (amountCol >= 0) {
      amount = parseAmount(cells[amountCol] ?? '')
    } else if (debitCol >= 0 || creditCol >= 0) {
      const dr = debitCol >= 0 ? parseAmount(cells[debitCol] ?? '') : null
      const cr = creditCol >= 0 ? parseAmount(cells[creditCol] ?? '') : null
      // Debit reduces bank balance (negative); credit increases (positive).
      if (dr && dr > 0) amount = -dr
      else if (cr && cr > 0) amount = cr
      else if (dr && dr < 0) amount = dr
      else if (cr && cr < 0) amount = cr
    }
    const description = descCol >= 0 ? String(cells[descCol] ?? '').trim() : ''

    if (!date || amount === null) {
      issues.push(`Row ${i}: could not parse date or amount (date="${cells[dateCol]}", amount cells="${[amountCol, debitCol, creditCol].filter(c => c >= 0).map(c => cells[c]).join('|')}")`)
      continue
    }
    rows.push({ date, amount, description, raw: rawMap })
  }

  return { rows, format_detected: format, issues }
}
