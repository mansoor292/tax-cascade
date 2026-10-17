/**
 * Both ends of a K-1, read from catalogs.
 *
 * Recipient side: each row of the 1040's Schedule E Part II line 28 (name,
 * P/S, EIN, passive and nonpassive columns). Issuer side: each K-1 the S
 * corporation issued (its own return's K-1 pages). Linking the two is by EIN,
 * because the 1040 itself prints the issuer's EIN — a documented link, never
 * an assumption from two entities sharing an account.
 */
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView } from './types.js'
import { formEntries, find, amount, k1Codes } from './lookup.js'

export interface ScheduleERow {
  row: string               // A, B, C, D
  name: string
  type: string              // 'S' | 'P'
  ein: string               // as printed (digits only)
  passive_loss: number      // (g)
  passive_income: number    // (h)
  nonpassive_loss: number   // (i)
  sec179: number            // (j)
  nonpassive_income: number // (k)
  basis_required: boolean   // (e)
  entries: CatalogEntry[]
}

/** Rows of Schedule E Part II line 28 (A–D) that carry a name. */
export function scheduleERows(cat: CatalogView | undefined): ScheduleERow[] {
  const es = formEntries(cat, 'f1040se').filter(e => e.section === 'Part II' && e.line === '28' && e.row)
  const rows = new Map<string, CatalogEntry[]>()
  for (const e of es) rows.set(e.row!, [...(rows.get(e.row!) ?? []), e])
  const val = (list: CatalogEntry[], col: string) => {
    const e = list.find(x => x.col === col)
    return typeof e?.value === 'number' ? e.value : 0
  }
  const txt = (list: CatalogEntry[], col: string) => String(list.find(x => x.col === col)?.raw ?? '').trim()
  const out: ScheduleERow[] = []
  for (const [row, list] of [...rows.entries()].sort()) {
    const name = txt(list, 'a')
    if (!name) continue
    out.push({
      row, name, type: txt(list, 'b').toUpperCase(), ein: txt(list, 'd').replace(/\D/g, ''),
      passive_loss: val(list, 'g'), passive_income: val(list, 'h'), nonpassive_loss: val(list, 'i'),
      sec179: val(list, 'j'), nonpassive_income: val(list, 'k'),
      basis_required: list.some(x => x.col === 'e' && x.kind === 'check' && x.value === true),
      entries: list,
    })
  }
  return out
}

export interface IssuedK1 {
  instance: string
  shareholder: string
  pct: number | undefined
  box: Record<string, number>          // '1', '2', '4', '5a', '7', '8a', '9', '10', '11', '12' …
  codes: Record<string, Array<{ code: string; amount: number | null }>> // '12', '13', '16', '17'
  itemI: { beginning?: number; end?: number }
  itemsBlank: string[]                 // C, D, F3, H … left blank
  entries: CatalogEntry[]
}

const K1_BOXES = ['1', '2', '3', '4', '5a', '5b', '6', '7', '8a', '8b', '8c', '9', '10', '11']

/** The K-1s an S corporation's filed return carries (one per instance). */
export function issuedK1s(cat: CatalogView | undefined): IssuedK1[] {
  const all = formEntries(cat, 'f1120ssk')
  const instances = [...new Set(all.map(e => e.instance))].filter(i => !/^copy/.test(i))
  return instances.map(inst => {
    const es = all.filter(e => e.instance === inst)
    const box: Record<string, number> = {}
    for (const b of K1_BOXES) {
      const e = es.find(x => x.section === 'Part III' && x.line === b && x.kind === 'amount')
      if (e && typeof e.value === 'number') box[b] = e.value
    }
    const codes: IssuedK1['codes'] = {}
    for (const b of ['12', '13', '14', '15', '16', '17']) {
      const rows = k1Codes(cat, b, 'f1120ssk', inst)
      if (rows.length) codes[b] = rows.map(r => ({ code: r.code, amount: r.amount }))
    }
    const name = String(es.find(x => x.line === 'F' || x.line === 'F1')?.raw ?? '').split(/\s{2,}|\d/)[0].trim()
    const pctRaw = String(es.find(x => x.line === 'G')?.raw ?? '').replace(/[^\d.]/g, '')
    const ib = es.find(x => x.line === 'I' && x.col === 'beginning')
    const ie = es.find(x => x.line === 'I' && x.col === 'end')
    const num = (e?: CatalogEntry) => (e && typeof e.value === 'number' ? e.value : undefined)
    const blank: string[] = []
    for (const item of ['C', 'D', 'H']) if (!es.some(x => x.line === item && x.raw)) blank.push(item)
    return {
      instance: inst, shareholder: name, pct: pctRaw ? Number(pctRaw) : undefined, box, codes,
      itemI: { beginning: num(ib), end: num(ie) }, itemsBlank: blank, entries: es,
    }
  })
}

export const codeSum = (k: IssuedK1, box: string, code: string) =>
  (k.codes[box] ?? []).filter(r => r.code === code).reduce((s, r) => s + (r.amount ?? 0), 0)

/** Income items that INCREASE stock basis (positive amounts), and loss and
 *  deduction items that decrease it (negative amounts and box 11/12). */
export function basisItems(k: IssuedK1): { increases: number; losses: number; nondeductible: number; distributions: number; taxExempt: number } {
  let increases = 0, losses = 0
  for (const b of ['1', '2', '3', '4', '5a', '6', '7', '8a', '9', '10']) {
    const v = k.box[b] ?? 0
    if (v > 0) increases += v
    else losses += -v
  }
  losses += Math.abs(k.box['11'] ?? 0)
  for (const r of k.codes['12'] ?? []) losses += Math.abs(r.amount ?? 0)
  const taxExempt = codeSum(k, '16', 'A') + codeSum(k, '16', 'B')
  return {
    increases: increases + taxExempt,
    losses,
    nondeductible: codeSum(k, '16', 'C'),
    distributions: codeSum(k, '16', 'D'),
    taxExempt,
  }
}

/** Sch K totals as a stand-in when an S-corp return has no K-1 pages
 *  catalogued (single shareholder): same lines, section 'Schedule K'. */
export function scheduleKAsK1(cat: CatalogView | undefined): IssuedK1 | undefined {
  if (!formEntries(cat, 'f1120s').some(e => e.section === 'Schedule K')) return undefined
  const box: Record<string, number> = {}
  for (const b of K1_BOXES) {
    const v = amount(cat, 'f1120s', { section: 'Schedule K', line: b })
    if (v) box[b] = v
  }
  const codes: IssuedK1['codes'] = {}
  const d = amount(cat, 'f1120s', { section: 'Schedule K', line: '16d' })
  const c = amount(cat, 'f1120s', { section: 'Schedule K', line: '16c' })
  codes['16'] = [
    ...(d ? [{ code: 'D', amount: d }] : []),
    ...(c ? [{ code: 'C', amount: c }] : []),
  ]
  const e12a = amount(cat, 'f1120s', { section: 'Schedule K', line: '12a' })
  if (e12a) codes['12'] = [{ code: 'A', amount: e12a }]
  return { instance: 'schedule_k', shareholder: '', pct: 100, box, codes, itemI: {}, itemsBlank: [], entries: [] }
}

export { find }
