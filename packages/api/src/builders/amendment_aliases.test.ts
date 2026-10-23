/**
 * An amended return must print the amended figures, not a mix.
 *
 * `tax_return.field_values` on an amendment carries a line twice: the engine's
 * new figure under the IRS-line key (`deductions.L20_other`) and the number
 * copied from the filed import it amends under the descriptive key
 * (`deductions.other_deductions`). buildModel wrote both into the PDF model in
 * one loop, so whichever came later in object key order reached the page.
 *
 * The 2023 1120-S rendered with amended gross receipts (8,270,033) against
 * filed cost of goods sold (1,670,000), amended total income (4,776,743)
 * against filed total deductions (1,936,521), and an ordinary income line
 * belonging to neither return. The page did not foot against itself: 1c less
 * line 2 came to 6,353,277 while line 3 printed 4,744,163. A CPA keying from
 * it would have filed numbers that exist in no return.
 *
 * The figures below are that row's, so the test fails against the bug.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildReturnPdf } from './build_return_pdf.js'

const entity = {
  name: 'Alias Collision Inc', ein: '00-0000000',
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '30589',
}

/** Amended (IRS-line keys) beside filed (descriptive keys), as stored. */
const AMENDED_2023: Record<string, number> = {
  'income.L1a_gross_receipts': 8_270_033,  'income.gross_receipts': 8_895_990,
  'income.L1c_balance': 8_270_033,
  'income.L2_cogs': 3_068_961,             'income.cost_of_goods_sold': 1_670_000,
  'income.L3_gross_profit': 4_744_163,     'income.gross_profit': 5_123_790,
  'income.L5_other_income': 25_127,        'income.other_income': 52_084,
  'income.L6_total_income': 4_776_743,     'income.total_income': 5_175_874,
  'deductions.L7_officer_comp': 0,         'deductions.officer_compensation': 60_000,
  'deductions.L8_salaries': 796_117,     'deductions.salaries_wages': 813_718,
  'deductions.L12_taxes': 31_286,          'deductions.taxes_licenses': 54_520,
  'deductions.L16_advertising': 0,         'deductions.advertising': 600_000,
  'deductions.L20_other': 0,               'deductions.other_deductions': 377_959,
  'deductions.L21_total': 987_253,       'deductions.total_deductions': 1_936_521,
  'tax.L22_ordinary_income': 3_438_024,    'deductions.ordinary_income_loss': 3_239_353,
}

/** Only the descriptive spelling — how a filed import arrives. */
const FILED_ONLY: Record<string, number> = {
  'income.gross_receipts': 8_895_990,
  'income.total_income': 5_175_874,
  'deductions.other_deductions': 377_959,
  'deductions.total_deductions': 1_936_521,
}

async function renderText(fieldValues: Record<string, number>): Promise<string> {
  const { pdf } = await buildReturnPdf({
    formType: '1120S', taxYear: 2025, entity, fieldValues,
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'alias-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await pdf.save())
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('descriptive aliases on an amended return', () => {
  it('prints the amended figure, never the filed one it sits beside', async () => {
    const text = await renderText(AMENDED_2023)

    // Every filed figure that has an amended twin must be absent from the page.
    for (const [label, filed] of [
      ['cost of goods sold', 1_670_000],
      ['salaries and wages', 813_718],
      ['taxes and licenses', 54_520],
      ['other deductions', 377_959],
      ['total deductions', 1_936_521],
      ['gross receipts', 8_895_990],
      ['gross profit', 5_123_790],
      ['total income', 5_175_874],
      ['advertising', 600_000],
      ['officer compensation', 60_000],
      ['ordinary business income', 3_239_353],
    ] as Array<[string, number]>) {
      expect(text, `filed ${label} (${filed.toLocaleString()}) reached an amended return`)
        .not.toContain(filed.toLocaleString())
    }

    // And the amended ones are actually there.
    for (const amended of [3_068_961, 796_117, 31_286, 987_253, 4_776_743]) {
      expect(text, `amended ${amended.toLocaleString()} missing`)
        .toContain(amended.toLocaleString())
    }
  })

  it('still fills a line that only the descriptive key states', async () => {
    // A filed import carries no IRS-line keys; the alias is how it reaches the
    // form at all, so the guard must not lock those rows out.
    const text = await renderText(FILED_ONLY)
    for (const v of [8_895_990, 5_175_874, 377_959, 1_936_521]) {
      expect(text, `${v.toLocaleString()} did not reach the form`).toContain(v.toLocaleString())
    }
  })

  it('treats a canonical zero as an answer, not an absence', async () => {
    // The amendment zeroes advertising and other deductions. Zero is the
    // amended figure; the filed amount beside it is stale.
    const text = await renderText({
      'deductions.L16_advertising': 0, 'deductions.advertising': 600_000,
      'deductions.L20_other': 0, 'deductions.other_deductions': 377_959,
    })
    expect(text).not.toContain('600,000')
    expect(text).not.toContain('377,959')
  })
})
