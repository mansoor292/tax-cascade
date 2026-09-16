/**
 * Getting the figures OFF a return had no route at all — computing, validating
 * and rendering to PDF were the only things you could do with one. These pin
 * the shaping: the canonical key stays authoritative, the line and column come
 * out of it correctly, and the rows arrive in the order the form prints them.
 */
import { describe, it, expect } from 'vitest'
import { buildReturnExport, exportToCsv, parseCanonicalKey } from './return_export.js'

const entity = { name: 'Edgewater Test Inc', form_type: '1120S', ein: '00-0000000' }

const row = {
  id: 'r-1', tax_year: 2025, form_type: '1120S', source: 'proforma',
  status: 'computed', computed_at: '2026-09-16T00:00:00Z',
  field_values: {
    'schedL.L25_retained_eoy_d': 423_717,
    'schedL.L1_cash_boy_b': 292_999,
    'schedL.L1_cash_eoy_d': 520_571,
    'schedL.L10b_dep_eoy_d': 131_745,
    'schedL.L2a_trade_boy_a': 0,
    'deductions.L20_other': 283_661,
    'deductions.L7_officer_comp': 120_000,
    'income.L1a_gross_receipts': 2_922_791,
    'tax.L22_ordinary_income': 1_268_993,
    'meta.entity_name': 'Edgewater Test Inc',
    'schedM2.L8_end_balance': 423_747,
    'nested.payload': { ignored: true },
    'blank.value': null,
  },
  computed_data: {
    k1s: [{ name: 'Mansoor Razzaq', pct: 100, ordinary_income: 1_268_993, w2_wages: 120_000 }],
  },
}

describe('parseCanonicalKey', () => {
  it('splits section, line and Schedule L column', () => {
    expect(parseCanonicalKey('schedL.L25_retained_eoy_d')).toMatchObject({
      section: 'schedL', section_label: 'Schedule L (balance sheet)',
      line: '25', column: 'eoy_d', label: 'retained',
    })
  })

  it('keeps a lettered line number whole', () => {
    expect(parseCanonicalKey('income.L1a_gross_receipts')).toMatchObject({
      section: 'income', line: '1a', column: null, label: 'gross receipts',
    })
    expect(parseCanonicalKey('schedL.L10b_dep_boy_b')).toMatchObject({ line: '10b', column: 'boy_b' })
  })

  it('handles a key with no line number', () => {
    expect(parseCanonicalKey('meta.entity_name')).toMatchObject({
      section: 'meta', line: null, column: null, label: 'entity name',
    })
  })
})

describe('buildReturnExport', () => {
  const exp = buildReturnExport(row, entity)

  it('drops nested payloads and empty values, keeping a real zero', () => {
    const keys = exp.lines.map(l => l.key)
    expect(keys).not.toContain('nested.payload')
    expect(keys).not.toContain('blank.value')
    // A zero is a reported figure on a tax form, not an absence.
    expect(keys).toContain('schedL.L2a_trade_boy_a')
  })

  it('orders by schedule, then line, then column as the form prints them', () => {
    const order = exp.lines.map(l => l.key)
    const at = (k: string) => order.indexOf(k)
    expect(at('meta.entity_name')).toBeLessThan(at('income.L1a_gross_receipts'))
    expect(at('income.L1a_gross_receipts')).toBeLessThan(at('deductions.L7_officer_comp'))
    expect(at('deductions.L7_officer_comp')).toBeLessThan(at('deductions.L20_other'))
    expect(at('deductions.L20_other')).toBeLessThan(at('tax.L22_ordinary_income'))
    expect(at('tax.L22_ordinary_income')).toBeLessThan(at('schedL.L1_cash_boy_b'))
    expect(at('schedL.L1_cash_boy_b')).toBeLessThan(at('schedL.L1_cash_eoy_d'))
    expect(at('schedL.L1_cash_eoy_d')).toBeLessThan(at('schedL.L10b_dep_eoy_d'))
    expect(at('schedL.L10b_dep_eoy_d')).toBeLessThan(at('schedL.L25_retained_eoy_d'))
    expect(at('schedL.L25_retained_eoy_d')).toBeLessThan(at('schedM2.L8_end_balance'))
  })

  it('carries the return and entity header', () => {
    expect(exp.return).toMatchObject({ tax_year: 2025, form_type: '1120S', source: 'proforma' })
    expect(exp.entity.name).toBe('Edgewater Test Inc')
    expect(exp.line_count).toBe(exp.lines.length)
  })
})

describe('exportToCsv', () => {
  const csv = exportToCsv(buildReturnExport(row, entity))
  const rows = csv.trim().split('\n')

  it('writes a header and one row per line', () => {
    expect(rows[0]).toBe('entity,tax_year,form_type,source,section,line,column,canonical_key,label,value')
    expect(rows.some(r => r.includes('schedL.L25_retained_eoy_d,retained,423717'))).toBe(true)
  })

  it('appends K-1 amounts, which are not field_values lines', () => {
    expect(csv).toContain('k1.ordinary_income')
    expect(csv).toContain('Mansoor Razzaq')
    // The shareholder's name is not itself an amount.
    expect(csv).not.toContain('k1.name')
  })

  it('quotes a value containing a comma so the columns survive', () => {
    const withComma = exportToCsv(buildReturnExport(
      { ...row, field_values: { 'meta.entity_name': 'Acme, Inc' } }, entity))
    expect(withComma).toContain('"Acme, Inc"')

    // Split the way a CSV reader does, not on every comma — the point is that
    // the embedded comma stays inside its field.
    const fields = (line: string): string[] => {
      const out: string[] = []
      let cur = '', quoted = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (quoted) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
          else if (c === '"') quoted = false
          else cur += c
        } else if (c === '"') quoted = true
        else if (c === ',') { out.push(cur); cur = '' }
        else cur += c
      }
      out.push(cur)
      return out
    }
    const [header, dataRow] = withComma.trim().split('\n')
    expect(fields(dataRow)).toHaveLength(fields(header).length)
    expect(fields(dataRow).at(-1)).toBe('Acme, Inc')
  })
})
