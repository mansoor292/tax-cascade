/**
 * Strict amount recognition for the catalog.
 *
 * Not intake's parseDollar: that one is lenient on purpose (it rounds to whole
 * dollars and reads "12/31/2021" as 12), which is right for mapping a Textract
 * key-value onto a known numeric line and wrong here. The catalog must decide
 * from the printed text alone whether a token IS an amount — a date, an EIN, a
 * business code or a ZIP must stay text — and must keep cents, because
 * statements and worksheets print them.
 */

const AMOUNT_RE = /^\(?-?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*\)?\.?-?$/

export function isAmount(raw: string): boolean {
  const s = raw.trim()
  if (!s || !/\d/.test(s)) return false
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return false
  return AMOUNT_RE.test(s)
}

/** Parse a printed amount: "1,061,424." → 1061424, "(3,000)" → -3000,
 *  "-560." → -560, "8,825.44" → 8825.44, "1,234-" (trailing minus) → -1234. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim()
  if (!isAmount(s)) return null
  const negative = /^\(.*\)\.?$/.test(s) || /^-/.test(s) || /-$/.test(s) || /^\$\s*-/.test(s)
  const digits = s.replace(/[()$\s,-]/g, '').replace(/\.$/, '')
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}
