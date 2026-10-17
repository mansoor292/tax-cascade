import { describe, it, expect } from 'vitest'
import { transcriptEntries, isTranscriptText, type TranscriptContext } from './transcript.js'

const L = (raw: string) => ({ raw, bbox: [0, 0, 1, 1] as [number, number, number, number] })

describe('IRS account transcript parsing', () => {
  it('recognises a transcript page', () => {
    expect(isTranscriptText('This Product Contains Sensitive Taxpayer Data Form 1120S Account Transcript')).toBe(true)
    expect(isTranscriptText('Form 1120-S U.S. Income Tax Return for an S Corporation')).toBe(false)
  })

  it('header, balances, return information and transactions', () => {
    const ctx: TranscriptContext = { section: 'Header' }
    const es = transcriptEntries([
      L('Form Number: 1120S'),
      L('Report for Tax Period Ending: 12-31-2021'),
      L('Account balance: $2,520.00'),
      L('Accrued interest: $511.27 As of: 10-26-2026'),
      L('** Information from the return or as adjusted **'),
      L('Taxable Income -$41,424.00'),
      L('Return due date or return received date (whichever is later): 02-12-2024'),
      L('TRANSACTIONS'),
      L('150 Tax return filed 20241305 04-01-2024 $0.00'),
      L('12345-678-90123-4'),
      L('976 Duplicate return filed 09-15-2022 $0.00'),
      L('246 Failure to provide information penalty 04-01-2024 $2,520.00'),
    ], 1, ctx)
    expect(ctx.form).toBe('1120S')
    expect(ctx.period).toBe('12-31-2021')
    const get = (section: string, line: string) => es.find(e => e.section === section && e.line === line)
    expect(get('Account', 'Account balance')?.value).toBe(2520)
    expect(get('Account', 'Accrued interest')?.date).toBe('10-26-2026')
    expect(get('Return information', 'Taxable Income')?.value).toBe(-41424)
    expect(get('Return information', 'Return due date or return received date (whichever is later)')?.date).toBe('02-12-2024')
    const tc150 = get('Transactions', '150')!
    expect([tc150.date, tc150.cycle, tc150.dln]).toEqual(['04-01-2024', '20241305', '12345-678-90123-4'])
    expect(get('Transactions', '976')?.date).toBe('09-15-2022')
    expect(get('Transactions', '246')?.value).toBe(2520)
  })
})
