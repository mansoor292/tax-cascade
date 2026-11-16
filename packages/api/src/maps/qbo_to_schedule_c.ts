/**
 * QuickBooks → Schedule C inputs, by translating the corporate mapper's packet
 * (the same approach as maps/qbo_to_1065.ts: the account rules live once, in
 * qbo_to_inputs.ts).
 *
 * What a sole proprietorship does not have, and so is never carried:
 *  - Pay to the owner. An owner's draws are not wages and not deductible; an
 *    "officer compensation" bucket on a single-member LLC's books is flagged.
 *  - Charitable gifts. They are the owner's itemized deduction (Schedule A),
 *    not a business expense.
 *  - Investment income. Interest and dividends on the business's accounts are
 *    the owner's Schedule B items, not Schedule C income.
 *  - A balance sheet. Schedule C has none; the LLC's books keep it.
 */
const SAME = ['gross_receipts', 'returns_allowances', 'cost_of_goods_sold', 'other_income', 'advertising',
  'depreciation', 'depletion', 'employee_benefits', 'pension_plans', 'rents', 'repairs_maintenance', 'taxes_licenses']
const RENAME: Record<string, string> = {
  interest: 'interest', interest_expense: 'interest',
  salaries_wages: 'wages',
  other_deductions: 'other_expenses',
}
const NOT_SCHEDULE_C: Record<string, string> = {
  officer_compensation: 'An owner\'s draws are not wages and are not deductible on Schedule C. Pay to employees belongs in wages.',
  charitable_contrib: 'Charitable gifts are the owner\'s itemized deduction (Schedule A), not a Schedule C expense.',
  interest_income: 'Interest on the business\'s accounts is the owner\'s Schedule B income, not Schedule C.',
  schedule_k_interest: 'Interest on the business\'s accounts is the owner\'s Schedule B income, not Schedule C.',
  schedule_k_dividends_ordinary: 'Dividends are the owner\'s Schedule B income, not Schedule C.',
  dividends: 'Dividends are the owner\'s Schedule B income, not Schedule C.',
}

export interface TranslatedC {
  inputs: Record<string, number>
  warnings: Array<{ code: string; message: string; fix_hint?: string; affected_lines?: string[] }>
}

export function corporateInputsToScheduleC(corp: Record<string, unknown>): TranslatedC {
  const inputs: Record<string, number> = {}
  const warnings: TranslatedC['warnings'] = []
  const add = (k: string, v: number) => { if (v) inputs[k] = Math.round((inputs[k] ?? 0) + v) }
  for (const [k, raw] of Object.entries(corp)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !raw) continue
    if (k.includes('.')) continue // Schedule L/K/M keys: a Schedule C has no balance sheet
    const note = NOT_SCHEDULE_C[k] ?? (k.startsWith('schedule_k_') ? 'Investment income and gains are the owner\'s (Schedules B and D), not Schedule C.' : undefined)
    if (note) {
      warnings.push({ code: 'NOT_SCHEDULE_C', message: `${Math.round(raw).toLocaleString('en-US')} on the books (${k}) is left off Schedule C. ${note}`, affected_lines: ['schedC'] })
      continue
    }
    if (SAME.includes(k)) { add(k, raw); continue }
    if (RENAME[k]) { add(RENAME[k], raw); continue }
    add('other_expenses', raw)
  }
  return { inputs, warnings }
}
