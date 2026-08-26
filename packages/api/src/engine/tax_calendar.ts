/**
 * Tax calendar — deterministic obligation generation.
 *
 * Same principle as tax_tables.ts: the rules live in code, not in user data.
 * Nobody types a deadline in. Given an entity's form type, tax year, state,
 * and which extensions it has already filed, this produces the full set of
 * obligations with correct due dates.
 *
 * Scope of this version: federal returns, federal extensions, federal
 * estimated tax, plus two Florida items (every entity we serve today is FL,
 * and the FL annual report is the single most-missed filing there is).
 * Other states are not modeled — see STATE_COVERAGE below.
 *
 * Due dates assume a CALENDAR year end (12/31). Fiscal-year filers are
 * flagged rather than silently given the wrong date; see generateObligations.
 */

// ── Business-day adjustment ────────────────────────────────────────────────
// A federal filing deadline that lands on a Saturday, Sunday, or legal
// holiday rolls to the next business day (IRC §7503). DC's Emancipation Day
// counts for this purpose because the IRS is headquartered there, which is
// why April 15 sometimes becomes April 17.

/**
 * A fixed-date holiday falling on a weekend is OBSERVED on the adjacent
 * weekday, and the observed day is itself a legal holiday for §7503 purposes.
 * This matters most for DC Emancipation Day (April 16): when the 16th is a
 * Saturday it is observed on Friday the 15th, which pushes the April 15
 * filing deadline to the following Monday. Getting this wrong would put the
 * single most common deadline in the system on the wrong day.
 */
function observed(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const dow = d.getUTCDay()
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1)  // Saturday → observed Friday
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1)  // Sunday   → observed Monday
  return iso(d)
}

/** Fixed-date federal holidays that can absorb a filing deadline. */
function fixedHolidays(year: number): string[] {
  return [
    `${year}-01-01`, // New Year's Day
    `${year}-06-19`, // Juneteenth
    `${year}-07-04`, // Independence Day
    `${year}-11-11`, // Veterans Day
    `${year}-12-25`, // Christmas
    `${year}-04-16`, // DC Emancipation Day — shifts the April 15 deadlines
  ].flatMap(h => [h, observed(h)])
}

/** nth <weekday> of a month, e.g. 3rd Monday of January. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  const day = 1 + offset + (n - 1) * 7
  return iso(new Date(Date.UTC(year, month - 1, day)))
}

/** last <weekday> of a month, e.g. last Monday of May (Memorial Day). */
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0))
  const back = (last.getUTCDay() - weekday + 7) % 7
  return iso(new Date(Date.UTC(year, month - 1, last.getUTCDate() - back)))
}

function floatingHolidays(year: number): string[] {
  return [
    nthWeekday(year, 1, 1, 3),   // MLK Day — 3rd Monday of January
    nthWeekday(year, 2, 1, 3),   // Washington's Birthday — 3rd Monday of February
    lastWeekday(year, 5, 1),     // Memorial Day — last Monday of May
    nthWeekday(year, 9, 1, 1),   // Labor Day — 1st Monday of September
    nthWeekday(year, 10, 1, 2),  // Columbus Day — 2nd Monday of October
    nthWeekday(year, 11, 4, 4),  // Thanksgiving — 4th Thursday of November
  ]
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Roll a date forward to the next business day if it lands on a weekend or a
 * federal holiday (IRC §7503). Both the actual and observed dates of a fixed
 * holiday count — see `observed`.
 */
export function nextBusinessDay(dateStr: string): string {
  const holidays = new Set<string>()
  const year = Number(dateStr.slice(0, 4))
  for (const y of [year - 1, year, year + 1]) {
    fixedHolidays(y).forEach(h => holidays.add(h))
    floatingHolidays(y).forEach(h => holidays.add(h))
  }

  const d = new Date(`${dateStr}T00:00:00Z`)
  // Bounded loop — at most a weekend plus a couple of stacked holidays.
  for (let i = 0; i < 10; i++) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6 && !holidays.has(iso(d))) return iso(d)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return iso(d)
}

// ── Obligation shape ───────────────────────────────────────────────────────

export type ObligationKind =
  | 'return'            // the annual return itself
  | 'extension'         // the deadline to FILE an extension (same as the original return date)
  | 'estimated_payment' // quarterly estimated tax
  | 'annual_report'     // state entity filing (FL Sunbiz)
  | 'state_return'      // state income tax return

export interface GeneratedObligation {
  /** Stable natural key — regeneration must produce the same key for the same obligation. */
  obligation_key: string
  entity_id: string
  kind: ObligationKind
  title: string
  /** ISO date, already business-day adjusted. */
  due_date: string
  tax_year: number
  /** 'annual' | 'Q1'…'Q4' — which period this covers. */
  period: string
  jurisdiction: 'federal' | 'FL'
  form: string | null
  /** True when an extension has been filed and this is the extended date. */
  extended: boolean
  /** Set when the rule could not be applied cleanly — surfaced, never silently dropped. */
  note?: string
}

export interface EntityForCalendar {
  id: string
  form_type: string          // '1120' | '1120S' | '1040' | '1065'
  entity_type?: string
  state?: string | null
  fiscal_year_end?: string | null   // 'MM/DD'
  /** Tax years for which a 7004/4868 extension row already exists. */
  extended_years?: number[]
}

/** States with modeled obligations. Everything else generates federal only. */
export const STATE_COVERAGE = ['FL'] as const

// ── Federal rules ──────────────────────────────────────────────────────────
//
// Calendar-year filers:
//   1120-S / 1065 → 15th day of the 3rd month  (Mar 15), extended +6 → Sep 15
//   1120 / 1040   → 15th day of the 4th month  (Apr 15), extended +6 → Oct 15
//
// Estimated tax:
//   1040 individuals → Apr 15, Jun 15, Sep 15 of the tax year, Jan 15 of the next
//   1120 C-corps     → Apr 15, Jun 15, Sep 15, Dec 15 of the tax year
//   1120-S           → none by default. An S-corp only owes estimated tax in the
//                      narrow §1374 built-in-gains / §1375 excess-net-passive
//                      cases, which we do not detect, so we do not guess.

const RETURN_RULES: Record<string, { month: number; day: number; extMonths: number; form: string; extForm: string }> = {
  '1120':  { month: 4, day: 15, extMonths: 6, form: '1120',  extForm: '7004' },
  '1120S': { month: 3, day: 15, extMonths: 6, form: '1120-S', extForm: '7004' },
  '1065':  { month: 3, day: 15, extMonths: 6, form: '1065',  extForm: '7004' },
  '1040':  { month: 4, day: 15, extMonths: 6, form: '1040',  extForm: '4868' },
}

const ESTIMATED_RULES: Record<string, Array<{ period: string; month: number; day: number; nextYear?: boolean }>> = {
  '1040': [
    { period: 'Q1', month: 4,  day: 15 },
    { period: 'Q2', month: 6,  day: 15 },
    { period: 'Q3', month: 9,  day: 15 },
    { period: 'Q4', month: 1,  day: 15, nextYear: true },
  ],
  '1120': [
    { period: 'Q1', month: 4,  day: 15 },
    { period: 'Q2', month: 6,  day: 15 },
    { period: 'Q3', month: 9,  day: 15 },
    { period: 'Q4', month: 12, day: 15 },
  ],
}

function normalizeFormType(ft: string): string {
  return (ft || '').toUpperCase().replace(/-/g, '')
}

/**
 * Generate every obligation for one entity for one tax year.
 *
 * `today` is injected rather than read from the clock so the output is
 * reproducible and testable.
 */
export function generateObligations(
  entity: EntityForCalendar,
  taxYear: number,
): GeneratedObligation[] {
  const out: GeneratedObligation[] = []
  const ft = normalizeFormType(entity.form_type)
  const rule = RETURN_RULES[ft]
  if (!rule) return out

  const isExtended = (entity.extended_years || []).includes(taxYear)

  // Fiscal-year filers: the month offsets below are anchored to a 12/31 year
  // end. Rather than emit a wrong date, emit the calendar-year date with a
  // note so it shows up as needing a human.
  const fye = (entity.fiscal_year_end || '12/31').trim()
  const fiscalNote = fye === '12/31'
    ? undefined
    : `Entity has a ${fye} fiscal year end — this date assumes a 12/31 year end and needs manual confirmation.`

  const key = (parts: string[]) => parts.join(':')

  // ── The return ───────────────────────────────────────────────────────────
  const originalDue = nextBusinessDay(`${taxYear + 1}-${pad(rule.month)}-${pad(rule.day)}`)
  const extendedDue = nextBusinessDay(
    `${taxYear + 1}-${pad(rule.month + rule.extMonths)}-${pad(rule.day)}`,
  )

  out.push({
    obligation_key: key([entity.id, 'return', String(taxYear)]),
    entity_id: entity.id,
    kind: 'return',
    title: isExtended
      ? `${rule.form} return due (extended) — ${taxYear}`
      : `${rule.form} return due — ${taxYear}`,
    due_date: isExtended ? extendedDue : originalDue,
    tax_year: taxYear,
    period: 'annual',
    jurisdiction: 'federal',
    form: rule.form,
    extended: isExtended,
    note: fiscalNote,
  })

  // ── The extension deadline ───────────────────────────────────────────────
  // Only meaningful while the extension has NOT been filed; once it has, the
  // return row above already carries the extended date.
  if (!isExtended) {
    out.push({
      obligation_key: key([entity.id, 'extension', String(taxYear)]),
      entity_id: entity.id,
      kind: 'extension',
      title: `File ${rule.extForm} extension if needed — ${taxYear}`,
      due_date: originalDue,
      tax_year: taxYear,
      period: 'annual',
      jurisdiction: 'federal',
      form: rule.extForm,
      extended: false,
      note: fiscalNote,
    })
  }

  // ── Estimated tax ────────────────────────────────────────────────────────
  for (const est of ESTIMATED_RULES[ft] || []) {
    const y = est.nextYear ? taxYear + 1 : taxYear
    out.push({
      obligation_key: key([entity.id, 'estimated', String(taxYear), est.period]),
      entity_id: entity.id,
      kind: 'estimated_payment',
      title: `${est.period} ${taxYear} estimated tax payment`,
      due_date: nextBusinessDay(`${y}-${pad(est.month)}-${pad(est.day)}`),
      tax_year: taxYear,
      period: est.period,
      jurisdiction: 'federal',
      form: ft === '1040' ? '1040-ES' : '1120-W',
      extended: false,
    })
  }

  // ── Florida ──────────────────────────────────────────────────────────────
  const state = (entity.state || '').toUpperCase()
  if (state === 'FL' && ft !== '1040') {
    // Annual report with the Division of Corporations. Due May 1 every year
    // regardless of tax year, and late filing carries a flat $400 penalty for
    // corporations that cannot be waived — which is exactly why it belongs here.
    out.push({
      obligation_key: key([entity.id, 'fl_annual_report', String(taxYear + 1)]),
      entity_id: entity.id,
      kind: 'annual_report',
      title: `Florida annual report — ${taxYear + 1}`,
      due_date: `${taxYear + 1}-05-01`,
      tax_year: taxYear,
      period: 'annual',
      jurisdiction: 'FL',
      form: null,
      extended: false,
      note: 'Flat $400 late penalty for corporations. Not business-day adjusted — Sunbiz does not roll this date.',
    })

    // FL corporate income tax return. C-corps file; S-corps generally do not
    // unless they have federal taxable income, so it is flagged rather than
    // asserted.
    out.push({
      obligation_key: key([entity.id, 'fl_return', String(taxYear)]),
      entity_id: entity.id,
      kind: 'state_return',
      title: `Florida F-1120 corporate income tax — ${taxYear}`,
      due_date: nextBusinessDay(`${taxYear + 1}-05-01`),
      tax_year: taxYear,
      period: 'annual',
      jurisdiction: 'FL',
      form: 'F-1120',
      extended: false,
      note: ft === '1120S'
        ? 'S-corps generally do not file F-1120 unless they have federal taxable income. Confirm and dismiss if not applicable.'
        : fiscalNote,
    })
  }

  return out
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Days from `today` until `dueDate`. Negative means overdue. */
export function daysUntil(dueDate: string, today: string): number {
  const utc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)   // Date.UTC months are 0-indexed
  }
  return Math.round((utc(dueDate) - utc(today)) / 86_400_000)
}

export type ObligationUrgency = 'overdue' | 'due_soon' | 'upcoming' | 'done' | 'dismissed'

export function urgency(dueDate: string, today: string, status: string): ObligationUrgency {
  if (status === 'done') return 'done'
  if (status === 'dismissed') return 'dismissed'
  const d = daysUntil(dueDate, today)
  if (d < 0) return 'overdue'
  if (d <= 30) return 'due_soon'
  return 'upcoming'
}
