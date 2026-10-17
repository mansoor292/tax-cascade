/**
 * A form's own arithmetic, checked against its catalog.
 *
 * "Complete" proves nothing was lost, not that each value sits on the right
 * line. The form's arithmetic does: if line 22 were read into the wrong box,
 * "22 = 6 − 21" breaks. So every catalog is checked against its forms' ties,
 * and a broken tie is either a cataloguing error (fix the cataloguer) or the
 * filer's own arithmetic error (a finding). Either way someone must look.
 *
 * Terms are `[section:]line[.col]`, e.g. `22`, `Schedule L:15.d`,
 * `Schedule M-2:8.a`. A blank box counts as 0; a tie with no term present at
 * all is skipped (the form part wasn't used).
 */
import type { CatalogEntry } from './types.js'

export interface Tie {
  form: string
  /** inclusive revision range; omit for all */
  revs?: [number, number]
  /** "22 = 6 - 21" */
  expr: string
  note?: string
}

const sum = (from: number, to: number, skip: number[] = []) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).filter(n => !skip.includes(n)).join(' + ')

export const TIES: Tie[] = [
  // ── Form 1120-S. The 2023 revision added line 19 (energy-efficient buildings),
  //    moving total deductions to 21 and ordinary income to 22.
  { form: 'f1120s', expr: '1c = 1a - 1b' },
  { form: 'f1120s', expr: '3 = 1c - 2' },
  { form: 'f1120s', expr: '6 = 3 + 4 + 5' },
  { form: 'f1120s', revs: [2023, 2099], expr: `21 = ${sum(7, 20)}` },
  { form: 'f1120s', revs: [2023, 2099], expr: '22 = 6 - 21' },
  { form: 'f1120s', revs: [2018, 2022], expr: `20 = ${sum(7, 19)}` },
  { form: 'f1120s', revs: [2018, 2022], expr: '21 = 6 - 20' },
  { form: 'f1120s', expr: 'Schedule L:15.d = Schedule L:27.d', note: 'balance sheet balances (end of year)' },
  { form: 'f1120s', expr: 'Schedule L:15.b = Schedule L:27.b', note: 'balance sheet balances (beginning of year)' },
  { form: 'f1120s', expr: 'Schedule M-2:6.a = Schedule M-2:1.a + Schedule M-2:2.a + Schedule M-2:3.a - Schedule M-2:4.a - Schedule M-2:5.a' },
  { form: 'f1120s', expr: 'Schedule M-2:8.a = Schedule M-2:6.a - Schedule M-2:7.a' },
  // ── Form 1120
  { form: 'f1120', expr: '1c = 1a - 1b' },
  { form: 'f1120', expr: '3 = 1c - 2' },
  { form: 'f1120', expr: `11 = ${sum(3, 10)}` },
  { form: 'f1120', expr: `27 = ${sum(12, 26)}` },
  { form: 'f1120', expr: '28 = 11 - 27' },
  { form: 'f1120', expr: '29c = 29a + 29b' },
  { form: 'f1120', expr: '30 = 28 - 29c' },
  { form: 'f1120', expr: 'Schedule L:15.d = Schedule L:28.d', note: 'balance sheet balances (end of year)' },
  { form: 'f1120', expr: 'Schedule L:15.b = Schedule L:28.b', note: 'balance sheet balances (beginning of year)' },
  // ── Form 1040 (2021–2024 numbering)
  { form: 'f1040', revs: [2021, 2024], expr: '11 = 9 - 10' },
  { form: 'f1040', revs: [2021, 2024], expr: '14 = 12 + 13' },
  { form: 'f1040', revs: [2021, 2024], expr: '15 = 11 - 14' },
  { form: 'f1040', revs: [2021, 2024], expr: '18 = 16 + 17' },
  { form: 'f1040', revs: [2021, 2024], expr: '22 = 18 - 21' },
  { form: 'f1040', revs: [2021, 2024], expr: '24 = 22 + 23' },
  { form: 'f1040', revs: [2021, 2025], expr: '25d = 25a + 25b + 25c' },
  { form: 'f1040', revs: [2021, 2025], expr: '33 = 25d + 26 + 32' },
  // ── Form 1040 (2025 numbering: AGI on 11a/11b, deductions 12e/13a/13b)
  { form: 'f1040', revs: [2025, 2025], expr: '11a = 9 - 10' },
  { form: 'f1040', revs: [2025, 2025], expr: '14 = 12e + 13a + 13b' },
  { form: 'f1040', revs: [2025, 2025], expr: '15 = 11b - 14' },
  { form: 'f1040', revs: [2025, 2025], expr: '18 = 16 + 17' },
  { form: 'f1040', revs: [2025, 2025], expr: '21 = 19 + 20' },
  { form: 'f1040', revs: [2025, 2025], expr: '22 = 18 - 21' },
  { form: 'f1040', revs: [2025, 2025], expr: '24 = 22 + 23' },
  // ── Form 1125-A
  { form: 'f1125a', expr: '6 = 1 + 2 + 3 + 4 + 5' },
  { form: 'f1125a', expr: '8 = 6 - 7' },
  // ── Form 8960 (individual)
  { form: 'f8960', expr: '17 = 16 * 0.038', note: '3.8% of the smaller of NII and MAGI over the threshold' },
]

interface Term { sign: 1 | -1; factor: number; section: string; line: string; col?: string }

function parseSide(side: string): Term[] {
  const out: Term[] = []
  const re = /([+-]?)\s*([^+\-*]+?)(?:\s*\*\s*([\d.]+))?\s*(?=[+-]|$)/g
  let m: RegExpExecArray | null
  const s = side.trim()
  while ((m = re.exec(s)) && m[0]) {
    const sign = m[1] === '-' ? -1 : 1
    const ref = m[2].trim()
    const factor = m[3] ? Number(m[3]) : 1
    const [section, rest] = ref.includes(':') ? ref.split(':') : ['', ref]
    const [line, col] = rest.split('.')
    out.push({ sign, factor, section: section.trim(), line: line.trim(), col: col?.trim() })
  }
  return out
}

export interface TieResult {
  form: string
  rev: string
  instance: string
  expr: string
  ok: boolean
  left: number
  right: number
  difference: number
  note?: string
}

/** Evaluate every applicable tie over a catalog's entries. Blank boxes are 0;
 *  ties with no term present are skipped. Rounding tolerance: $1 per term
 *  (filers round each line). */
export function checkTies(entries: CatalogEntry[], ties: Tie[] = TIES): TieResult[] {
  const groups = new Map<string, CatalogEntry[]>()
  for (const e of entries) {
    if (e.kind !== 'amount' || e.form === 'statement' || e.section === '(unassigned)') continue
    const k = `${e.form}|${e.rev}|${e.instance}`
    const l = groups.get(k)
    if (l) l.push(e)
    else groups.set(k, [e])
  }
  const results: TieResult[] = []
  for (const [k, es] of groups) {
    const [form, rev, instance] = k.split('|')
    const r = Number(rev)
    const lookup = (t: Term): number | undefined => {
      const hit = es.find(e =>
        e.line.toLowerCase() === t.line.toLowerCase() &&
        (t.section ? e.section === t.section : !e.section || e.section === '') &&
        (t.col ? (e.col ?? '') === t.col : !e.col),
      )
      return hit && typeof hit.value === 'number' ? hit.value : undefined
    }
    for (const tie of ties) {
      if (tie.form !== form) continue
      if (tie.revs && (!Number.isFinite(r) || r < tie.revs[0] || r > tie.revs[1])) continue
      const [lhs, rhs] = tie.expr.split('=').map(parseSide)
      const terms = [...lhs, ...rhs]
      const vals = terms.map(lookup)
      if (vals.every(v => v === undefined)) continue
      const side = (ts: Term[], off: number) => ts.reduce((s, t, i) => s + t.sign * t.factor * (vals[off + i] ?? 0), 0)
      const left = side(lhs, 0)
      const right = side(rhs, lhs.length)
      const difference = Math.round((left - right) * 100) / 100
      const tol = Math.max(1, terms.length * 0.5) + (tie.expr.includes('*') ? 1 : 0)
      results.push({ form, rev, instance, expr: tie.expr, ok: Math.abs(difference) <= tol, left, right, difference, ...(tie.note ? { note: tie.note } : {}) })
    }
  }
  return results
}
