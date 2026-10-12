/**
 * Form 1040 supporting schedules, as data.
 *
 * calc1040 computed the face of the return and nothing behind it. Schedules
 * 1, 2, 3, B and D and Forms 8949, 8959, 8960 and 8995-A existed only as
 * single figures folded into a 1040 line, so an export of a computed return
 * could not say where line 8 came from, which payers made up line 2b, or how
 * the 0.9% and 3.8% taxes on line 23 were reached. Preparing the 2025 joint
 * return meant rebuilding every one of them by hand from W-2s and a broker
 * statement — and the face lines were wrong in places too:
 *
 *  - 1040 line 8 carried schedule1_income only, so K-1 ordinary income (which
 *    IS Schedule 1 line 5) was in line 9's total and missing from line 8.
 *  - Net investment income netted a capital LOSS against interest and
 *    dividends. Form 8960 line 5a is the net gain, never below zero.
 *  - A net capital loss reached line 7 uncapped; §1211(b) allows 3,000.
 *  - Additional Medicare tax ran on box 1 wages; Form 8959 uses box 5, and
 *    the 0.9% an employer already withheld (line 24 → 1040 line 25c) was never
 *    credited.
 *  - Two employers each withholding social security on a full wage base
 *    produced no excess-SS credit (Schedule 3 line 11).
 *  - A payment sent with Form 4868 had nowhere to go except "estimated
 *    payments", which is a different line (26 vs Schedule 3 line 10) and
 *    counts as timely for Form 2210 when it is not.
 *
 * This module turns the caller's source documents into those schedules. Every
 * structured input is optional; a caller that still sends only the scalar
 * fields gets the same answer as before apart from the corrections above.
 */

import { SS_WAGE_BASE } from './tax_tables.js'

export interface W2Input {
  /** Whose W-2 — matters only for the excess social security credit, which is per person. */
  owner?: 'taxpayer' | 'spouse'
  employer?: string
  box1: number
  box2: number
  box3?: number
  box4?: number
  box5?: number
  box6?: number
}

export interface DetailItem {
  label: string
  amount: number
  /** Dividends only: the qualified portion (1099-DIV box 1b). */
  qualified?: number
  /** Other income only: counts as net investment income (e.g. 1099-MISC box 8). */
  investment?: boolean
}

export interface CapitalTransaction {
  label: string
  proceeds: number
  basis: number
  /** Form 8949 column (g). */
  adjustment?: number
  term: 'short' | 'long'
  /** Form 8949 box: A/B/C short-term, D/E/F long-term. Defaults to A or D. */
  box?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
}

export interface K1PortfolioItems {
  name?: string
  interest?: number
  ordinary_dividends?: number
  qualified_dividends?: number
  st_gain?: number
  lt_gain?: number
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(x) ? x : 0
}
const r = (x: number) => Math.round(x)
const sum = <T>(xs: T[] | undefined, f: (x: T) => number) => (xs || []).reduce((t, x) => t + f(x), 0)

/** W-2 roll-up: line 1a/25a, Form 8959 Part I/V, and Schedule 3 line 11. */
export function summarizeW2s(w2s: W2Input[] | undefined, year: number) {
  const list = Array.isArray(w2s) ? w2s : []
  const wages = sum(list, w => n(w.box1))
  const withholding = sum(list, w => n(w.box2))
  const medicareWages = sum(list, w => n(w.box5 ?? w.box1))
  const medicareWithheld = sum(list, w => n(w.box6))
  // Form 8959 Part V: what each employer withheld beyond the 1.45% regular rate.
  const regularMedicare = r(medicareWages * 0.0145)
  const addlMedicareWithheld = Math.max(0, r(medicareWithheld - regularMedicare))

  // Excess social security: per person, only when more than one employer, and
  // only for amounts above 6.2% of the wage base. One employer over-withholding
  // is that employer's refund to make, not a credit on the return.
  const cap = r((SS_WAGE_BASE[year] ?? 176100) * 0.062)
  let excessSS = 0
  for (const owner of ['taxpayer', 'spouse'] as const) {
    const mine = list.filter(w => (w.owner ?? 'taxpayer') === owner)
    if (mine.length < 2) continue
    excessSS += Math.max(0, r(sum(mine, w => n(w.box4))) - cap)
  }
  return { count: list.length, wages: r(wages), withholding: r(withholding), medicareWages: r(medicareWages),
    medicareWithheld: r(medicareWithheld), regularMedicare, addlMedicareWithheld, excessSS }
}

/** Schedule D / Form 8949 from transactions plus K-1 gains, with the §1211(b) limit. */
export function scheduleD(
  txns: CapitalTransaction[] | undefined,
  k1: K1PortfolioItems | undefined,
  filingStatus: string,
) {
  const list = Array.isArray(txns) ? txns : []
  const gain = (t: CapitalTransaction) => n(t.proceeds) - n(t.basis) + n(t.adjustment)
  const boxOf = (t: CapitalTransaction) => t.box ?? (t.term === 'long' ? 'D' : 'A')
  const rows: Record<string, { proceeds: number; basis: number; adj: number; gain: number }> = {}
  for (const t of list) {
    // Box A/D with no adjustment goes straight on Schedule D line 1a/8a
    // without Form 8949; anything else goes through 8949 to its line.
    const b = boxOf(t)
    const adj = n(t.adjustment)
    const line = b === 'A' ? (adj ? '1b' : '1a') : b === 'B' ? '2' : b === 'C' ? '3'
      : b === 'D' ? (adj ? '8b' : '8a') : b === 'E' ? '9' : '10'
    const row = rows[line] ||= { proceeds: 0, basis: 0, adj: 0, gain: 0 }
    row.proceeds += n(t.proceeds); row.basis += n(t.basis); row.adj += adj; row.gain += gain(t)
  }
  const st = sum(Object.entries(rows).filter(([l]) => ['1a', '1b', '2', '3'].includes(l)), ([, v]) => v.gain)
  const lt = sum(Object.entries(rows).filter(([l]) => ['8a', '8b', '9', '10'].includes(l)), ([, v]) => v.gain)
  const k1st = n(k1?.st_gain), k1lt = n(k1?.lt_gain)
  const netST = r(st + k1st)                 // line 7
  const netLT = r(lt + k1lt)                 // line 15
  const total = netST + netLT                // line 16
  const limit = filingStatus === 'mfs' ? 1500 : 3000
  const allowed = total < 0 ? Math.max(total, -limit) : total   // line 21 / 1040 line 7
  // Gain taxed at preferential rates (Schedule D line 15 vs 16 worksheet).
  const netCapitalGain = total > 0 && netLT > 0 ? Math.min(netLT, total) : 0
  const fv: Record<string, number> = {}
  for (const [line, v] of Object.entries(rows)) {
    fv[`schedD.L${line}_proceeds_d`] = r(v.proceeds)
    fv[`schedD.L${line}_basis_e`] = r(v.basis)
    if (v.adj) fv[`schedD.L${line}_adjustment_g`] = r(v.adj)
    fv[`schedD.L${line}_gain_h`] = r(v.gain)
  }
  if (k1st) fv['schedD.L5_k1_st_gain'] = r(k1st)
  fv['schedD.L7_net_short_term'] = netST
  if (k1lt) fv['schedD.L12_k1_lt_gain'] = r(k1lt)
  fv['schedD.L15_net_long_term'] = netLT
  fv['schedD.L16_total'] = total
  if (total < 0) {
    fv['schedD.L21_loss_allowed'] = allowed
    fv['schedD.loss_carryover'] = total - allowed
  }
  return { lineAmount: allowed, total, netST, netLT, netCapitalGain, fv, any: list.length > 0 || !!k1st || !!k1lt }
}
