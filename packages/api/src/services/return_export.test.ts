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
    // Twin spellings of the same Schedule K lines — the second of each pair
    // is superseded and must not appear as a second entry for that line.
    'schedK.L18_income_loss': 1_302_595,
    'schedK.L18_reconciliation': 0,
    'schedK.L7_st_capital_gain': 148,
    'schedK.L7_st_gain': 0,
    'schedK.L5a_ordinary_dividends': 511,
    'schedK.L5a_dividends': 1_022,
    'nested.payload': { ignored: true },
    'blank.value': null,
  },
  computed_data: { inputs: {}, field_values: {}, citations: [] },
}

/** K-1s are passed in by the caller — they are not stored on the return. */
const K1S = [{ name: 'Mansoor Razzaq', pct: 100, ordinary_income: 1_268_993, w2_wages: 120_000 }]

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
  const exp = buildReturnExport(row, entity, K1S)

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
  const csv = exportToCsv(buildReturnExport(row, entity, K1S))
  const rows = csv.trim().split('\n')

  it('writes a header and one row per line', () => {
    expect(rows[0]).toBe('entity,tax_year,form_type,source,section,line,column,canonical_key,label,value')
    expect(rows.some(r => r.includes('schedL.L25_retained_eoy_d,retained,423717'))).toBe(true)
  })

  it('exports no K-1 rows when the caller supplies none', () => {
    // The old code read row.computed_data.k1s, which is never populated —
    // it looked correct and silently produced nothing.
    expect(exportToCsv(buildReturnExport(row, entity))).not.toContain('k1.')
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

describe('superseded Schedule K twins', () => {
  it('exports one entry per line, keeping the surviving spelling', () => {
    const exp = buildReturnExport(row, entity, K1S)
    const keys = exp.lines.map(l => l.key)

    for (const gone of ['schedK.L18_reconciliation', 'schedK.L7_st_gain', 'schedK.L5a_dividends']) {
      expect(keys, `${gone} is superseded and should not be exported`).not.toContain(gone)
    }
    for (const kept of ['schedK.L18_income_loss', 'schedK.L7_st_capital_gain', 'schedK.L5a_ordinary_dividends']) {
      expect(keys).toContain(kept)
    }

    // One line 18, not two saying different things.
    expect(exp.lines.filter(l => l.section === 'schedK' && l.line === '18')).toHaveLength(1)
    expect(exp.lines.find(l => l.section === 'schedK' && l.line === '18')!.value).toBe(1_302_595)
    expect(exp.lines.find(l => l.section === 'schedK' && l.line === '5a')!.value).toBe(511)
  })

  it('keeps the superseded spelling when nothing replaces it', () => {
    // A filed import carries the extractor's spelling and no engine key.
    // Dropping it there would lose the only value for that line.
    const extracted = { ...row, field_values: { 'schedK.L18_reconciliation': 987_654 } }
    const keys = buildReturnExport(extracted, entity).lines.map(l => l.key)
    expect(keys).toContain('schedK.L18_reconciliation')
  })
})

describe('itemisation behind an "(attach statement)" line', () => {
  /**
   * The detail arrays live in input_data, not field_values, so an export built
   * only from field_values showed line 20 as a single 283,661 and the
   * breakdown existed nowhere the API could reach.
   */
  const withDetail = {
    ...row,
    input_data: {
      other_deductions: 283_661,
      other_deductions_detail: [
        { label: 'Contract labor', amount: 120_000 },
        { label: 'Internet and telecommunications', amount: 40_297 },
        { label: 'Legal and accounting services', amount: -10_500 },
      ],
    },
  }

  it('exports each item against the line it supports', () => {
    const exp = buildReturnExport(withDetail, entity, K1S)
    expect(exp.details).toHaveLength(3)
    expect(exp.details[0]).toMatchObject({
      bucket: 'other_deductions', line: '20', label: 'Contract labor', value: 120_000,
    })
    // A credit in the itemisation stays a credit.
    expect(exp.details.find(d => d.label.startsWith('Legal'))!.value).toBe(-10_500)
  })

  it('knows the line differs by form — 20 on an 1120-S, 26 on an 1120', () => {
    const asC = buildReturnExport({ ...withDetail, form_type: '1120' }, entity)
    expect(asC.details[0].line).toBe('26')
  })

  it('writes the items into the CSV under the rolled-up line', () => {
    const csv = exportToCsv(buildReturnExport(withDetail, entity, K1S))
    expect(csv).toContain('Detail: other deductions')
    expect(csv).toContain('Contract labor')
    expect(csv).toContain('-10500')
    // The rolled-up figure is still there; the detail sits alongside it.
    expect(csv).toContain('deductions.L20_other')
  })

  it('has no details when the return carries only the scalar', () => {
    expect(buildReturnExport(row, entity).details).toHaveLength(0)
  })
})
