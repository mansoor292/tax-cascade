/**
 * Pure helpers for the all-sources view (SourcesView.tsx), tested without a
 * browser.
 */
import type { GoldenRow, GoldenValue } from '@/hooks/use-golden'

const SCHED: Record<string, string> = {
  f1040s1: 'Schedule 1', f1040s2: 'Schedule 2', f1040s3: 'Schedule 3', f1040sa: 'Schedule A', f1040sb: 'Schedule B',
  f1040sc: 'Schedule C', f1040sd: 'Schedule D', f1040se: 'Schedule E', f1040sse: 'Schedule SE', f1040s8: 'Schedule 8812',
  f1120ssk: 'Schedule K-1 (1120-S)', f1120ssd: '1120-S Schedule D', f1065sk1: 'Schedule K-1 (1065)',
  f1120sg: '1120 Schedule G', f1120so: '1120 Schedule O', f1120sh: '1120 Schedule H',
}

/** "f1120s" → "1120-S", "f1125a" → "1125-A", "f1040se" → "Schedule E". */
export function formTitle(form: string): string {
  if (SCHED[form]) return SCHED[form]
  const m = /^f(\d{3,4})([a-z]*)$/.exec(form)
  if (!m) return form
  const [, num, suffix] = m
  if (num === '1120' && suffix === 's') return '1120-S'
  return suffix ? `${num}-${suffix.toUpperCase()}` : num
}

/** Where a row sits: "1120-S Schedule L line 24 (d)". */
export function lineRef(r: Pick<GoldenRow, 'form' | 'section' | 'line' | 'col'>): string {
  return `${formTitle(r.form)}${r.section ? ` ${r.section}` : ''}${r.line ? ` line ${r.line}` : ''}${r.col ? ` (${r.col})` : ''}`
}

/** The IRS's description up to its first sentence. */
export function shortLabel(label: string): string {
  const first = label.split(/(?<=[a-z)])\. /)[0]
  return first.length > 90 ? `${first.slice(0, 89)}…` : first
}

/** "proforma 2026-10-15 (815a9144)" → "Proforma 10/15/2026". */
export function sourceLabel(label: string): string {
  const m = /^(\w[\w_]*)\s+(\d{4})-(\d{2})-(\d{2})/.exec(label)
  const name = (m ? m[1] : label.replace(/\s*\([0-9a-f]{8}\)$/, '')).replace(/_/g, ' ')
  const cap = name.charAt(0).toUpperCase() + name.slice(1)
  return m ? `${cap} ${m[3]}/${m[4]}/${m[2]}` : cap
}

const near = (a: GoldenValue | undefined, b: GoldenValue | undefined) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1 : String(a ?? '') === String(b ?? '')

/** A row worth looking at: the sources disagree somewhere. Scenarios are
 *  meant to differ, so they never make a row "different". */
export function hasDifference(r: GoldenRow): boolean {
  if (r.status === 'differs' || r.status === 'irs_only' || r.status === 'irs_recomputed' || r.books_differs || r.documents_differs) return true
  if (r.golden === undefined) return false
  return Object.values(r.returns ?? {}).some(c => !near(c.value, r.golden))
}

/** Does this cell disagree with the golden value? */
export function offGolden(v: GoldenValue | undefined, golden: GoldenValue | undefined): boolean {
  return v !== undefined && golden !== undefined && !near(v, golden)
}
