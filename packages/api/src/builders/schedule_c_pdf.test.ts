/**
 * Single-member LLC PDFs: its own Schedule C (form type SchC), and the
 * owner's 1040 package carrying Schedule C, Schedule SE and Schedule 1 lines
 * 3 and 15. Fictional figures.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildReturnPdf } from './build_return_pdf.js'
import { calcScheduleC } from '../engine/schedule_c.js'
import { calc1040 } from '../engine/tax_engine.js'

async function text(pdf: any) {
  const dir = mkdtempSync(path.join(tmpdir(), 'schc-'))
  try {
    const file = path.join(dir, 'r.pdf')
    writeFileSync(file, await pdf.save())
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const row = (t: string, re: RegExp) => t.split('\n').find(l => re.test(l)) ?? ''

const c = calcScheduleC({ gross_receipts: 212_345, advertising: 4_321, rents: 12_000, wages: 30_303 })
const business = { name: 'Fictional Studio LLC', ein: '00-0000000', address: '2 Test Way', city_state_zip: 'Testville, FL, 33301', activity: 'Design', code: '541430', accounting_method: 'cash' }

describe('Schedule C PDFs', () => {
  it("prints the LLC's own Schedule C", async () => {
    const res = await buildReturnPdf({ formType: 'SchC', taxYear: 2025,
      entity: { name: business.name, ein: business.ein, address: business.address, city: 'Testville', state: 'FL', zip: '33301', meta: { owner_name: 'Alder Owner', business_code: '541430', business_activity: 'Design' } },
      fieldValues: c.field_values })
    expect(res.formYear).toBe(2025)
    const t = await text(res.pdf)
    expect(row(t, /Advertising/)).toContain('4,321')
    expect(t).toContain((c.field_values['schedC.L31_net_profit']).toLocaleString('en-US'))
    expect(t).toContain('Alder Owner')
  })

  it("attaches Schedule C, Schedule SE and Schedule 1 lines 3 and 15 to the owner's 1040", async () => {
    const schedule_c = [{ name: business.name, owner: 'taxpayer', net_profit: c.field_values['schedC.L31_net_profit'], field_values: c.field_values, business }]
    const inputs: any = { filing_status: 'mfj', tax_year: 2025, is_sstb: false, wages: 50_000, schedule_c }
    const r = calc1040(inputs)
    const res = await buildReturnPdf({ formType: '1040', taxYear: 2025,
      entity: { name: 'Alder Owner', ein: '000000000', address: '1 Test Way', city: 'Testville', state: 'FL', zip: '33301', meta: { first_name: 'Alder', last_name: 'Owner', filing_status: 'mfj' } },
      inputData: inputs, fieldValues: r.field_values, computedData: {} })
    expect(res.forms).toEqual(expect.arrayContaining(['Schedule 1', `Schedule C — ${business.name}`, 'Schedule SE']))
    const t = await text(res.pdf)
    const profit = (c.field_values['schedC.L31_net_profit']).toLocaleString('en-US')
    expect(row(t, /Business income or \(loss\)/)).toContain(profit)
    expect(row(t, /Deductible part of self-employment tax/)).toContain((r.field_values!['sched1.L15_se_tax_deduction'] as number).toLocaleString('en-US'))
    expect(t).toContain((r.field_values!['f1040sse.L12_se_tax'] as number).toLocaleString('en-US'))
    expect(t).toContain('Fictional Studio LLC')
  })
})
