/**
 * Schedule L values must land on the line they belong to.
 *
 * The 1120-S map was written by copying the 1120's field sequence, which put
 * every row one line too high: other current assets printed on line 5 "Tax-
 * exempt securities", the total-assets figure printed on line 14, and line 15
 * "Total assets" came out BLANK — a filed 1120-S showing total assets of 0
 * against real liabilities. The equity lines were wrong for a second reason:
 * the 1120 splits capital stock (22a/22b) and retained earnings (24/25) where
 * the 1120-S has one of each, so retained earnings printed on the
 * "Adjustments to shareholders' equity" line.
 *
 * Nothing catches that except reading the rendered page, so this renders it.
 * Every line gets a distinct sentinel value and is asserted to appear on its
 * own row.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildReturnPdf } from './build_return_pdf.js'

const entity = {
  name: 'Schedule L Placement Inc', ein: '00-0000000',
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '33301',
}

/** A balance sheet that foots on both sides, with a unique value per line. */
const SCHED_L: Record<string, number> = {
  'schedL.L1_cash_boy_b': 111_001,            'schedL.L1_cash_eoy_d': 111_002,
  'schedL.L3_inv_boy_b': 222_001,             'schedL.L3_inv_eoy_d': 222_002,
  'schedL.L5_taxexempt_boy_b': 333_001,       'schedL.L5_taxexempt_eoy_d': 333_002,
  'schedL.L6_othercurr_boy_b': 444_001,       'schedL.L6_othercurr_eoy_d': 444_002,
  'schedL.L10a_bldg_boy_a': 555_001,          'schedL.L10a_bldg_eoy_c': 555_002,
  'schedL.L10b_dep_boy_a': 55_555,            'schedL.L10b_dep_eoy_c': 55_556,
  'schedL.L10b_dep_boy_b': 500_000,           'schedL.L10b_dep_eoy_d': 500_000,
  'schedL.L12_land_boy_b': 666_001,           'schedL.L12_land_eoy_d': 666_002,
  'schedL.L14_other_boy_b': 777_001,          'schedL.L14_other_eoy_d': 777_002,
  'schedL.L15_total_boy_b': 3_053_006,        'schedL.L15_total_eoy_d': 3_053_012,

  'schedL.L16_ap_boy_b': 11_001,              'schedL.L16_ap_eoy_d': 11_002,
  'schedL.L17_mortshort_boy_b': 22_001,       'schedL.L17_mortshort_eoy_d': 22_002,
  'schedL.L18_othercurrliab_boy_b': 2_591_998, 'schedL.L18_othercurrliab_eoy_d': 2_591_996,
  'schedL.L19_loansfrom_boy_b': 44_001,       'schedL.L19_loansfrom_eoy_d': 44_002,
  'schedL.L20_mortlong_boy_b': 55_001,        'schedL.L20_mortlong_eoy_d': 55_002,
  'schedL.L21_otherliab_boy_b': 66_001,       'schedL.L21_otherliab_eoy_d': 66_002,
  'schedL.L22b_common_boy_b': 77_001,         'schedL.L22b_common_eoy_d': 77_002,
  'schedL.L23_paidin_boy_b': 88_001,          'schedL.L23_paidin_eoy_d': 88_002,
  'schedL.L25_retained_boy_b': 99_001,        'schedL.L25_retained_eoy_d': 99_002,
  'schedL.L26_adj_boy_b': 1_001,              'schedL.L26_adj_eoy_d': 1_002,
  'schedL.L27_treasury_boy_b': 2_001,         'schedL.L27_treasury_eoy_d': 2_002,
  'schedL.L28_total_boy_b': 3_053_006,        'schedL.L28_total_eoy_d': 3_053_012,
}

async function renderText(formType: string, year: number, fieldValues: Record<string, number>): Promise<string> {
  const { pdf } = await buildReturnPdf({ formType, taxYear: year, entity, fieldValues })
  const dir = mkdtempSync(path.join(tmpdir(), 'render-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await pdf.save())
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function renderScheduleL(formType: string, year: number): Promise<string[]> {
  const { pdf } = await buildReturnPdf({
    formType, taxYear: year, entity, fieldValues: SCHED_L,
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'schedl-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await pdf.save())
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    const start = text.indexOf('Balance Sheets per Books')
    expect(start, 'no Schedule L in the rendered return').toBeGreaterThan(-1)
    return text.slice(start).split('\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The line number printed at the start of whichever row carries `value`.
 *
 * Matching has to respect digit boundaries: a plain substring search finds
 * "11,001" inside "111,001" and reports the wrong row. Sub-lines print their
 * letter alone ("b Less accumulated depreciation"), so accept that too.
 */
function lineCarrying(rows: string[], value: number): string | null {
  const needle = value.toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const money = new RegExp(`(?<![\\d,])${needle}(?![\\d,])`)
  for (const row of rows) {
    if (!money.test(row)) continue
    const m = row.match(/^\s*(\d{1,2}[ab]?|[ab])\b/)
    return m ? m[1] : '(no line number)'
  }
  return null
}

describe('1120-S Schedule L field placement', () => {
  const expected: Array<[string, number, string]> = [
    ['1  Cash (BOY)',                     111_001,   '1'],
    ['1  Cash (EOY)',                     111_002,   '1'],
    ['3  Inventories',                    222_001,   '3'],
    ['5  Tax-exempt securities',          333_001,   '5'],
    ['6  Other current assets',           444_001,   '6'],
    ['10a Buildings, gross',              555_001,   '10a'],
    ['10b Less accumulated depreciation', 55_555,    'b'],
    ['12 Land',                           666_001,   '12'],
    ['14 Other assets',                   777_001,   '14'],
    ['15 Total assets (BOY)',             3_053_006, '15'],
    ['16 Accounts payable',               11_001,    '16'],
    ['17 Mortgages payable < 1 year',     22_001,    '17'],
    ['18 Other current liabilities',      2_591_998, '18'],
    ['19 Loans from shareholders',        44_001,    '19'],
    ['20 Mortgages payable >= 1 year',    55_001,    '20'],
    ['21 Other liabilities',              66_001,    '21'],
    ['22 Capital stock',                  77_001,    '22'],
    ['23 Additional paid-in capital',     88_001,    '23'],
    ['24 Retained earnings',              99_001,    '24'],
    ['25 Adjustments to equity',          1_001,     '25'],
    ['26 Less cost of treasury stock',    2_001,     '26'],
  ]

  it('puts every figure on its own line, and line 15 is not blank', async () => {
    const rows = await renderScheduleL('1120S', 2025)

    const wrong: string[] = []
    for (const [label, value, line] of expected) {
      const got = lineCarrying(rows, value)
      if (got !== line) wrong.push(`${label}: expected line ${line}, printed on ${got ?? 'NOWHERE'}`)
    }
    expect(wrong, `Schedule L values on the wrong lines:\n${wrong.join('\n')}`).toHaveLength(0)

    // Line 15 carrying the asset total is the specific defect that shipped.
    const total = rows.find(r => /^\s*15\s+Total assets/.test(r))
    expect(total, 'no line 15 row rendered').toBeTruthy()
    expect(total).toContain('3,053,006')
    expect(total).toContain('3,053,012')
  })

  it('total liabilities and equity lands on line 27, not 28', async () => {
    const rows = await renderScheduleL('1120S', 2025)
    const row = rows.find(r => /^\s*27\s+Total liabilities/.test(r))
    expect(row, 'no line 27 row rendered').toBeTruthy()
    expect(row).toContain('3,053,006')
    expect(row).toContain('3,053,012')
  })
})

describe('1120 Schedule L field placement', () => {
  /**
   * The C-corp form has its own version of the same failure: line 28 pointed
   * at line 27's fields, so the balance-sheet total printed inside the "Less
   * cost of treasury stock" parentheses — as a DEDUCTION — and line 28 came
   * out blank on every 1120 generated for 2025.
   */
  const expected: Array<[string, number, string]> = [
    ['1  Cash',                        111_001,   '1'],
    ['3  Inventories',                 222_001,   '3'],
    ['5  Tax-exempt securities',       333_001,   '5'],
    ['6  Other current assets',        444_001,   '6'],
    ['10a Buildings, gross',           555_001,   '10a'],
    ['12 Land',                        666_001,   '12'],
    ['14 Other assets',                777_001,   '14'],
    ['15 Total assets',                3_053_006, '15'],
    ['16 Accounts payable',            11_001,    '16'],
    ['18 Other current liabilities',   2_591_998, '18'],
    ['19 Loans from shareholders',     44_001,    '19'],
    ['20 Mortgages payable >= 1 year', 55_001,    '20'],
    ['21 Other liabilities',           66_001,    '21'],
    ['23 Additional paid-in capital',  88_001,    '23'],
    ['25 Retained earnings—Unapprop.', 99_001,    '25'],
    ['26 Adjustments to equity',       1_001,     '26'],
    ['27 Less cost of treasury stock', 2_001,     '27'],
  ]

  it('places every figure, and the total lands on line 28 rather than in the treasury-stock parens', async () => {
    const rows = await renderScheduleL('1120', 2025)

    const wrong: string[] = []
    for (const [label, value, line] of expected) {
      const got = lineCarrying(rows, value)
      if (got !== line) wrong.push(`${label}: expected line ${line}, printed on ${got ?? 'NOWHERE'}`)
    }
    expect(wrong, `Schedule L values on the wrong lines:\n${wrong.join('\n')}`).toHaveLength(0)

    const total = rows.find(r => /^\s*28\s+Total liabilities/.test(r))
    expect(total, 'no line 28 row rendered').toBeTruthy()
    expect(total).toContain('3,053,006')

    // The treasury-stock line must carry treasury stock, not the total.
    const treasury = rows.find(r => /^\s*27\s+Less cost of treasury/.test(r))
    expect(treasury).toContain('2,001')
    expect(treasury).not.toContain('3,053,006')
  })
})

describe('the hand-verified field map outranks the label matchers', () => {
  /**
   * fillForm has three routes to a field: the typed map (checked against the
   * printed form), a Textract label lookup, and a fuzzy label match. They used
   * to run in one loop, so a guess could overwrite a verified value and object
   * key order decided the winner.
   *
   * Schedule K line 18 is where that bit. It has two canonical spellings —
   * L18_income_loss (the engine's) and L18_reconciliation (the filed-return
   * extractor's). Only the first is mapped, but the second fuzzy-matched onto
   * the same box and printed its zero over a $1.3M reconciliation. Removing it
   * from the map was not enough; the matcher found it anyway.
   */
  it('prints the engine figure on Schedule K line 18, not the extractor twin', async () => {
    const text = await renderText('1120S', 2025, {
      'schedK.L1_ordinary': 1_268_993,
      'schedK.L4_interest': 32_943,
      'schedK.L18_income_loss': 1_302_595,
      'schedK.L18_reconciliation': 0,
    })
    const row = text.split('\n').find(r => /subtract the sum of the amounts/.test(r))
    expect(row, 'no Schedule K line 18 row rendered').toBeTruthy()
    expect(row).toContain('1,302,595')
  })

  it('still fills line 18 from the extractor twin when the engine key is absent', async () => {
    const text = await renderText('1120S', 2025, {
      'schedK.L1_ordinary': 500_000,
      'schedK.L18_reconciliation': 512_345,
    })
    const row = text.split('\n').find(r => /subtract the sum of the amounts/.test(r))
    expect(row).toContain('512,345')
  })
})

describe('Schedule K twin keys', () => {
  /**
   * Making the field map authoritative fixed line 18 and broke line 7, which
   * had been relying on the unmapped twin fuzzy-matching onto the same box.
   * Both directions are pinned here so neither can regress into the other.
   */
  it('fills a mapped key that is zero from its twin, and leaves a real figure alone', async () => {
    const text = await renderText('1120S', 2025, {
      'schedK.L1_ordinary': 1_268_993,
      'schedK.L7_st_gain': 0,                 // mapped, empty
      'schedK.L7_st_capital_gain': 148,       // twin, real
      'schedK.L18_income_loss': 1_302_595,    // mapped, real
      'schedK.L18_reconciliation': 0,         // twin, empty
    })
    const line7 = text.split('\n').find(r => /Net short-term capital gain/.test(r))
    expect(line7, 'no line 7 row rendered').toBeTruthy()
    expect(line7).toContain('148')

    const line18 = text.split('\n').find(r => /subtract the sum of the amounts/.test(r))
    expect(line18).toContain('1,302,595')
  })
})

describe('1120-S Schedule M-2 (accumulated adjustments account)', () => {
  /**
   * There was no 1120-S Schedule M-2 map at all, so the schedule printed
   * blank on every S-corporation return. It is not a presentation detail
   * here: AAA is what determines how much a shareholder can draw out
   * tax-free, and it is what a reader checks distributions against.
   *
   * The 1120's M-2 line numbers mean different things — its line 4 is an
   * "add lines 1-3" subtotal where the 1120-S's line 4 is a LOSS — so the
   * existing keys could not be reused wholesale.
   */
  it('puts each AAA figure on its own line', async () => {
    const text = await renderText('1120S', 2025, {
      'schedM2.L1_beg_balance': 82_652,
      'schedM2.L2_ordinary_income': 1_268_993,
      'schedM2.L3_other_additions': 33_602,
      'schedM2.L4_loss': 0,
      'schedM2.L5_other_reductions': 4_491,
      'schedM2.L6_combine': 1_380_756,
      'schedM2.L7_distributions': 957_009,
      'schedM2.L8_end_balance': 423_747,
    })
    const start = text.indexOf('Analysis of Accumulated Adjustments Account')
    expect(start, 'no Schedule M-2 rendered').toBeGreaterThan(-1)
    const rows = text.slice(start).split('\n')

    const wrong: string[] = []
    for (const [line, value] of [
      ['1', 82_652], ['2', 1_268_993], ['3', 33_602],
      ['5', 4_491], ['6', 1_380_756], ['7', 957_009],
    ] as Array<[string, number]>) {
      const got = lineCarrying(rows, value)
      if (got !== line) wrong.push(`M-2 line ${line} (${value.toLocaleString()}) printed on ${got ?? 'NOWHERE'}`)
    }
    expect(wrong, wrong.join('\n')).toHaveLength(0)

    // Line 8 wraps onto a second physical row, so match it on the value.
    expect(text).toContain('423,747')
  })
})
