import { generateObligations, nextBusinessDay, daysUntil } from '../src/engine/tax_calendar.js'

let fail = 0
const eq = (label: string, got: any, want: any) => {
  const ok = String(got) === String(want)
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: got ${got}${ok ? '' : ` want ${want}`}`)
}

// ── Business-day roll, against published IRS dates ──
eq('2026-04-15 Wed stays',            nextBusinessDay('2026-04-15'), '2026-04-15')
eq('2026-03-15 Sun -> Mon 16',        nextBusinessDay('2026-03-15'), '2026-03-16')
eq('2025-06-15 Sun -> Mon 16',        nextBusinessDay('2025-06-15'), '2025-06-16')
// 2027-04-15 is a Thursday; 4/16 Fri is Emancipation Day -> 4/15 unaffected
eq('2027-04-15 Thu stays',            nextBusinessDay('2027-04-15'), '2027-04-15')
// 2022: Apr 15 Fri was Emancipation Day observed (16th was Sat) -> Apr 18 Mon
eq('2022-04-15 Emancipation -> 4/18', nextBusinessDay('2022-04-15'), '2022-04-18')
// 2023: Apr 15 Sat, 4/16 Sun, Emancipation observed Mon 4/17 -> deadline 4/18
eq('2023-04-15 Sat -> Tue 4/18',      nextBusinessDay('2023-04-15'), '2023-04-18')

// ── daysUntil across a month boundary (the bug that would misreport "due in N days") ──
eq('2026-03-01 minus 2026-02-01 = 28', daysUntil('2026-03-01', '2026-02-01'), 28)
eq('2026-12-15 minus 2026-08-26',      daysUntil('2026-12-15', '2026-08-26'), 111)
eq('overdue is negative',              daysUntil('2026-08-01', '2026-08-26'), -25)

// ── Obligation generation ──
const scorp = generateObligations(
  { id: 'E1', form_type: '1120S', state: 'FL', fiscal_year_end: '12/31', extended_years: [2025] }, 2025)
const ret = scorp.find(o => o.kind === 'return')!
eq('S-corp 2025 extended return due', ret.due_date, '2026-09-15')
eq('S-corp extended flag', ret.extended, true)
eq('no separate extension row once filed', scorp.filter(o => o.kind === 'extension').length, 0)
eq('S-corp has no federal estimateds', scorp.filter(o => o.kind === 'estimated_payment').length, 0)
eq('FL annual report present', scorp.filter(o => o.kind === 'annual_report').length, 1)

const ccorp = generateObligations(
  { id: 'E2', form_type: '1120', state: 'FL', fiscal_year_end: '12/31', extended_years: [] }, 2025)
eq('C-corp 2025 return due', ccorp.find(o => o.kind === 'return')!.due_date, '2026-04-15')
eq('C-corp extension row present', ccorp.filter(o => o.kind === 'extension').length, 1)
eq('C-corp 4 estimateds', ccorp.filter(o => o.kind === 'estimated_payment').length, 4)

const ind = generateObligations(
  { id: 'E3', form_type: '1040', state: 'FL', fiscal_year_end: '12/31', extended_years: [] }, 2025)
eq('1040 Q4 estimated lands next Jan',
   ind.find(o => o.kind === 'estimated_payment' && o.period === 'Q4')!.due_date, '2026-01-15')
eq('1040 gets no FL corporate items', ind.filter(o => o.jurisdiction === 'FL').length, 0)

// keys must be stable and unique
const keys = [...scorp, ...ccorp, ...ind].map(o => o.obligation_key)
eq('keys unique', new Set(keys).size, keys.length)

// fiscal-year filers are flagged, not silently wrong
const fy = generateObligations({ id: 'E4', form_type: '1120', fiscal_year_end: '06/30' }, 2025)
eq('fiscal year end flagged', !!fy.find(o => o.kind === 'return')!.note, true)

console.log(fail ? `\n${fail} FAILURES` : '\nall passed')
process.exit(fail ? 1 : 0)
