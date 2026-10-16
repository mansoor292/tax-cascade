/**
 * Schedule D (Form 1120-S) totals — lines 7 and 15, which ARE Schedule K
 * lines 7 and 8a.
 *
 * Why this exists (2026-10-16 blind test): Schedule K line 7 says "attach
 * Schedule D (Form 1120-S)", and the two disagreed by a dollar. The engine
 * took the short-term gain from the 1099-B import as one number — $147.65,
 * rounded to 148 — while the Schedule D printed beside it carried proceeds
 * 1,146,458 and cost 1,146,311 in whole dollars, whose difference is 147.
 * The filed return said 147 on both, because a form's columns are entered
 * in whole dollars and column (h) is (d) − (e) + (g) of what is printed:
 * a Schedule D whose gain column is not the difference of its own columns
 * does not foot. The extra dollar ran through Schedule K line 18, M-1, the
 * K-1, and on the shareholder's 1040 Schedule D and Form 7203.
 *
 * So when a return carries a Schedule D, the schedule decides lines 7 and
 * 8a, and a row's gain is the difference of its rounded columns unless the
 * row states its own.
 */

export type ScheduleDRow = { proceeds?: number; cost?: number; adjustments?: number; gain?: number }

export interface ScheduleD1120SData {
  rows?: Partial<Record<'L1a' | 'L1b' | 'L2' | 'L3' | 'L8a' | 'L8b' | 'L9' | 'L10', ScheduleDRow>>
  L4?: number; L5?: number; L6?: number; L7?: number
  L11?: number; L12?: number; L13?: number; L14?: number; L15?: number
  [k: string]: unknown
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)

/** Column (h) of one row: stated, or (d) − (e) + (g) in whole dollars. */
export function scheduleDRowGain(r: ScheduleDRow | undefined): number | undefined {
  if (!r) return undefined
  if (num(r.gain) !== undefined) return r.gain
  if (num(r.proceeds) === undefined && num(r.cost) === undefined) return undefined
  return Math.round(r.proceeds || 0) - Math.round(r.cost || 0) + Math.round(r.adjustments || 0)
}

const ST_ROWS = ['L1a', 'L1b', 'L2', 'L3'] as const
const LT_ROWS = ['L8a', 'L8b', 'L9', 'L10'] as const

/**
 * Lines 7 and 15, or null when the object states nothing in Parts I and II
 * (a Schedule D carrying only Part III must not zero Schedule K's gains).
 */
export function scheduleD1120STotals(d: unknown): { L7: number; L15: number } | null {
  if (!d || typeof d !== 'object') return null
  const s = d as ScheduleD1120SData
  const rows = s.rows || {}
  const stated = [...ST_ROWS, ...LT_ROWS].some(k => scheduleDRowGain(rows[k]) !== undefined)
    || ['L4', 'L5', 'L6', 'L7', 'L11', 'L12', 'L13', 'L14', 'L15'].some(k => num(s[k]) !== undefined)
  if (!stated) return null
  const sum = (keys: readonly string[]) => keys.reduce((t, k) => t + (scheduleDRowGain(rows[k as keyof typeof rows]) || 0), 0)
  const L7 = num(s.L7) ?? (sum(ST_ROWS) + (num(s.L4) || 0) + (num(s.L5) || 0) - (num(s.L6) || 0))
  const L15 = num(s.L15) ?? (sum(LT_ROWS) + (num(s.L11) || 0) + (num(s.L12) || 0) + (num(s.L13) || 0) - (num(s.L14) || 0))
  return { L7, L15 }
}
