/**
 * Deterministic bank ↔ QBO reconciler
 *
 * Three-tier matching. Each tier only considers QBO transactions that
 * haven't been matched by an earlier tier (greedy — each QBO txn matches
 * at most one bank row and vice versa).
 *
 *   Tier 1 "exact":  same date, same amount
 *   Tier 2 "near":   same amount, date within ±3 days
 *   Tier 3 "fuzzy":  same amount, description token overlap ≥ 2, ±7 days
 *
 * Amounts must match exactly to the cent after sign normalization.
 * QBO 'Purchase' / 'Expense' transactions are negative on a bank feed;
 * 'Deposit' / 'Payment' are positive. The reconciler compares signed
 * amounts so a $-100 bank row only matches $-100 QBO rows.
 */
import type { BankTxn } from './bank_csv_parser.js'

export interface QboTxn {
  id: string
  date: string        // YYYY-MM-DD
  amount: number      // signed
  description: string
  txn_type: string    // 'Purchase' | 'Deposit' | 'JournalEntry' | ...
}

export interface Match {
  bank_row: BankTxn
  qbo_txn: QboTxn
  confidence: 'exact' | 'near' | 'fuzzy'
  delta_days: number
  token_overlap?: number
}

export interface ReconcileResult {
  matched: Match[]
  missing_in_qbo: BankTxn[]   // bank rows without a QBO match
  missing_in_bank: QboTxn[]   // QBO rows without a bank match
}

function daysBetween(a: string, b: string): number {
  const ad = new Date(a + 'T00:00:00Z').getTime()
  const bd = new Date(b + 'T00:00:00Z').getTime()
  return Math.abs((ad - bd) / (1000 * 60 * 60 * 24))
}

function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005  // tolerant of $0.005 rounding
}

/** Extract word-like tokens from a description for fuzzy matching. */
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
     .replace(/[^a-z0-9 ]/g, ' ')
     .split(/\s+/)
     .filter(t => t.length >= 3 && !/^\d+$/.test(t))
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}

export function reconcile(bank: BankTxn[], qbo: QboTxn[]): ReconcileResult {
  const matched: Match[] = []
  const usedBank = new Set<number>()
  const usedQbo = new Set<number>()

  // Tier 1 — exact
  for (let i = 0; i < bank.length; i++) {
    if (usedBank.has(i)) continue
    for (let j = 0; j < qbo.length; j++) {
      if (usedQbo.has(j)) continue
      if (bank[i].date === qbo[j].date && amountsEqual(bank[i].amount, qbo[j].amount)) {
        matched.push({ bank_row: bank[i], qbo_txn: qbo[j], confidence: 'exact', delta_days: 0 })
        usedBank.add(i); usedQbo.add(j)
        break
      }
    }
  }

  // Tier 2 — near (amount match, ±3d)
  for (let i = 0; i < bank.length; i++) {
    if (usedBank.has(i)) continue
    let best = -1, bestDays = 999
    for (let j = 0; j < qbo.length; j++) {
      if (usedQbo.has(j)) continue
      if (!amountsEqual(bank[i].amount, qbo[j].amount)) continue
      const dd = daysBetween(bank[i].date, qbo[j].date)
      if (dd <= 3 && dd < bestDays) { best = j; bestDays = dd }
    }
    if (best >= 0) {
      matched.push({ bank_row: bank[i], qbo_txn: qbo[best], confidence: 'near', delta_days: bestDays })
      usedBank.add(i); usedQbo.add(best)
    }
  }

  // Tier 3 — fuzzy (amount match, token overlap ≥2, ±7d)
  for (let i = 0; i < bank.length; i++) {
    if (usedBank.has(i)) continue
    const bankTokens = tokens(bank[i].description)
    let best = -1, bestOverlap = 0, bestDays = 999
    for (let j = 0; j < qbo.length; j++) {
      if (usedQbo.has(j)) continue
      if (!amountsEqual(bank[i].amount, qbo[j].amount)) continue
      const dd = daysBetween(bank[i].date, qbo[j].date)
      if (dd > 7) continue
      const o = overlap(bankTokens, tokens(qbo[j].description))
      if (o >= 2 && (o > bestOverlap || (o === bestOverlap && dd < bestDays))) {
        best = j; bestOverlap = o; bestDays = dd
      }
    }
    if (best >= 0) {
      matched.push({ bank_row: bank[i], qbo_txn: qbo[best], confidence: 'fuzzy', delta_days: bestDays, token_overlap: bestOverlap })
      usedBank.add(i); usedQbo.add(best)
    }
  }

  const missing_in_qbo = bank.filter((_, i) => !usedBank.has(i))
  const missing_in_bank = qbo.filter((_, j) => !usedQbo.has(j))

  return { matched, missing_in_qbo, missing_in_bank }
}
