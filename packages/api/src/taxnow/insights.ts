/**
 * Findings read from the returns, beside the account transcripts.
 *
 * Port of ~/taxnow-data/tools/insights.py (2026-10-24, 102 return transcripts
 * of 29 business clients). Each rule reads a ReturnProfile — one row per
 * client and year — so the same rule runs whatever the return came from: an
 * IRS return transcript (profileFromRetr, here) or a return held in Catipult
 * (profileFromFieldValues, reading golden keys).
 *
 * The lead finding of the prototype: retention-credit refunds booked as
 * "other income" in the year they arrived (11 client-years, $4.6M in one
 * org). The credit reduces wages of the year paid (2020/2021) instead; which
 * year is right, and whether amending pays, depends on which years are open,
 * so it is labelled "review", not money.
 */

export interface ReturnProfile {
  form: string              // 1120 | 1120S | 1065
  taxYear: number
  source: 'irs_return_transcript' | 'catipult_return'
  receivedDate?: string | null
  gross_receipts?: number | null
  other_income?: number | null
  officer_comp?: number | null
  ordinary_income?: number | null
  taxable_income?: number | null
  nol_deduction?: number | null
  nol_carryover?: number | null
  total_tax?: number | null
  es_penalty?: number | null
  k_income?: number | null
  distributions?: number | null
  m2_boy?: number | null
  loans_to_shareholders?: number | null
  gbc_carryforward?: number | null
  gbc_allowed?: number | null
  owners?: number | null
}

type ProfileField = Exclude<keyof ReturnProfile, 'form' | 'taxYear' | 'source' | 'receivedDate'>

// The IRS names a line differently per form; each field lists the names it
// takes, first match wins. Amounts in cents; owners is a count.
const PROFILE: Record<ProfileField, string[]> = {
  gross_receipts: ['Gross Receipts', 'Gross Receipts or Sales'],
  other_income: ['Other Income'],
  officer_comp: ['Compensation of Officers'],
  ordinary_income: ['Ordinary Income/Loss', 'Ordinary Income (Loss)'],
  taxable_income: ['Taxable Income Per Computer'],
  nol_deduction: ['Net Operating Loss Deduction'],
  nol_carryover: ['Schedule K Net Operating Loss Carryover Prior Tax Years'],
  total_tax: ['Total Income Tax', 'Tax Shown on Return'],
  es_penalty: ['Estimated Tax Penalty'],
  k_income: ['Income (Loss)'],
  distributions: ['Total Property Distribution'],
  m2_boy: ['Schedule M-2: Balance at Beginning of Tax Year'],
  loans_to_shareholders: ['Loans to Shareholders End of Tax Year', 'Loans to Shareholders End of Year'],
  gbc_carryforward: ['Carryforward General Business Credit'],
  gbc_allowed: ['Allowable Credit'],
  owners: ['Number of Shareholders', 'Number of Partners'],
}

export interface RetrJson {
  form: string
  year: string | number
  sections?: Array<{ name: string; items?: Array<{ key: string; value: string }> }>
}

function centsOf(v: string | undefined): number | null {
  if (v == null) return null
  const s = v.trim()
  const m = /^(-?)\$?([\d,]+(?:\.\d{2})?)$/.exec(s)
  if (!m) return null
  return (m[1] ? -1 : 1) * Math.round(parseFloat(m[2].replace(/,/g, '')) * 100)
}

/** One IRS return transcript (TaxNow's RETR JSON) → a profile row. */
export function profileFromRetr(r: RetrJson): ReturnProfile {
  const by = new Map<string, string>()
  for (const s of r.sections ?? []) for (const it of s.items ?? []) if (!by.has(it.key.trim())) by.set(it.key.trim(), it.value)
  const p: ReturnProfile = { form: r.form, taxYear: Number(r.year), source: 'irs_return_transcript' }
  for (const [field, names] of Object.entries(PROFILE) as Array<[ProfileField, string[]]>) {
    for (const n of names) {
      if (!by.has(n)) continue
      const raw = by.get(n)!
      const v = field === 'owners' ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null) : centsOf(raw)
      if (v != null) { p[field] = v; break }
    }
  }
  const rec = by.get('Received Date')
  const m = rec && /(\d{2})-(\d{2})-(\d{4})/.exec(rec)
  p.receivedDate = m ? `${m[3]}-${m[1]}-${m[2]}` : null
  return p
}

export type InsightType =
  | 'erc_refund_as_income' | 'low_officer_pay' | 'distributions_over_income' | 'shareholder_loan'
  | 'nol_carryover' | 'credit_carryforward' | 'es_penalty_safe_harbor' | 'irs_tax_differs' | 'revenue_swing'
export type Severity = 'review' | 'opportunity' | 'risk' | 'info'

export interface Insight {
  section: 'income' | 'risk'
  type: InsightType
  severity: Severity
  form: string
  taxYear: number
  amountCents: number | null
  note: string
}

const $ = (c: number | null | undefined) => '$' + Math.round((c ?? 0) / 100).toLocaleString('en-US')

export interface InsightContext {
  /** Retention-credit refunds received per calendar year (cents). */
  retentionRefunds: Map<number, number>
  /** Estimated payments on the income account by Dec 15 of each year (cents, positive). */
  estimatesByDec15: Map<number, number>
  /** TC 150 tax per year on the income account (cents). */
  assessedTax: Map<number, number>
  /** A second return (TC 976) posted 2022+: a transcript year may hold another year's return. */
  secondReturnPosted: boolean
}

export function findInsights(profiles: ReturnProfile[], ctx: InsightContext): Insight[] {
  const out: Insight[] = []
  const byYear = new Map(profiles.map(p => [p.taxYear, p]))
  const add = (p: ReturnProfile, type: InsightType, severity: Severity, amountCents: number | null, note: string) => {
    const section = severity === 'risk' || severity === 'info' ? 'risk' : 'income'
    out.push({ section, type, severity, form: p.form, taxYear: p.taxYear, amountCents, note: note + (ctx.secondReturnPosted ? ' A second return (TC 976) posted to this account from 2022 on: check this year holds the right return.' : '') })
  }
  for (const p of profiles) {
    const y = p.taxYear
    const rec = ctx.retentionRefunds.get(y) ?? 0
    const other = p.other_income ?? 0
    if (rec >= 1_000_000 && other >= 0.5 * rec) {
      add(p, 'erc_refund_as_income', 'review', Math.min(other, rec), `Retention-credit refunds received in ${y}: ${$(rec)}; other income on the ${y} return: ${$(other)}. Booked as income when received; the credit reduces wages of the year paid (2020/2021). Which year is right, and whether amending pays, depends on which years are open.`)
    }
    if (p.form === '1120S') {
      const dist = p.distributions ?? 0, off = p.officer_comp ?? 0, oi = p.ordinary_income ?? 0
      if (dist > 0 && oi > 5_000_000 && (off === 0 || off < 0.1 * dist)) {
        add(p, 'low_officer_pay', 'risk', dist, `Distributions ${$(dist)}, officer pay ${$(off)}, ordinary income ${$(oi)}: reasonable-compensation exposure.`)
      }
      const kinc = p.k_income ?? 0, m2 = Math.max(p.m2_boy ?? 0, 0)
      if (dist > 0 && dist > kinc + m2 + 100_000) {
        add(p, 'distributions_over_income', 'risk', dist - kinc - m2, `Distributions ${$(dist)} vs Schedule K income ${$(kinc)} plus the M-2 opening balance ${$(m2)}: check basis and whether part is taxable.`)
      }
    }
    if ((p.loans_to_shareholders ?? 0) > 0) {
      add(p, 'shareholder_loan', 'risk', p.loans_to_shareholders!, 'Loans to shareholders at year end. Document them as loans (note, interest, repayments) or they read as distributions.')
    }
    if ((p.nol_carryover ?? 0) > 0) add(p, 'nol_carryover', 'opportunity', p.nol_carryover!, `Net operating loss carried over; used this year: ${$(p.nol_deduction)}.`)
    if ((p.gbc_carryforward ?? 0) > 0) add(p, 'credit_carryforward', 'opportunity', p.gbc_carryforward!, `General business credit carried forward; allowed this year: ${$(p.gbc_allowed)}.`)
    const esp = p.es_penalty ?? 0
    if (esp > 0) {
      const prior = byYear.get(y - 1)
      const priorTax = prior?.total_tax ?? null
      const est = ctx.estimatesByDec15.get(y) ?? 0
      const large = (prior?.taxable_income ?? 0) >= 100_000_000
      // A corporation cannot use the prior-year safe harbor when the prior year showed no tax.
      if (priorTax && priorTax > 0 && est >= priorTax && !large) {
        add(p, 'es_penalty_safe_harbor', 'opportunity', esp, `Estimated-tax penalty ${$(esp)}; estimates by Dec 15 ${$(est)} reached the prior-year tax ${$(priorTax)}. Check the installment timing.`)
      }
    }
    const tc150 = ctx.assessedTax.get(y)
    if (tc150 != null && p.total_tax != null && Math.abs(tc150 - p.total_tax) > 10_000) {
      add(p, 'irs_tax_differs', 'review', tc150 - p.total_tax, `TC 150 ${$(tc150)} vs ${$(p.total_tax)} on the return.`)
    }
    const prev = byYear.get(y - 1)
    if (prev && (prev.gross_receipts ?? 0) > 10_000_000 && p.gross_receipts != null) {
      const ch = (p.gross_receipts - prev.gross_receipts!) / prev.gross_receipts!
      if (Math.abs(ch) > 0.5) add(p, 'revenue_swing', 'info', p.gross_receipts - prev.gross_receipts!, `Gross receipts ${$(prev.gross_receipts)} → ${$(p.gross_receipts)} (${ch > 0 ? '+' : ''}${Math.round(ch * 100)}%).`)
    }
  }
  return out.sort((a, b) => a.taxYear - b.taxYear || a.type.localeCompare(b.type))
}
