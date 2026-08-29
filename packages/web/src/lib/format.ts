/**
 * Shared display formatting. These existed as per-file copies (the money
 * formatter alone had nine) that drifted; new code imports from here instead
 * of redefining them.
 */

/**
 * `$1,234` / `-$1,234`. Strings pass through as text; null/undefined/NaN
 * render as `emptyText` (some surfaces show '' there, others '—').
 */
export function fmtMoney(n: unknown, emptyText = ''): string {
  if (typeof n === 'number' && !isNaN(n)) {
    return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
  }
  if (n === null || n === undefined || typeof n === 'number') return emptyText
  return String(n)
}

/** Compact stat-tile variant: `$1.2k`, `$150k`; `—` for non-numbers. */
export function fmtMoneyCompact(n: number | undefined | null): string {
  if (typeof n !== 'number' || isNaN(n)) return '—'
  const abs = Math.abs(n)
  const formatted = abs >= 1000
    ? `$${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`
    : `$${abs.toLocaleString()}`
  return n < 0 ? `-${formatted}` : formatted
}

/** Signed difference: `+$500` / `-$500`; `zeroText` for 0 or non-numbers. */
export function fmtDelta(n: number | null | undefined, zeroText = '—'): string {
  if (typeof n !== 'number' || n === 0) return zeroText
  const abs = Math.abs(n).toLocaleString()
  return n > 0 ? `+$${abs}` : `-$${abs}`
}

/**
 * Render an ISO `YYYY-MM-DD` date without timezone drift: parsing it via
 * `new Date(iso)` treats it as UTC midnight, which toLocaleDateString then
 * shifts a day back for viewers west of Greenwich. Pin both ends to UTC.
 */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

/**
 * Form inputs arrive as strings; the API expects numbers where they parse.
 * Non-numeric values (names, SSNs with dashes) pass through unchanged —
 * dropping them loses required fields.
 */
export function coerceNumericInputs(
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputs)) {
    const num = Number(v)
    out[k] = isNaN(num) ? v : num
  }
  return out
}
