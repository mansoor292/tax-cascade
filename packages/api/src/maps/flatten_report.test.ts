/**
 * flattenReport is the first thing every QBO number passes through. If it
 * mis-parses a row, a tax return is wrong and nothing downstream can tell.
 *
 * The hand-built cases below pin the contract. The last block runs the real
 * captured report structure (amounts synthesised — see
 * scripts/extract_qbo_fixture.ts) to make sure real-world nesting still
 * parses.
 */
import { describe, it, expect } from 'vitest'
import { flattenReport } from './flatten_report.js'
import pnlFixture from './__fixtures__/qbo_pnl.json' with { type: 'json' }
import bsFixture from './__fixtures__/qbo_balance_sheet.json' with { type: 'json' }

const data = (name: string, value: string) => ({ type: 'Data', ColData: [{ value: name }, { value }] })

describe('flattenReport', () => {
  it('reads a flat list of Data rows', () => {
    const out = flattenReport({ Rows: { Row: [data('Advertising', '1200.50'), data('Rent', '3000')] } })
    expect(out).toEqual({ Advertising: 1200.5, Rent: 3000 })
  })

  it('prefixes nested sections with " > " so leaves keep their path', () => {
    const out = flattenReport({
      Rows: { Row: [{
        type: 'Section', group: 'Expenses',
        Rows: { Row: [data('Advertising', '100')] },
      }] },
    })
    expect(out['Expenses > Advertising']).toBe(100)
  })

  it('records a section subtotal as "(Total)" rather than as a leaf', () => {
    const out = flattenReport({
      Rows: { Row: [{
        type: 'Section', group: 'Expenses',
        Rows: { Row: [data('Advertising', '100'), data('Rent', '200')] },
        Summary: { ColData: [{ value: 'Total Expenses' }, { value: '300' }] },
      }] },
    })
    // The subtotal must be distinguishable from a real account, or the
    // mapper double-counts the whole section.
    expect(out['Expenses (Total)']).toBe(300)
    expect(out['Expenses > Advertising']).toBe(100)
  })

  it('captures a posting made at a section header as "(Direct)"', () => {
    // Real case this was written for: a payroll journal entry posted to the
    // parent "Payroll Expenses" account while its children summed to less.
    // Without this the difference vanished silently.
    const out = flattenReport({
      Rows: { Row: [{
        type: 'Section',
        Header: { ColData: [{ value: 'Payroll Expenses' }, { value: '649509.84' }] },
        Rows: { Row: [data('Wages', '211000')] },
      }] },
    })
    expect(out['Payroll Expenses (Direct)']).toBe(649509.84)
    expect(out['Wages']).toBe(211000)
  })

  it('ignores a zero-valued header rather than inventing a (Direct) entry', () => {
    const out = flattenReport({
      Rows: { Row: [{
        type: 'Section',
        Header: { ColData: [{ value: 'Payroll Expenses' }, { value: '0' }] },
        Rows: { Row: [data('Wages', '100')] },
      }] },
    })
    expect(out['Payroll Expenses (Direct)']).toBeUndefined()
  })

  it('handles deep nesting at any depth', () => {
    const out = flattenReport({
      Rows: { Row: [{
        type: 'Section', group: 'Expenses',
        Rows: { Row: [{
          type: 'Section', group: 'Insurance',
          Rows: { Row: [data('Business Insurance', '4200')] },
        }] },
      }] },
    })
    expect(out['Expenses > Insurance > Business Insurance']).toBe(4200)
  })

  it('skips non-numeric and empty amounts instead of writing NaN', () => {
    const out = flattenReport({
      Rows: { Row: [data('Broken', 'n/a'), data('Empty', ''), data('Good', '5')] },
    })
    expect(out.Broken).toBeUndefined()
    expect(out.Good).toBe(5)
    expect(Object.values(out).every(v => !Number.isNaN(v))).toBe(true)
  })

  it('returns an empty map for a malformed or empty report', () => {
    expect(flattenReport(undefined)).toEqual({})
    expect(flattenReport({})).toEqual({})
    expect(flattenReport({ Rows: {} })).toEqual({})
  })

  describe('against real captured report structure', () => {
    it('parses a real profit-and-loss into a usable flat map', () => {
      const out = flattenReport((pnlFixture as any).raw_data)
      expect(Object.keys(out).length).toBeGreaterThan(20)
      expect(Object.values(out).every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true)
      // A real P&L must yield both income and expense leaves.
      expect(Object.keys(out).some(k => k.startsWith('Income'))).toBe(true)
      expect(Object.keys(out).some(k => k.startsWith('Expenses'))).toBe(true)
      // And the section totals the mapper relies on.
      expect(Object.keys(out).some(k => k.endsWith(' (Total)'))).toBe(true)
    })

    it('parses a real balance sheet', () => {
      const out = flattenReport((bsFixture as any).raw_data)
      expect(Object.keys(out).length).toBeGreaterThan(20)
      expect(Object.values(out).every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true)
    })
  })
})
