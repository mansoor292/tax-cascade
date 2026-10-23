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
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '30589',
}

/** Distinct sentinels so a value on the wrong line is unmistakable. */
const INCOME_1120S: Record<string, number> = {
  'income.L1a_gross_receipts': 8_415_974,
  'income.L1c_balance': 8_415_974,
  'income.L2_cogs': 2_138_410,
  'income.L3_gross_profit': 6_060_111,
  'income.L5_other_income': 6_143_075,
  'income.L6_total_income': 12_357_228,
  'deductions.L8_salaries': 9_922_394,
  'deductions.L12_taxes': 1_115_032,
  'deductions.L20_other': 2_138_432,
  'deductions.L21_total': 13_744_295,
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
      [/Cost of goods sold/, 2_138_410],
      [/Gross profit\./, 6_060_111],
      [/Salaries and wages/, 9_922_394],
      [/Taxes and licenses/, 1_115_032],
      [/Other deductions \(attach statement\)/, 2_138_432],
      [/Total deductions\./, 13_744_295],
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
      'income.L1a_w2_wages': 900_601,
      'income.L2b_taxable_int': 2_138_659,
      'income.L3b_ord_dividends': 3_595_157,
      'income.L9_total_income': 11_049_497,
      'income.L11_agi': 1_015_497,
      'tax.L15_taxable_income': 1_480_464,
    }
    for (const year of [2023, 2024]) {
      const { text, formYear } = await render('1040', year, INCOME_1040)
      expect(formYear, `${year} should render on its own form`).toBe(year)
      for (const [label, value] of [
        [/Total amount from Form\(s\) W-2/, 900_601],
        [/b Taxable interest/, 2_138_659],
        [/b Ordinary dividends/, 3_595_157],
        [/This is your total income/, 11_049_497],
        [/This is your adjusted gross income/, 1_015_497],
        [/This is your taxable income/, 1_480_464],
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
      'income.L11_agi': 0, 'income.L11b_agi': 5_361_430,
      'deductions.L12_standard': 0, 'deductions.L12e_standard': 27_700,
      'deductions.L13_qbi': 0, 'deductions.L13a_qbi': 398_058,
    })
    expect(lineRow(text, /This is your adjusted gross income/)).toContain('5,361,430')
    expect(lineRow(text, /Standard deduction or itemized/)).toContain('27,700')
    expect(lineRow(text, /Qualified business income deduction/)).toContain('398,058')
  })

  it('puts every 1040 money line on its own line, 2022 through 2025', async () => {
    // The sweep that caught three separate map defects: F1040_2023 was the
    // 2024 map, there was no 2022 map at all, and tax.L16_income_tax pointed
    // at the "Check if any from Form(s): 3 ___" write-in box in EVERY year, so
    // the income tax printed there and line 16 stayed blank. The 2025 form
    // also splits AGI across the page break (11a page 1, 11b page 2) and
    // renumbers the standard deduction to 12e; neither was mapped, so both
    // printed nowhere on the year currently being filed.
    const CASES: Array<[string, number, RegExp]> = [
      ['income.L1a_w2_wages',       1_010_000, /Total amount from Form\(s\) W-2/],
      ['income.L1z_total_wages',    1_020_000, /Add lines 1a through 1h/],
      ['income.L2a_tax_exempt_int', 1_030_000, /Tax-exempt interest/],
      ['income.L2b_taxable_int',    1_040_000, /b Taxable interest/],
      ['income.L3a_qual_dividends', 1_050_000, /Qualified dividends/],
      ['income.L3b_ord_dividends',  1_060_000, /b Ordinary dividends/],
      ['income.L4a_ira',            1_070_000, /IRA distributions/],
      ['income.L5a_pensions',       1_080_000, /Pensions and annuities/],
      ['income.L6a_social_sec',     1_090_000, /Social security benefits/],
      ['income.L7_capital_gains',   1_100_000, /Capital gain or \(loss\)/],
      ['income.L9_total_income',    1_110_000, /This is your total income/],
      ['income.L10_adjustments',    1_120_000, /Adjustments to income/],
      ['income.L11_agi',            1_130_000, /adjusted gross income/],
      ['deductions.L12_standard',   1_140_000, /Standard deduction or itemized/],
      ['deductions.L13_qbi',        1_150_000, /Qualified business income deduction/],
      ['deductions.L14_total',      1_160_000, /Add lines 12(e)?[, ].*13/],
      ['tax.L15_taxable_income',    1_170_000, /This is your taxable income/],
      ['tax.L16_income_tax',        1_180_000, /\b16\s+Tax \(see instructions\)/],
      ['tax.L17_sched2',            1_190_000, /Amount from Schedule 2, line 3/],
      ['tax.L18_add_16_17',         1_200_000, /Add lines 16 and 17/],
      ['tax.L24_total_tax',         1_210_000, /This is your total tax/],
    ]
    const fv: Record<string, number> = {}
    for (const [k, v] of CASES) fv[k] = v

    for (const year of [2022, 2023, 2024, 2025]) {
      const { text, formYear } = await render('1040', year, fv)
      expect(formYear, `${year} should render on its own form`).toBe(year)
      for (const [key, value, label] of CASES) {
        const row = lineRow(text, label)
        expect(row, `${year}: no row matched ${label} (for ${key})`).not.toBe('')
        expect(row, `${year}: ${key} (${value.toLocaleString()}) is not on its line`)
          .toContain(value.toLocaleString())
      }
    }
  })

  it('prints whole dollars, never cents or float residue', async () => {
    // QuickBooks carries cents and the 80%-of-taxable-income NOL limit leaves
    // binary-float residue, so the 1120 printed taxable income with cents
    // ("67,901.2") and an NOL deduction as "279,412.80000000005".
    const { text } = await render('1120', 2024, {
      'tax.L30_taxable_income': 67_901.19999999995,
      'tax.L29a_nol': 279_412.80000000005,
      'income.L11_total_income': 1_707_510.47,
    })
    expect(text).not.toMatch(/\d,\d{3}\.\d/)
    expect(lineRow(text, /This is your taxable income|Taxable income\. Subtract/)).toContain('67,901')
    expect(text).toContain('279,413')
    expect(text).toContain('1,707,510')
  })

  it('puts the 2025 1120-S header, line 1c and title where they belong', async () => {
    // Line 1c and total assets had no mapping and printed blank; the officer's
    // title went to f1_54, which on the 2025 form is the direct-deposit routing
    // number, so a filing copy showed "PRESIDENT" as the refund bank.
    const res = await buildReturnPdf({
      formType: '1120S', taxYear: 2025,
      entity: { ...entity, meta: { title: 'PRESIDENT' } },
      fieldValues: {
        'income.L1a_gross_receipts': 2_555_456, 'income.L1c_balance': 2_555_456,
        'meta.total_assets': 2_415_445,
      },
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'yearpair-'))
    try {
      const file = path.join(dir, 'r.pdf')
      writeFileSync(file, await res.pdf.save())
      const text = execFileSync('pdftotext', ['-layout', '-f', '1', '-l', '1', file, '-'], { encoding: 'utf8' })
      expect(text).toMatch(/c Balance\s+1c\s+2,555,456/)
      expect(lineRow(text, /Total assets/)).toContain('2,415,445')
      // Single physical lines: lineRow would run on from 28c into the signature
      // block, which has no line number to stop it.
      const line = (re: RegExp) => text.split('\n').find(l => re.test(l)) ?? ''
      expect(line(/Routing number/).replace(/\s+/g, '')).not.toContain('PRESIDENT')
      expect(line(/Signature of officer/)).toContain('PRESIDENT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders every year we hold a blank for without scrambling it', async () => {
    // The whole span on disk. Each must either render coherently or not at all
    // — never a filled page with values on the wrong lines.
    for (const year of [2020, 2021, 2022, 2023, 2024, 2025]) {
      const { text, formYear } = await render('1120S', year, INCOME_1120S)
      const row = lineRow(text, /Taxes and licenses/)
      expect(row, `${year}: taxes landed off its line (rendered on ${formYear})`)
        .toContain((1_115_032).toLocaleString())
    }
  })
})
