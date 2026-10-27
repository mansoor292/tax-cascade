/**
 * The practice workspace's words, in the preparer's terms (UI audit rule:
 * never internal names). One map per thing, imported by every practice page.
 */
import type { PeriodStatus, Stage } from '@/hooks/use-practice'

export const STATUS: Record<PeriodStatus, { label: string; glyph: string; meaning: string }> = {
  filed: { label: 'Filed', glyph: '150', meaning: 'A return posted (TC 150).' },
  no_return_filed: { label: 'No return filed', glyph: 'NR', meaning: 'The IRS has the period (deposits, a representative) and shows "No tax return filed".' },
  activity_no_return: { label: 'Activity, no return', glyph: 'act', meaning: 'Activity on the period, no return yet. Often a quarter in progress.' },
  no_irs_account: { label: 'No IRS account', glyph: '–', meaning: '"Requested data not found": authorized, nothing there.' },
  not_authorized: { label: 'Refused (451)', glyph: '451', meaning: 'The IRS refused: the 8821 on file does not cover this form or period.' },
  never_synced: { label: 'Never pulled', glyph: '?', meaning: 'Never pulled from the IRS. Requesting it is an IRS request.' },
  no_transactions: { label: 'Nothing posted', glyph: '0', meaning: 'Listed in the export with no transactions: it does not say whether the IRS had an account for it.' },
}
export const STATUS_ORDER: PeriodStatus[] = ['filed', 'no_return_filed', 'activity_no_return', 'no_irs_account', 'not_authorized', 'never_synced', 'no_transactions']

export const STAGE: Record<Stage, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'mute' }> = {
  draft: { label: 'Draft', tone: 'mute' },
  awaiting_signature: { label: 'Waiting on signature', tone: 'mute' },
  signed: { label: 'Signed · to submit', tone: 'info' },
  submitted: { label: 'Submitted · checked daily', tone: 'info' },
  readable: { label: 'Readable', tone: 'good' },
  claimed: { label: 'Readable', tone: 'good' },
  imported: { label: 'Imported', tone: 'info' },
}

/** A reviewer's verdict on a finding, in plain words. */
export const VERDICT: Record<'valid' | 'invalid' | 'unsure', { label: string; tone: 'good' | 'bad' | 'warn' }> = {
  valid: { label: 'Valid', tone: 'good' },
  invalid: { label: 'Not valid', tone: 'bad' },
  unsure: { label: 'Unsure', tone: 'warn' },
}

export const FINDING: Record<string, { label: string; kind: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'mute'; rule: string }> = {
  credit_held: { label: 'Credit held', kind: 'Money', tone: 'good', rule: 'Credit on a filed period with no refund since. Allowed credits are the IRS’s to pay.' },
  refund_not_reissued: { label: 'Refund undelivered or cancelled', kind: 'Money', tone: 'good', rule: 'TC 740/841 with no TC 846 after it, while the period still holds a credit: the money is back on the account. No more than the credit still there.' },
  missing_return: { label: 'Missing return', kind: 'Missing', tone: 'bad', rule: 'Past due, the IRS shows "No tax return filed", and something shows a return was owed: deposits, an extension, an IRS non-filing inquiry (TC 140), returns posted before and after, the return the year before, or payroll filed that year. An empty period the 8821 opened is not counted.' },
  missing_return_unclear: { label: 'Missing return, unclear', kind: 'Missing', tone: 'warn', rule: 'The same evidence, but the IRS record points elsewhere: deposits moved to another period (TC 652), a return marked secured that never posted (599), a duplicate or amended return with no original, or the delinquency closed (593/597/598).' },
  missing_return_pending: { label: 'Missing return, recent', kind: 'Missing', tone: 'info', rule: 'Past due by 120 days or less: the return may still be processing.' },
  deposits_no_return: { label: 'Deposits, no return due yet', kind: 'Money', tone: 'mute', rule: 'Credit on a period the IRS shows "No tax return filed" that is none of the above: not due yet, or no evidence a return is owed. Not money owed back until a return posts.' },
  penalty_fta: { label: 'Penalty, first-time abatement', kind: 'Penalty', tone: 'warn', rule: 'Late filing, late payment or deposit penalty still standing, with none still standing in the 3 years before. Unpaid, abatement takes it off the balance due; paid, it refunds only inside the refund window.' },
  penalty_fta_after_payment: { label: 'Penalty, FTA once tax is paid', kind: 'Penalty', tone: 'info', rule: 'First-time abatement fits, but tax is still owed on the period and no installment agreement is in force: it becomes available once the tax is paid or an agreement is in place.' },
  penalty_reasonable_cause: { label: 'Penalty, reasonable cause', kind: 'Penalty', tone: 'warn', rule: 'Any other abatable penalty still standing. Estimated-tax penalties and collection fees are left out.' },
  penalty_covid_kwong: { label: 'Penalty, COVID window (Kwong)', kind: 'Penalty', tone: 'warn', rule: 'Late filing, late payment, deposit or estimated-tax penalty on a deadline from 2020-01-20 to 2023-07-10, which IRC 7508A(d) postponed (Kwong v. United States, Ct. Fed. Cl. 2025). The IRS does not accept it: a position to argue, not settled law. Counts only if unpaid or inside the refund window.' },
  claim_pending: { label: 'Claim pending', kind: 'Claim', tone: 'info', rule: 'TC 971 claim forwarded with nothing posted after it. The transcript does not carry the amount.' },
  claim_disallowed: { label: 'Claim disallowed', kind: 'Claim', tone: 'bad', rule: 'TC 290 "Disallowed claim".' },
  erc_refund_as_income: { label: 'Retention credit booked as income', kind: 'Amend?', tone: 'info', rule: 'Retention-credit refunds received in a year while that year’s other income is about that size. The credit reduces wages of 2020/2021 instead.' },
  nol_carryover: { label: 'Loss carryover', kind: 'Carryover', tone: 'good', rule: 'Net operating loss carried on the return.' },
  credit_carryforward: { label: 'Credit carryforward', kind: 'Carryover', tone: 'good', rule: 'General business credit carried forward on the return.' },
  es_penalty_safe_harbor: { label: 'Estimated-tax penalty, safe harbor', kind: 'Penalty', tone: 'warn', rule: 'Penalty on the return although estimates by Dec 15 reached the prior year’s tax.' },
  irs_tax_differs: { label: 'IRS tax differs from the return', kind: 'Review', tone: 'info', rule: 'TC 150 more than $100 from the tax on the return.' },
  low_officer_pay: { label: 'Low officer pay', kind: 'Risk', tone: 'bad', rule: 'S-corp distributions with officer pay 0 or under 10% of them, on ordinary income above $50K.' },
  distributions_over_income: { label: 'Distributions above income', kind: 'Risk', tone: 'bad', rule: 'Distributions above Schedule K income plus the M-2 opening balance: basis, taxable distribution.' },
  shareholder_loan: { label: 'Loans to shareholders', kind: 'Risk', tone: 'bad', rule: 'Balance-sheet loans to shareholders at year end.' },
  revenue_swing: { label: 'Revenue swing', kind: 'Info', tone: 'mute', rule: 'Gross receipts moved more than 50%.' },
}
/** Penalties that can come off, in the tiles' totals. The COVID window is contested, so it is named beside them. */
export const PENALTIES = ['penalty_fta', 'penalty_fta_after_payment', 'penalty_reasonable_cause']

/** Display order within a section: money first, then missing, penalties, claims, the returns. */
export const FINDING_ORDER = Object.keys(FINDING)

export const SECTION: Record<string, { label: string; intro: string }> = {
  income: { label: 'Income tax', intro: 'Income-tax opportunities across every readable client, from the IRS account transcripts and the returns. Amounts are as of each transcript’s last read.' },
  payroll: { label: 'Payroll', intro: '941, 940 and 943 findings, kept apart from income tax.' },
  risk: { label: 'Risks from the returns', intro: 'Read from the returns: positions an examiner would ask about. Not money until someone acts.' },
}

export const FORM_NAME: Record<string, string> = { '1120': '1120', '1120S': '1120-S', '1065': '1065', '1040': '1040', '941': '941', '940': '940', '943': '943', '944': '944' }

export function money(cents: number | null | undefined, empty = '—'): string {
  if (cents == null) return empty
  const neg = cents < 0
  const s = '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return neg ? `−${s}` : s
}

export function periodLabel(form: string, year: number, month: number | null): string {
  if (month == null) return String(year)
  if (form === '941') return `${year} Q${Math.ceil(month / 3)}`
  if (month !== 12) return `${year}-${String(month).padStart(2, '0')}`
  return String(year)
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  if (days < 730) return `${Math.round(days / 30)} months ago`
  return `${Math.round(days / 365)} years ago`
}
