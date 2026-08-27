/**
 * Flatten a QuickBooks report into a plain account-name -> amount map.
 *
 * QBO reports are deeply nested (Section > Rows > Row, with Header and
 * Summary rows carrying their own amounts), and the shape varies by report
 * type and by how a company has structured its chart of accounts. Every
 * downstream mapper consumes the FLAT map this produces, so a parsing slip
 * here silently misstates a tax return.
 *
 * Extracted from routes/qbo.ts so it can be tested without loading the
 * Express router and its module-level Supabase client. Pure function: no
 * env, no network, no I/O.
 */
export function flattenReport(report: any): Record<string, number> {
  const result: Record<string, number> = {}
  const walk = (rows: any[], prefix = '') => {
    if (!rows) return
    for (const row of rows) {
      if (row.type === 'Section' && row.group) {
        const sectionName = row.group
        walk(row.Rows?.Row || [], prefix ? `${prefix} > ${sectionName}` : sectionName)
        if (row.Summary?.ColData) {
          const name = prefix ? `${prefix} > ${sectionName}` : sectionName
          const val = parseFloat(row.Summary.ColData[1]?.value || '0')
          if (!isNaN(val)) result[`${name} (Total)`] = val
        }
      } else if (row.type === 'Data' && row.ColData) {
        const name = row.ColData[0]?.value
        const val = parseFloat(row.ColData[1]?.value || '0')
        if (name && !isNaN(val)) {
          result[prefix ? `${prefix} > ${name}` : name] = val
        }
      } else if (row.type === 'Section' && row.Header?.ColData) {
        // Nested sub-Section without a `group`: the Header may carry a direct
        // posting at the parent account (e.g. "Payroll Expenses" header shows
        // $649,509.84 while its children sum to $211K). Without this, the
        // difference is silently dropped from the flattened view.
        const hdrName = row.Header.ColData[0]?.value
        const hdrVal = parseFloat(row.Header.ColData[1]?.value || '')
        if (hdrName && !isNaN(hdrVal) && hdrVal !== 0) {
          const key = prefix ? `${prefix} > ${hdrName} (Direct)` : `${hdrName} (Direct)`
          result[key] = hdrVal
        }
      }
      if (row.Rows?.Row) walk(row.Rows.Row, prefix)
    }
  }
  walk(report?.Rows?.Row || [])
  return result
}
