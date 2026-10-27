/**
 * A fictional TaxNow org, in-process. Every name, figure and identifier here
 * is invented. The demo practice reads through it on prod, and every test
 * runs against it: dev and tests never call the real org, and nothing here
 * comes from a real taxpayer (the TaxNow corpus this feature was built from is
 * other businesses' IRS data and must never land in the repo).
 *
 * It answers in TaxNow's own shapes, transcripts as the same HTML the real
 * API serves (renderTranscriptHtml), so the parser and the rules run exactly
 * as they do on real data.
 *
 * Stateless on purpose (pm2 cluster): an "IRS request" here succeeds at once
 * and the transcript then reads "Requested data not found"; what the job
 * stores is in the database, not here. A TIN search finds an account when the
 * TIN's last digit is even, so onboarding can be walked end to end; each such
 * TIN gets an account of its own (keyed by its last four and a short hash), so
 * one test run's client is never mistaken for another's. A TIN ending in a
 * fixture account's last four is that account.
 */
import { createHash } from 'node:crypto'
import type { AccountRecord, AccountRef, TaskState, TaxNowApi, TranscriptRef } from './client.js'
import { TaxNowError } from './client.js'

type Tx = [code: string, explanation: string, date: string, amount: string]
interface PeriodSpec {
  form: string; year: number; month: number
  kind: 'filed' | 'nrf' | 'act' | 'none' | 'never' | 'refused'
  tx?: Tx[]; balance?: string; title?: string; lines?: Array<[string, string]>
}
interface AccountSpec { id: string; name: string; last4: string; income: '1120' | '1120S' | '1065'; periods: PeriodSpec[]; retr?: Record<number, Record<string, string>> }

const Q = [3, 6, 9, 12]

function standardPeriods(income: '1120' | '1120S' | '1065', years: number[], incomeMonth = 12): PeriodSpec[] {
  const out: PeriodSpec[] = []
  const incForm = income === '1065' ? '1065' : '1120'
  for (const y of years) {
    out.push({ form: incForm, year: y, month: incomeMonth, kind: 'filed', title: `Form ${income} Account Transcript` })
    for (const m of Q) out.push({ form: '941', year: y, month: m, kind: 'filed' })
    out.push({ form: '940', year: y, month: 12, kind: 'filed' })
  }
  return out
}

function override(ps: PeriodSpec[], o: PeriodSpec[]): PeriodSpec[] {
  const key = (p: PeriodSpec) => `${p.form}|${p.year}|${p.month}`
  const m = new Map(o.map(p => [key(p), p]))
  return ps.map(p => (m.has(key(p)) ? { ...p, ...m.get(key(p))! } : p))
}

const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025]

const ACCOUNTS: AccountSpec[] = [
  {
    id: 'fx-harbor-point', name: 'Harbor Point Dental PC', last4: '4417', income: '1120S',
    periods: override(standardPeriods('1120S', YEARS), [
      { form: '941', year: 2021, month: 6, kind: 'filed', balance: '-$42,960.00', tx: [['150', 'Tax return filed', '07-26-2021', '$61,284.00'], ['650', 'Federal tax deposit', '06-15-2021', '-$61,284.00'], ['971', 'Amended tax return or claim forwarded for processing', '01-20-2022', '$0.00'], ['766', 'Credit to your account', '03-14-2022', '-$42,960.00']] },
      { form: '1120', year: 2023, month: 12, kind: 'filed', title: 'Form 1120S Account Transcript', tx: [['150', 'Tax return filed', '03-15-2024', '$0.00'], ['971', 'Amended tax return or claim forwarded for processing', '06-02-2026', '$0.00']] },
      { form: '941', year: 2019, month: 3, kind: 'none' }, { form: '941', year: 2019, month: 6, kind: 'none' }, { form: '940', year: 2019, month: 12, kind: 'never' },
    ]),
    retr: {
      2022: { 'Gross Receipts or Sales': '$1,912,400.00', 'Other Income': '$41,050.00', 'Compensation of Officers': '$180,000.00', 'Ordinary Income (Loss)': '$402,300.00', 'Total Property Distribution': '$260,000.00', 'Income (Loss)': '$402,300.00', 'Number of Shareholders': '2', 'Received Date': '03-14-2023' },
      2023: { 'Gross Receipts or Sales': '$2,004,900.00', 'Other Income': '$1,200.00', 'Compensation of Officers': '$180,000.00', 'Ordinary Income (Loss)': '$355,800.00', 'Total Property Distribution': '$470,000.00', 'Income (Loss)': '$355,800.00', 'Schedule M-2: Balance at Beginning of Tax Year': '$50,000.00', 'Number of Shareholders': '2', 'Received Date': '03-15-2024' },
    },
  },
  {
    id: 'fx-ostrander', name: 'Ostrander Millwork Inc', last4: '2093', income: '1120S',
    periods: override(standardPeriods('1120S', YEARS), [
      { form: '1120', year: 2023, month: 12, kind: 'filed', title: 'Form 1120S Account Transcript', tx: [['150', 'Tax return filed', '08-19-2024', '$0.00'], ['166', 'Penalty for filing a late partnership or S-corporation return', '08-19-2024', '$2,550.00'], ['670', 'Payment', '10-02-2024', '-$2,550.00']], lines: [['Return due date or return received date (whichever is later):', '08-19-2024']] },
      { form: '940', year: 2023, month: 12, kind: 'nrf', balance: '-$420.00', tx: [['650', 'Federal tax deposit', '01-31-2024', '-$420.00']] },
      { form: '1120', year: 2019, month: 12, kind: 'never' },
    ]),
    retr: {
      2024: { 'Gross Receipts or Sales': '$3,140,000.00', 'Other Income': '$0.00', 'Compensation of Officers': '$0.00', 'Ordinary Income (Loss)': '$286,000.00', 'Total Property Distribution': '$310,000.00', 'Income (Loss)': '$286,000.00', 'Schedule M-2: Balance at Beginning of Tax Year': '$420,000.00', 'Number of Shareholders': '1', 'Received Date': '03-14-2025' },
    },
  },
  {
    id: 'fx-juniper', name: 'Juniper Freight LLC', last4: '7781', income: '1120',
    periods: override(standardPeriods('1120', YEARS), [
      { form: '1120', year: 2023, month: 12, kind: 'filed', balance: '-$8,140.00', tx: [['150', 'Tax return filed', '10-11-2024', '$48,320.00'], ['276', 'Penalty for late payment of tax', '10-11-2024', '$1,166.00'], ['660', 'Estimated tax payment', '12-15-2023', '-$57,626.00']], lines: [['Total Tax per Return:', '$48,320.00'], ['Return due date or return received date (whichever is later):', '10-11-2024']] },
      { form: '1120', year: 2025, month: 12, kind: 'nrf', balance: '-$12,000.00', tx: [['460', 'Extension of time to file tax return ext. Date 10-15-2026', '04-15-2026', '$0.00'], ['660', 'Estimated tax payment', '12-15-2025', '-$12,000.00']] },
      { form: '941', year: 2025, month: 12, kind: 'act', balance: '-$9,410.00', tx: [['650', 'Federal tax deposit', '12-15-2025', '-$9,410.00']] },
      { form: '940', year: 2025, month: 12, kind: 'never' }, { form: '941', year: 2019, month: 3, kind: 'never' },
    ]),
    retr: {
      2023: { 'Gross Receipts': '$2,410,000.00', 'Other Income': '$0.00', 'Taxable Income Per Computer': '$230,100.00', 'Total Income Tax': '$48,320.00', 'Received Date': '10-11-2024' },
      2024: { 'Gross Receipts': '$1,010,000.00', 'Other Income': '$0.00', 'Taxable Income Per Computer': '$0.00', 'Total Income Tax': '$0.00', 'Schedule K Net Operating Loss Carryover Prior Tax Years': '$54,300.00', 'Received Date': '04-14-2025' },
    },
  },
  {
    id: 'fx-redwick', name: 'Redwick Staffing Group', last4: '3306', income: '1120',
    periods: override(standardPeriods('1120', YEARS), [
      { form: '1120', year: 2020, month: 12, kind: 'filed', tx: [['150', 'Tax return filed', '05-10-2021', '$12,000.00'], ['166', 'Penalty for filing a tax return late', '05-10-2021', '$600.00'], ['670', 'Payment', '05-10-2021', '-$12,600.00']] },
      { form: '1120', year: 2022, month: 12, kind: 'filed', balance: '$32,255.00', tx: [['150', 'Tax return filed', '11-20-2023', '$27,104.00'], ['166', 'Penalty for filing a tax return late', '11-20-2023', '$3,940.00'], ['196', 'Interest charged for late payment', '11-20-2023', '$1,211.00']] },
      { form: '941', year: 2024, month: 3, kind: 'filed', balance: '$1,840.00', tx: [['150', 'Tax return filed', '04-30-2024', '$84,200.00'], ['650', 'Federal tax deposit', '04-30-2024', '-$84,200.00'], ['186', 'Penalty for late deposit', '05-20-2024', '$1,840.00']] },
      { form: '941', year: 2021, month: 6, kind: 'filed', tx: [['150', 'Tax return filed', '07-30-2021', '$92,000.00'], ['650', 'Federal tax deposit', '06-30-2021', '-$92,000.00'], ['766', 'Credit to your account', '01-10-2023', '-$112,000.00'], ['846', 'Refund issued', '02-06-2023', '$112,000.00']] },
    ]).concat([2020, 2021, 2022, 2023].map(y => ({ form: '943', year: y, month: 12, kind: 'refused' as const }))),
    retr: {
      2023: { 'Gross Receipts': '$6,800,000.00', 'Other Income': '$112,400.00', 'Taxable Income Per Computer': '$410,000.00', 'Total Income Tax': '$86,100.00', 'Received Date': '04-12-2024' },
    },
  },
  {
    id: 'fx-meridian', name: 'Meridian Bakeshop Inc', last4: '5520', income: '1120',
    periods: override(standardPeriods('1120', YEARS), [
      { form: '1120', year: 2024, month: 12, kind: 'nrf', balance: '-$7,330.00', tx: [['660', 'Estimated tax payment', '04-15-2024', '-$1,830.00'], ['660', 'Estimated tax payment', '06-17-2024', '-$1,830.00'], ['660', 'Estimated tax payment', '09-16-2024', '-$1,830.00'], ['660', 'Estimated tax payment', '12-16-2024', '-$1,840.00']] },
      { form: '1120', year: 2025, month: 12, kind: 'nrf' },
      ...Q.map(m => ({ form: '941', year: 2019, month: m, kind: 'none' as const })), { form: '940', year: 2019, month: 12, kind: 'none' },
    ]),
    retr: { 2023: { 'Gross Receipts': '$880,000.00', 'Other Income': '$0.00', 'Taxable Income Per Computer': '$61,000.00', 'Total Income Tax': '$12,810.00', 'Loans to Shareholders End of Tax Year': '$48,000.00', 'Received Date': '04-15-2024' } },
  },
  {
    id: 'fx-northgate', name: 'Northgate Tool & Die Co', last4: '9162', income: '1120',
    periods: override(standardPeriods('1120', YEARS), [
      { form: '1120', year: 2021, month: 12, kind: 'filed', balance: '-$4,575.00', tx: [['150', 'Tax return filed', '04-12-2022', '$18,005.00'], ['806', 'Credit for withheld taxes', '04-15-2022', '-$22,580.00'], ['846', 'Refund issued', '03-06-2023', '$4,575.00'], ['740', 'Undelivered refund returned to IRS', '04-17-2023', '-$4,575.00']] },
      { form: '1120', year: 2023, month: 12, kind: 'filed', tx: [['150', 'Tax return filed', '04-15-2024', '$31,000.00'], ['660', 'Estimated tax payment', '04-17-2023', '-$7,750.00'], ['660', 'Estimated tax payment', '06-15-2023', '-$7,750.00'], ['660', 'Estimated tax payment', '09-15-2023', '-$7,750.00'], ['660', 'Estimated tax payment', '12-15-2023', '-$7,750.00']] },
      { form: '1120', year: 2024, month: 12, kind: 'filed', tx: [['150', 'Tax return filed', '04-15-2025', '$36,000.00'], ['660', 'Estimated tax payment', '04-15-2024', '-$8,000.00'], ['660', 'Estimated tax payment', '06-17-2024', '-$8,000.00'], ['660', 'Estimated tax payment', '09-16-2024', '-$8,000.00'], ['660', 'Estimated tax payment', '12-13-2024', '-$8,000.00'], ['176', 'Penalty for underpaying estimated tax', '04-15-2025', '$3,212.00'], ['670', 'Payment', '04-15-2025', '-$7,212.00']] },
    ]),
    retr: {
      2023: { 'Gross Receipts': '$3,300,000.00', 'Taxable Income Per Computer': '$147,600.00', 'Total Income Tax': '$31,000.00', 'Received Date': '04-15-2024' },
      2024: { 'Gross Receipts': '$3,520,000.00', 'Taxable Income Per Computer': '$171,400.00', 'Total Income Tax': '$36,000.00', 'Estimated Tax Penalty': '$3,212.00', 'Carryforward General Business Credit': '$6,900.00', 'Allowable Credit': '$0.00', 'Received Date': '04-15-2025' },
    },
  },
  {
    id: 'fx-calloway', name: 'Calloway Imaging Partners', last4: '6048', income: '1065',
    periods: [
      ...[2019, 2020, 2021, 2022, 2023, 2025].map(y => ({ form: '1065', year: y, month: 6, kind: 'never' as const })),
      ...[3, 6, 9].map(m => ({ form: '1065', year: 2024, month: m, kind: 'refused' as const })),
    ],
  },
  {
    // In the org, but no demo client holds it: someone else's 8821 put it
    // there. A practice entering its TIN must wait for proof of its own 8821
    // (FIXTURE_HELD_ELSEWHERE; services/practice.ts readableVerdict).
    id: 'fx-lakeside', name: 'Lakeside Orchard Supply Co', last4: '8824', income: '1120S',
    periods: standardPeriods('1120S', [2024, 2025]),
  },
]

/** The fixture account no demo client holds. */
export const FIXTURE_HELD_ELSEWHERE = 'fx-lakeside'

/** An account a TIN search turns up during onboarding (fictional). `key` is
 *  the TIN's last four, a dash, and a short hash of the whole TIN. */
function onboardedAccount(key: string): AccountSpec {
  return {
    id: `fx-new-${key}`, name: 'New fictional client', last4: key.slice(0, 4), income: '1120S',
    periods: override(standardPeriods('1120S', [2023, 2024, 2025]), [{ form: '940', year: 2025, month: 12, kind: 'never' }]),
  }
}
const tinTag = (digits: string) => `${digits.slice(-4)}-${createHash('sha256').update(digits).digest('hex').slice(0, 6)}`

function accountById(id: string): AccountSpec {
  const a = ACCOUNTS.find(x => x.id === id) ?? (id.startsWith('fx-new-') ? onboardedAccount(id.slice(7)) : null)
  if (!a) throw new TaxNowError(404, 'No such fixture account')
  return a
}

function periodLabel(p: { year: number; month: number }) { return `${String(p.month).padStart(2, '0')}-${new Date(Date.UTC(p.year, p.month, 0)).getUTCDate()}-${p.year}` }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The HTML a TaxNow account transcript arrives as, filled with `spec`. */
export function renderTranscriptHtml(a: Pick<AccountSpec, 'name' | 'last4'>, p: PeriodSpec): string {
  const tin = `XX-XXX${a.last4}`
  const head = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Account Transcript</title></head><body><header><div class="sensitive">This Product Contains Sensitive Taxpayer Data</div><h1 class="transcript-title">${esc(p.title ?? `Form ${p.form} Account Transcript`)}</h1><dl><div><dt class="header-label">Request Date:</dt><dd class="header-value">10-19-2026</dd></div><div><dt class="header-label">Response Date:</dt><dd class="header-value">10-19-2026</dd></div><div><dt class="header-label">Tracking Number:</dt><dd class="header-value">100000000000</dd></div></dl></header>`
  const item = (l: string, v: string) => `<div class="item-container"><dt class="item-label">${esc(l)}</dt><dd class="item-value">${esc(v)}</dd></div>`
  const fixedItems = item('Form Number:', p.form) + item('Report for Tax Period Ending:', periodLabel(p)) + item('Taxpayer Identification Number:', tin)
  if (p.kind === 'none') {
    return head + `<dl class="item-list">${fixedItems}</dl><p class="error-text">Requested data not found.</p><footer></footer></body></html>`
  }
  const balance = p.balance ?? '$0.00'
  let tx: Tx[] = p.tx ?? []
  if (!p.tx && p.kind === 'filed') tx = [['150', 'Tax return filed', p.form === '941' ? '04-30-' + (p.year + (p.month === 12 ? 1 : 0)) : '03-15-' + (p.year + 1), '$0.00']]
  const rows = (p.kind === 'nrf' ? [['', 'No tax return filed', '', '', '']] : []).concat(tx.map(t => [t[0], t[1], '20240000', t[2], t[3]]))
  const lines = p.kind === 'filed' && !p.form.startsWith('94') ? (p.lines ?? [['Return due date or return received date (whichever is later):', '03-15-' + (p.year + 1)]]) : (p.lines ?? [])
  return head + `<article><section class="FIXED"><dl class="item-list">${fixedItems}</dl></section>`
    + `<section class="HEADER"><h2></h2><dl class="item-list">${item('FICTIONAL NAME LINE', '')}</dl></section>`
    + `<section class="AMOUNTS"><h2>** Any minus sign shown below signifies a credit amount **</h2><dl class="item-list">${item('Account balance:', balance)}<div class="interest-and-penalty">Accrued interest: $0.00 As of: 10-19-2026</div><div class="interest-and-penalty">Accrued penalty: $0.00 As of: 10-19-2026</div>${item('Account balance plus accruals (this is not a payoff amount):', balance)}</dl></section>`
    + `<section class="POSTEDRETURNINFORMATION"><h2>** Information from the return or as adjusted **</h2><dl class="item-list">${lines.map(([l, v]) => item(l, v)).join('')}</dl></section>`
    + `<section id="TRANSACTIONCODES"><h2>TRANSACTIONS</h2><table id="transaction-codes"><thead><tr><th>CODE</th><th>EXPLANATION OF TRANSACTION</th><th>CYCLE</th><th>DATE</th><th>AMOUNT</th></tr></thead><tbody>`
    + rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
    + `</tbody></table></section></article><footer></footer></body></html>`
}

const SYNCED = '2026-10-19T10:00:00Z'

export class FixtureTaxNow implements TaxNowApi {
  readonly provider = 'fixture' as const
  readonly orgId = 'fixture'
  async listAccounts(): Promise<AccountRef[]> { return ACCOUNTS.map(a => ({ accountId: a.id, name: a.name })).concat(this.onboarded.map(l => ({ accountId: `fx-new-${l}`, name: 'New fictional client' }))) }
  // TINs a search has found: their accounts then list, as a newly signed
  // 8821 makes an account appear in the real org. Per process; harmless,
  // since a search re-adds it in whichever worker runs the check.
  private onboarded: string[] = []
  async getAccount(accountId: string): Promise<AccountRecord> {
    const a = accountById(accountId)
    const income = a.income === '1065' ? ['1065'] : ['1120', '1120S']
    return {
      accountId, type: 'business', name: a.name, tinUri: `/tins/fx-tin-${a.id.startsWith('fx-new-') ? a.id.slice(7) : a.last4}`,
      tia: { designees: [{ type: 'caf', name: 'Fictional Designee' }, ...(a.id === 'fx-redwick' ? [{ type: 'org', name: 'Another Fictional Firm LLC' }] : [])], permissions: [{ type: 'payroll', forms: ['940', '941'], start: '2018-01-01', end: '2027-12-31' }, { type: 'income', forms: income, start: '2018-01-01', end: '2027-12-31' }] },
    }
  }
  async listTranscripts(accountId: string): Promise<TranscriptRef[]> {
    const a = accountById(accountId)
    const actr = a.periods.map(p => ({ type: 'ACTR', form: p.form, year: p.year, month: p.month, syncedAt: p.kind === 'never' || p.kind === 'refused' ? null : SYNCED }))
    const retr = Object.keys(a.retr ?? {}).map(y => ({ type: 'RETR', form: a.income, year: Number(y), month: 12, syncedAt: SYNCED }))
    return [...actr, ...retr]
  }
  async getTranscriptHtml(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>): Promise<string> {
    const a = accountById(accountId)
    const p = a.periods.find(x => x.form === t.form && x.year === Number(t.year) && x.month === Number(t.month))
    // Never-synced periods read as "not found" once requested (a stateless stand-in for the IRS).
    if (!p || p.kind === 'never') return renderTranscriptHtml(a, { form: t.form, year: Number(t.year), month: Number(t.month), kind: 'none' })
    if (p.kind === 'refused') throw new TaxNowError(404, 'Transcript has not been synced')
    return renderTranscriptHtml(a, p)
  }
  async getTranscriptJson(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>): Promise<any> {
    const a = accountById(accountId)
    const lines = a.retr?.[Number(t.year)]
    if (t.type !== 'RETR' || !lines) throw new TaxNowError(404, 'No such transcript')
    return { form: a.income, year: String(t.year), month: '12', type: 'RETR', syncedAt: SYNCED, sections: [{ name: 'Income', index: 0, items: Object.entries(lines).map(([key, value]) => ({ key, value })) }] }
  }
  async searchTin(tin: string): Promise<string | null> {
    const digits = tin.replace(/\D/g, '')
    if (digits.length !== 9) return null
    const known = ACCOUNTS.find(a => a.last4 === digits.slice(-4))
    if (known) return `/tins/fx-tin-${known.last4}`
    if (Number(digits.at(-1)) % 2 !== 0) return null
    const key = tinTag(digits)
    if (!this.onboarded.includes(key)) this.onboarded.push(key)
    return `/tins/fx-tin-${key}`
  }
  async addClient(accountId: string): Promise<string> { return `/orgs/fixture/clients/${accountId}` }
  async startSync(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>): Promise<string> {
    const a = accountById(accountId)
    const p = a.periods.find(x => x.form === t.form && x.year === Number(t.year) && x.month === Number(t.month))
    return p?.kind === 'refused' ? 'task-refused' : 'task-ok'
  }
  async getTask(_accountId: string, taskId: string): Promise<TaskState> {
    return taskId === 'task-refused'
      ? { status: 'failed', code: 451, message: 'does not match IRS records. Unauthorized for the requested tin, cafNumber, productType, formNumber, taxYear, and taxPeriod' }
      : { status: 'succeeded' }
  }
}

/** Every fixture account; the demo practice is seeded with all but FIXTURE_HELD_ELSEWHERE. */
export const FIXTURE_ACCOUNTS = ACCOUNTS.map(a => ({ accountId: a.id, name: a.name, last4: a.last4, income: a.income }))
