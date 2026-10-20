import { describe, it, expect } from 'vitest'
import { transcriptEntries, isTranscriptText, taxYearOfPeriod, isoOfTranscriptDate, type TranscriptContext } from './transcript.js'

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

describe('IRS return transcript and record of account parsing', () => {
  // Geometry as printed on a 612pt page: data lines run margin to margin,
  // headings are centred, the second half of a wrapped label is indented.
  const D = (raw: string) => ({ raw, bbox: [25, 0, 587, 9] as [number, number, number, number] })
  const H = (raw: string) => ({ raw, bbox: [250, 0, 362, 11] as [number, number, number, number] })
  const I = (raw: string) => ({ raw, bbox: [40, 0, 587, 9] as [number, number, number, number] })

  it('reads every line under the IRS heading it sits in', () => {
    const ctx: TranscriptContext = { section: 'Header' }
    const es = transcriptEntries([
      H('This Product Contains Sensitive Taxpayer Data'),
      H('Form 1120S Tax Return Transcript'),
      D('Response Date: 10-20-2026'),
      D('Report for Tax Period Ending: 12-31-2025'),
      D('Form: 1120S'),
      D('Duplicate Amendment Number 0'),
      { raw: 'Original Return', bbox: [506, 0, 587, 9] },
      D('EXAM PLE IN'),
      D('Document Locator Number: 12345-678-90123-4'),
      D('Received Date: 01-20-2026'),
      H('Indicators, Codes, and Miscellaneous Information'),
      D('Designee Check Box:'),
      D('Correspondence Received Date: 00-00-0000'),
      D('Schedule M-2: Balance at Beginning of Tax Year: $0.00'),
      H('Deductions'),
      D('Total Deductions: $1,406,431.00'),
      D('Ordinary Income/Loss $162,007.00'),
      D('Tier I employee Additional Medicare Tax on railroad compensation per'),
      I('computer: $0.00'),
      H('Schedule E--Supplemental Income and Loss'),
      D('Income or Loss From Partnerships and S-Corps'),
      D('Total partnership and S corporation income: $5,000.00'),
      H('Schedule E--Supplemental Income and Loss'),
      D('Total partnership and S corporation income: $7,000.00'),
    ], 1, ctx)
    expect([ctx.type, ctx.part, ctx.form, ctx.period, ctx.asOf]).toEqual(['return', 'return', '1120S', '12-31-2025', '10-20-2026'])
    const get = (section: string, line: string, instance = '') => es.find(e => e.section === section && e.line === line && e.instance === instance)
    expect(es.every(e => e.form === 'irs_return_transcript')).toBe(true)
    expect(get('Return', 'Document Locator Number')).toMatchObject({ value: '12345-678-90123-4', dln: '12345-678-90123-4' })
    expect(get('Return', 'Received Date')).toMatchObject({ value: '01-20-2026', date: '01-20-2026' })
    expect(get('Return', 'Return')?.value).toBe('Original Return')
    // a blank field and 00-00-0000 are the IRS's "no data on file"
    expect(get('Indicators, Codes, and Miscellaneous Information', 'Designee Check Box')?.value).toBeNull()
    expect(get('Indicators, Codes, and Miscellaneous Information', 'Correspondence Received Date')?.value).toBeNull()
    // the label runs to the LAST colon
    expect(get('Indicators, Codes, and Miscellaneous Information', 'Schedule M-2: Balance at Beginning of Tax Year')?.value).toBe(0)
    expect(get('Deductions', 'Total Deductions')).toMatchObject({ kind: 'amount', value: 1406431 })
    expect(get('Deductions', 'Ordinary Income/Loss')?.value).toBe(162007)
    expect(get('Deductions', 'Tier I employee Additional Medicare Tax on railroad compensation per computer')?.value).toBe(0)
    expect(es.some(e => e.kind === 'row' && /railroad/.test(e.raw) && e.line === '')).toBe(false)
    const s1 = get('Schedule E--Supplemental Income and Loss', 'Total partnership and S corporation income')!
    expect(s1.value).toBe(5000)
    expect(s1.desc).toContain('Income or Loss From Partnerships and S-Corps')
    expect(get('Schedule E--Supplemental Income and Loss', 'Total partnership and S corporation income', '#2')?.value).toBe(7000)
  })

  it('a record of account is the account transcript, then the return transcript', () => {
    const ctx: TranscriptContext = { section: 'Header' }
    const es = transcriptEntries([
      H('Form 1120S Record of Account'),
      D('Response Date: 10-20-2026'),
      D('Report for Tax Period Ending: 12-31-2024'),
      D('Account balance: $0.00'),
      D('TRANSACTIONS'),
      D('150 Tax return filed 20255005 12-29-2025 $0.00'),
      D('Report for Tax Period Ending: 12-31-2024'),
      D('Duplicate Amendment Number 1'),
      H('Income'),
      D('Gross Receipts: $8,641,913.00'),
    ], 1, ctx)
    expect(ctx.type).toBe('record_of_account')
    expect(es.find(e => e.line === '150')?.form).toBe('irs_transcript')
    expect(es.find(e => e.line === 'Account balance')?.form).toBe('irs_transcript')
    expect(es.find(e => e.line === 'Gross Receipts')).toMatchObject({ form: 'irs_return_transcript', section: 'Income', value: 8641913 })
    expect(es.find(e => e.line === 'Duplicate Amendment Number')?.form).toBe('irs_return_transcript')
  })

  it('"No record of return filed" marks the transcript as a no-record response', () => {
    const ctx: TranscriptContext = { section: 'Header' }
    transcriptEntries([H('Form 1040 Tax Return Transcript'), D('Response Date: 10-20-2026'), D('No record of return filed.')], 1, ctx)
    expect([ctx.type, ctx.noRecord]).toEqual(['return', true])
  })

  it('an account transcript is typed and dated, and its year comes from its period', () => {
    const ctx: TranscriptContext = { section: 'Header' }
    transcriptEntries([H('Form 1120 Account Transcript'), D('Response Date: 10-20-2026'), D('Report for Tax Period Ending: 06-30-2025')], 1, ctx)
    expect([ctx.type, ctx.part, ctx.asOf]).toEqual(['account', 'account', '10-20-2026'])
    expect(taxYearOfPeriod(ctx.period)).toBe(2024)
    expect(taxYearOfPeriod('12-31-2025')).toBe(2025)
    expect(isoOfTranscriptDate('10-20-2026')).toBe('2026-10-20')
  })
})
