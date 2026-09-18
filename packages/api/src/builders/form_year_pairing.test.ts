/**
 * The blank form and the field map must come from the same year.
 *
 * They used to resolve independently, each with its own [year, 2025, 2024]
 * fallback. Blank PDFs go back to 2020; typed maps only to 2023 (2022 for the
 * 1120). So a 2022 1120-S and every 1040 before 2023 loaded that year's blank
 * and filled it with another year's field IDs. Widget numbering moves between
 * years, so the values landed on the wrong lines — and the builder reported a
 * healthy `filled` count, so nothing anywhere said so. A CPA reading the page
 * sees a plausible return whose figures are on lines they do not belong to.
 *
 * A year substitution is still allowed, because rendering on a neighbouring
 * year's form beats refusing outright — but it must be the WHOLE pair, and it
 * must be reported.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildReturnPdf } from './build_return_pdf.js'

const entity = {
  name: 'Year Pairing Inc', ein: '00-0000000',
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '33301',
}

/** Distinct sentinels so a value on the wrong line is unmistakable. */
const INCOME_1120S: Record<string, number> = {
  'income.L1a_gross_receipts': 7_010_001,
  'income.L1c_balance': 7_010_001,
  'income.L2_cogs': 2_020_002,
  'income.L3_gross_profit': 4_989_999,
  'income.L5_other_income': 5_050_005,
  'income.L6_total_income': 10_040_004,
  'deductions.L8_salaries': 8_080_008,
  'deductions.L12_taxes': 1_212_012,
  'deductions.L20_other': 2_020_020,
  'deductions.L21_total': 11_312_040,
}

async function render(formType: string, taxYear: number, fieldValues: Record<string, number>) {
  const res = await buildReturnPdf({ formType, taxYear, entity, fieldValues })
  const dir = mkdtempSync(path.join(tmpdir(), 'yearpair-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await res.pdf.save())
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    return { text, formYear: res.formYear, filled: res.filled }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The rendered block for one form line: its label row plus anything before the
 * next labelled row. `pdftotext -layout` pushes a value onto a following line
 * when the rotated section label ("Deductions") shares the row, so line 8's
 * amount does not sit on line 8's text row.
 */
function lineRow(text: string, label: RegExp): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => label.test(l))
  if (start === -1) return ''
  const isLabelled = (l: string) => /^\s*\d{1,2}[a-z]?\s+[A-Z]/.test(l)
  let end = start + 1
  while (end < lines.length && !isLabelled(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

describe('form year pairing', () => {
  it('reports the year it actually rendered on', async () => {
    // 2023 has both a blank and a map for the 1120-S — no substitution.
    const exact = await render('1120S', 2023, INCOME_1120S)
    expect(exact.formYear).toBe(2023)

    // 2022 has a blank but NO 1120-S map. The pair must move together, so the
    // reported year is not 2022 and the caller can see that.
    const substituted = await render('1120S', 2022, INCOME_1120S)
    expect(substituted.formYear).not.toBe(2022)
    expect(substituted.filled).toBeGreaterThan(0)
  })

  it('puts each value on its own line for a year with no map of its own', async () => {
    const { text } = await render('1120S', 2022, INCOME_1120S)

    // Each sentinel must appear on the row carrying its own line label. If the
    // map and the blank disagree, the value lands on a neighbouring row and
    // these fail.
    for (const [label, value] of [
      [/Cost of goods sold/, 2_020_002],
      [/Gross profit\./, 4_989_999],
      [/Salaries and wages/, 8_080_008],
      [/Taxes and licenses/, 1_212_012],
      [/Other deductions \(attach statement\)/, 2_020_020],
      [/Total deductions\./, 11_312_040],
    ] as Array<[RegExp, number]>) {
      const row = lineRow(text, label)
      expect(row, `no row matched ${label}`).not.toBe('')
      expect(row, `${value.toLocaleString()} is not on the ${label} line`)
        .toContain(value.toLocaleString())
    }
  })

  it('puts 1040 income on its own lines in 2023 and 2024', async () => {
    // F1040_2023 was the 2024 map under another name. Page 1 of the 2023 form
    // sits one widget earlier throughout, so wages printed in the tax-exempt
    // interest box and total income printed on line 10 "Adjustments to income".
    // Distinct sentinels per line; each must land on its own.
    const INCOME_1040: Record<string, number> = {
      'income.L1a_w2_wages': 1_010_101,
      'income.L2b_taxable_int': 2_020_202,
      'income.L3b_ord_dividends': 3_030_303,
      'income.L9_total_income': 9_090_909,
      'income.L11_agi': 1_111_111,
      'tax.L15_taxable_income': 1_515_151,
    }
    for (const year of [2023, 2024]) {
      const { text, formYear } = await render('1040', year, INCOME_1040)
      expect(formYear, `${year} should render on its own form`).toBe(year)
      for (const [label, value] of [
        [/Total amount from Form\(s\) W-2/, 1_010_101],
        [/b Taxable interest/, 2_020_202],
        [/b Ordinary dividends/, 3_030_303],
        [/This is your total income/, 9_090_909],
        [/This is your adjusted gross income/, 1_111_111],
        [/This is your taxable income/, 1_515_151],
      ] as Array<[RegExp, number]>) {
        const row = lineRow(text, label)
        expect(row, `${year}: no row matched ${label}`).not.toBe('')
        expect(row, `${year}: ${value.toLocaleString()} is not on the ${label} line`)
          .toContain(value.toLocaleString())
      }
    }
  })

  it('fills 1040 lines the extractor spells with a sub-letter', async () => {
    // The row stores 11b/12e/13a; the map carries 11/12/13. Only the map's
    // spelling was filled, and it held zero — AGI, the standard deduction and
    // the QBI deduction all printed 0 beneath a line 14 showing their sum.
    const { text } = await render('1040', 2023, {
      'income.L11_agi': 0, 'income.L11b_agi': 4_444_444,
      'deductions.L12_standard': 0, 'deductions.L12e_standard': 27_700,
      'deductions.L13_qbi': 0, 'deductions.L13a_qbi': 501_393,
    })
    expect(lineRow(text, /This is your adjusted gross income/)).toContain('4,444,444')
    expect(lineRow(text, /Standard deduction or itemized/)).toContain('27,700')
    expect(lineRow(text, /Qualified business income deduction/)).toContain('501,393')
  })

  it('renders every year we hold a blank for without scrambling it', async () => {
    // The whole span on disk. Each must either render coherently or not at all
    // — never a filled page with values on the wrong lines.
    for (const year of [2020, 2021, 2022, 2023, 2024, 2025]) {
      const { text, formYear } = await render('1120S', year, INCOME_1120S)
      const row = lineRow(text, /Taxes and licenses/)
      expect(row, `${year}: taxes landed off its line (rendered on ${formYear})`)
        .toContain((1_212_012).toLocaleString())
    }
  })
})
