/**
 * Statement pages are the attachment the form itself demands — Form 1120-S
 * line 20 reads "Other deductions (attach statement)". They were only ever
 * itemized from a standing list on the ENTITY; the `<bucket>_detail` arrays a
 * compute call supplies (already checked by compute_validation) were never
 * read here, so an itemized return printed a one-line "Total:" page.
 *
 * These build real PDFs from the committed blank forms and read the text back
 * with pdftotext, because the failure being pinned is what lands on the page.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildReturnPdf } from './build_return_pdf.js'

const entity = {
  name: 'Statement Test Inc', ein: '00-0000000',
  address: '1 Test Way', city: 'Testville', state: 'FL', zip: '33301',
}

async function textOf(input: Parameters<typeof buildReturnPdf>[0]): Promise<string> {
  const { pdf } = await buildReturnPdf(input)
  const dir = mkdtempSync(path.join(tmpdir(), 'stmt-'))
  try {
    const file = path.join(dir, 'return.pdf')
    writeFileSync(file, await pdf.save())
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const base = {
  formType: '1120S', taxYear: 2024, entity,
  fieldValues: { 'deductions.L20_other': 164_016 },
}

describe('other-deductions statement', () => {
  it('itemizes from the detail a compute call supplied', async () => {
    const text = await textOf({
      ...base,
      inputData: {
        other_deductions: 164_016,
        other_deductions_detail: [
          { label: 'Professional fees', amount: 92_500 },
          { label: 'Insurance', amount: 41_516 },
          { label: 'Software subscriptions', amount: 30_000 },
        ],
      },
    })
    expect(text).toContain('Other Deductions')
    expect(text).toContain('Professional fees')
    expect(text).toContain('Insurance')
    expect(text).toContain('Software subscriptions')
    expect(text).toContain('Total Other Deductions')
    expect(text).toContain('164,016')
  })

  it('still falls back to a summary line when no detail was supplied', async () => {
    const text = await textOf({ ...base, inputData: { other_deductions: 164_016 } })
    expect(text).toContain('Other Deductions')
    expect(text).toContain('Total: 164,016')
    expect(text).not.toContain('Total Other Deductions')
  })

  it('refuses an itemization that does not tie to the figure on the form', async () => {
    // A statement that contradicts the line it supports is worse than no
    // statement: fall back to the summary rather than print a mismatch.
    const text = await textOf({
      ...base,
      inputData: {
        other_deductions: 164_016,
        other_deductions_detail: [{ label: 'Professional fees', amount: 92_500 }],
      },
    })
    expect(text).toContain('Total: 164,016')
    expect(text).not.toContain('Professional fees')
  })

  it('carries a long itemization onto continuation pages instead of clipping it', async () => {
    // 60 rows overflows one page. Every row must survive, and the total must
    // still be the form's figure.
    const items = Array.from({ length: 60 }, (_, i) => ({
      label: `Deduction line item number ${i + 1}`, amount: 1_000,
    }))
    const text = await textOf({
      ...base,
      fieldValues: { 'deductions.L20_other': 60_000 },
      inputData: { other_deductions: 60_000, other_deductions_detail: items },
    })
    expect(text).toContain('Deduction line item number 1 ')
    expect(text).toContain('Deduction line item number 60')
    expect(text).toContain('(continued)')
    expect(text).toContain('Total Other Deductions')
    expect(text).toContain('60,000')
  })

  it('reads [label, amount] tuples off the entity as before', async () => {
    const text = await textOf({
      ...base,
      entity: { ...entity, meta: { other_deductions: [['Bank fees', 164_016]] } },
      inputData: {},
    })
    expect(text).toContain('Bank fees')
    expect(text).toContain('Total Other Deductions')
  })
})
