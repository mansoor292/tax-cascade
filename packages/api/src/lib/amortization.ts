/**
 * Loan amortization schedule → balanced JournalEntry payloads
 *
 * Given loan terms (principal, annual rate, term in months, first payment
 * date) and the accounts involved, produces one JournalEntry per monthly
 * payment ready to feed into post_transactions_batch or qbo_resource.
 *
 * Math: standard fixed-rate amortization.
 *   monthly_rate   = annual_rate / 12
 *   payment        = P × r / (1 − (1 + r)^-n)  [when r > 0]
 *                    P / n                        [when r == 0]
 *   for each month: interest = balance × r
 *                   principal_paid = payment − interest
 *                   balance -= principal_paid
 *
 * Rounding: payment is rounded to the nearest cent; the LAST month's
 * principal is adjusted to zero the balance exactly (absorbs ≤ $0.01
 * of accumulated rounding drift).
 *
 * Zero-interest loans get equal principal payments.
 *
 * JournalEntry shape (QBO v3):
 *   - Three lines per payment: Dr principal account, Dr interest account,
 *     Cr bank account. All three sum to 0 (balanced).
 *   - TxnDate increments monthly from first_payment_date.
 *   - DocNumber: `${docNumberPrefix}-${monthIndex}` (e.g. LN2024-01, LN2024-02...)
 */

export interface AmortizationInput {
  principal: number
  annual_rate: number   // as a decimal (0.07 = 7%)
  term_months: number
  first_payment_date: string  // 'YYYY-MM-DD'

  // QBO account IDs for JE line routing
  interest_account_id: string   // expense: interest paid
  principal_account_id: string  // liability: loan balance
  from_account_id: string       // asset: bank/cash paying the monthly P&I

  // Optional metadata
  doc_number_prefix?: string    // default 'LN'
  memo_prefix?: string          // default 'Loan payment'
  payee_name?: string           // optional EntityRef on each JE
}

export interface AmortizationPayment {
  month: number           // 1-indexed
  date: string            // 'YYYY-MM-DD'
  payment: number         // total cash out
  interest: number        // portion to interest expense
  principal: number       // portion to principal reduction
  balance_after: number   // remaining loan balance
}

export interface AmortizationOutput {
  summary: {
    principal: number
    annual_rate: number
    term_months: number
    monthly_payment: number
    total_payments: number
    total_interest: number
    first_payment_date: string
    last_payment_date: string
  }
  schedule: AmortizationPayment[]
  journal_entries: any[]   // QBO JournalEntry payloads
}

/** Add N calendar months to an ISO date string. Safe across month lengths. */
export function addMonths(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number)
  if (!y || !m || !d) throw new Error(`Invalid date: ${dateIso}`)
  // 0-based month math
  const totalMonths = (m - 1) + n
  const year = y + Math.floor(totalMonths / 12)
  const month = totalMonths % 12 + 1
  // Clamp day to month length so Mar 31 + 1mo → Apr 30, etc.
  const daysInMonth = new Date(year, month, 0).getDate()
  const day = Math.min(d, daysInMonth)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Round to 2 decimal places */
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Pure-math payment schedule (no QBO payloads). */
export function computeSchedule(
  principal: number,
  annualRate: number,
  termMonths: number,
  firstPaymentDate: string,
): { monthlyPayment: number; schedule: AmortizationPayment[] } {
  if (principal <= 0) throw new Error('principal must be > 0')
  if (termMonths <= 0 || !Number.isInteger(termMonths)) {
    throw new Error('term_months must be a positive integer')
  }
  if (annualRate < 0) throw new Error('annual_rate cannot be negative')

  const r = annualRate / 12
  const n = termMonths
  const monthlyPayment = r2(
    annualRate === 0
      ? principal / n
      : (principal * r) / (1 - Math.pow(1 + r, -n))
  )

  const schedule: AmortizationPayment[] = []
  let balance = principal
  for (let i = 1; i <= n; i++) {
    const interest = r2(balance * r)
    let principalPaid = r2(monthlyPayment - interest)
    // Absorb rounding drift on the last payment
    if (i === n) principalPaid = r2(balance)
    balance = r2(balance - principalPaid)
    const payment = r2(interest + principalPaid)
    schedule.push({
      month: i,
      date: addMonths(firstPaymentDate, i - 1),
      payment,
      interest,
      principal: principalPaid,
      balance_after: balance,
    })
  }
  return { monthlyPayment, schedule }
}

/** Build balanced JournalEntry payloads from a schedule. */
export function scheduleToJournalEntries(
  schedule: AmortizationPayment[],
  input: AmortizationInput,
): any[] {
  const docPrefix = input.doc_number_prefix || 'LN'
  const memoPrefix = input.memo_prefix || 'Loan payment'
  return schedule.map(pay => {
    const lines: any[] = [
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: pay.principal,
        Description: `${memoPrefix} ${pay.month}/${schedule.length} — principal`,
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: input.principal_account_id },
        },
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: pay.interest,
        Description: `${memoPrefix} ${pay.month}/${schedule.length} — interest`,
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: input.interest_account_id },
        },
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: pay.payment,
        Description: `${memoPrefix} ${pay.month}/${schedule.length} — cash out`,
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { value: input.from_account_id },
        },
      },
    ]
    return {
      TxnDate: pay.date,
      DocNumber: `${docPrefix}-${String(pay.month).padStart(3, '0')}`,
      PrivateNote: `Auto-generated loan amortization ${pay.month}/${schedule.length}. Balance after: ${pay.balance_after}.`,
      Line: lines,
    }
  })
}

/** Main entry point. */
export function amortizationSchedule(input: AmortizationInput): AmortizationOutput {
  const { monthlyPayment, schedule } = computeSchedule(
    input.principal,
    input.annual_rate,
    input.term_months,
    input.first_payment_date,
  )
  const journalEntries = scheduleToJournalEntries(schedule, input)
  const totalPayments = r2(schedule.reduce((s, p) => s + p.payment, 0))
  const totalInterest = r2(schedule.reduce((s, p) => s + p.interest, 0))
  return {
    summary: {
      principal: input.principal,
      annual_rate: input.annual_rate,
      term_months: input.term_months,
      monthly_payment: monthlyPayment,
      total_payments: totalPayments,
      total_interest: totalInterest,
      first_payment_date: input.first_payment_date,
      last_payment_date: schedule[schedule.length - 1].date,
    },
    schedule,
    journal_entries: journalEntries,
  }
}
