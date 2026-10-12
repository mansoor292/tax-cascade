/**
 * Form 1120 pages 3–6 must say what the saved return says.
 *
 * Read off a real 2025 return rendered for filing:
 *  - Schedule J lines 2, 4, 7, 11a and 12 printed 0 under a page-1 line 31
 *    that showed the tax (line 31 IS Schedule J line 12).
 *  - Schedule M-2 line 5a (cash distributions) was unmapped; the fuzzy label
 *    matcher put it on Schedule J line 5a, the foreign tax credit.
 *  - The Schedule K checkbox table skipped question 15b, so every answer from
 *    16 on printed one row early — "Yes, member of a controlled group" came
 *    out as "Yes, digital assets".
 *  - Schedule K lines 2a–c and 10 were never filled.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } from 'pdf-lib'
import { buildReturnPdf, SCHED_K_CHECKBOXES_1120 } from './build_return_pdf.js'
import { calc1120 } from '../engine/tax_engine.js'

const entity = {
  name: 'Page Fill Inc', ein: '00-0000000',
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '33301',
  meta: {
    business_code: '541519', business_activity: 'IT SERVICES', product_service: 'SOFTWARE',
    owners: [{ name: 'Sole Owner', pct: '100%' }],
    sched_k: { K1_method: 'accrual', K15a_1099: 'yes', K15b_filed_1099: 'yes', K28_controlled_group: 'yes' },
  },
}

async function render(year: number, fieldValues: Record<string, number>): Promise<string> {
  const { pdf } = await buildReturnPdf({ formType: '1120', taxYear: year, entity, fieldValues })
  const dir = mkdtempSync(path.join(tmpdir(), 'f1120-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await pdf.save())
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start)
  expect(a, `no "${start}" in render`).toBeGreaterThan(-1)
  const b = text.indexOf(end, a + start.length)
  return text.slice(a, b === -1 ? undefined : b)
}

function rowStarting(block: string, line: string): string | undefined {
  return block.split('\n').find(r => new RegExp(`^\\s*${line}\\s`).test(r))
}

describe.each([2024, 2025])('Form 1120 %i pages 3–6', (year) => {
  const r = calc1120({
    gross_receipts: 1_000_000, cost_of_goods_sold: 0, officer_compensation: 100_000,
    salaries_wages: 200_000, tax_year: year, estimated_tax_paid: 10_000,
  } as any)
  const tax = r.computed.total_tax   // 147,000
  const fv: Record<string, number> = {
    ...r.field_values,
    'schedM2.L1_beg_balance': 900_001,
    'schedM2.L2_net_income': 500_002,
    'schedM2.L4_add': 1_400_003,
    'schedM2.L5a_cash_distributions': 4_501,
    'schedM2.L6_other_decreases': 2_937,
    'schedM2.L7_add_5_6': 7_438,
    'schedM2.L8_end_balance': 1_392_565,
  }

  it('Schedule J carries the tax on lines 2, 4, 7, 11a, 12 and nothing on 5a', async () => {
    const text = await render(year, fv)
    const j = between(text, 'Tax Computation and Payment', 'Schedule K')
    const t = tax.toLocaleString()
    for (const line of ['2', '4', '7', '12']) {
      expect(rowStarting(j, line), `Schedule J line ${line}`).toContain(t)
    }
    expect(rowStarting(j, '11a'), 'Schedule J line 11a').toContain(t)
    expect(rowStarting(j, '5a') ?? '', 'Schedule J 5a must stay empty').not.toMatch(/4,501/)
    expect(rowStarting(j, '19'), 'Schedule J line 19 (payments)').toContain('10,000')
  })

  it('Schedule M-2 prints every line on M-2', async () => {
    const text = await render(year, fv)
    const m2 = between(text, 'Analysis of Unappropriated Retained Earnings', 'Form 1120 (')
    for (const v of [900_001, 500_002, 1_400_003, 4_501, 2_937, 7_438, 1_392_565]) {
      expect(m2, `M-2 is missing ${v.toLocaleString()}`).toContain(v.toLocaleString())
    }
    expect(between(text, 'Tax Computation and Payment', 'Schedule K')).not.toContain('4,501')
  })

  it('Schedule K lines 2a–c and 10 are filled', async () => {
    const text = await render(year, fv)
    const k = between(text, 'Other Information', 'Schedule K')
    expect(k).toMatch(/Business activity code no\..*541519/)
    expect(k).toMatch(/Business activity\b(?! code).*IT SERVICES/)
    expect(k).toMatch(/Product or service.*SOFTWARE/)
    expect(rowStarting(k, '10'), 'line 10 shareholder count').toMatch(/\s1\s*$/)
  })
})

/** Widget top-y and checkbox group name for every c5_* box on page 5 of a blank. */
async function page5Boxes(year: number): Promise<Map<string, number>> {
  const doc = await PDFDocument.load(readFileSync(`data/irs_forms/f1120_${year}.pdf`), { ignoreEncryption: true })
  const page = doc.getPage(4)
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray)
  const out = new Map<string, number>()
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i, PDFDict)
    let t = a.lookup(PDFName.of('T'))
    if (!t) t = (a.lookup(PDFName.of('Parent')) as PDFDict | undefined)?.lookup(PDFName.of('T'))
    const name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : ''
    const m = name.match(/^(c5_\d+)\[0\]$/)
    if (!m) continue
    const rect = a.lookup(PDFName.of('Rect'), PDFArray)
    out.set(m[1], (rect.lookup(1) as any).asNumber())
  }
  return out
}

describe('Schedule K checkbox table', () => {
  // Question order down page 5; 32 is "Reserved for future use".
  const PAGE5_ORDER = [
    'K13_receipts_250k', 'K14_utp', 'K15a_1099', 'K15b_filed_1099', 'K16_ownership_change',
    'K17_dispose_65pct', 'K18_351_transfer', 'K19_payments', 'K20_cooperative', 'K21_267a',
    'K22_500m', 'K23_163j', 'K24_8990', 'K25_qof', 'K26_foreign_acq', 'K27_digital_asset',
    'K28_controlled_group', 'K29a_59k', 'K29b_59k_current', 'K29c_safe_harbor',
    'K30a_repurchase', 'K30b_foreign_corp', 'K30c_surrogate', 'K31_consolidated',
  ]

  it.each([2024, 2025])('%i: every page-5 question has its own box, top to bottom', async (year) => {
    const boxes = await page5Boxes(year)
    // Every Yes/No group on the page except reserved line 32 (2025 only).
    const groups = [...boxes.entries()].filter(([, y]) => y > 45).sort((a, b) => b[1] - a[1]).map(([g]) => g)
    const mapped = PAGE5_ORDER.map(k => SCHED_K_CHECKBOXES_1120[k]?.[0])
    expect(mapped).toEqual(groups)
  })

  it('names controlled group (28) on the box after digital assets (27)', () => {
    expect(SCHED_K_CHECKBOXES_1120.K27_digital_asset[0]).toBe('c5_16')
    expect(SCHED_K_CHECKBOXES_1120.K28_controlled_group[0]).toBe('c5_17')
  })
})
