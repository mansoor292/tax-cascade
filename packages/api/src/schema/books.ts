/**
 * The books on the golden schema: every QuickBooks account the mapper
 * classified (maps/qbo_to_inputs.ts — each leaf account lands on a return
 * line by a named rule, or is reported dropped), placed on the golden key of
 * that line, with the accounts behind each figure kept.
 *
 * This is the books BEFORE any tax computation: no officer-pay split, no
 * meals disallowance, no M-1. Headline totals (gross profit, total income,
 * total deductions, ordinary / taxable income) are only the sum of the lines
 * mapped here, marked `summed`, so a books figure can sit beside the filed,
 * IRS, proforma, amendment and scenario figures on the same row.
 */
import { getEngineToCanonicalMap } from '../maps/engine_to_pdf.js'
import type { AuditEntry, MapperOutput } from '../maps/qbo_to_inputs.js'
import { goldenKey } from './index.js'
import { resolveBox } from './transcript_map.js'
import { formOfKey } from './golden.js'

export interface BooksLine {
  form: string
  key: string
  value: number
  /** a total of the lines above it, not an account balance */
  summed?: boolean
  accounts?: Array<{ account: string; amount: number; rule: string }>
}
export interface BooksView { lines: BooksLine[]; unplaced: Array<{ field: string; amount: number }> }

/** Mapper fields the engine's map does not name (1120-S portfolio income and
 *  charity go to Schedule K, not page 1). */
const EXTRA: Record<string, Record<string, string>> = {
  '1120S': {
    charitable_contrib: 'f1120s|Schedule K|12a|',
    schedule_k_interest: 'f1120s|Schedule K|4|',
    schedule_k_dividends_ordinary: 'f1120s|Schedule K|5a|',
    schedule_k_royalties: 'f1120s|Schedule K|6|',
    schedule_k_tax_exempt_interest: 'f1120s|Schedule K|16a|',
  },
}

/** Headline totals as sums of mapped lines: [total, [+lines], [-lines]]. */
const SUMS: Record<string, Array<[string, string[], string[]]>> = {
  '1120S': [
    ['f1120s||1c|', ['f1120s||1a|'], ['f1120s||1b|']],
    ['f1120s||3|', ['f1120s||1c|'], ['f1120s||2|']],
    ['f1120s||6|', ['f1120s||3|', 'f1120s||4|', 'f1120s||5|'], []],
    ['f1120s||21|', ['7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'].map(l => `f1120s||${l}|`), []],
    ['f1120s||22|', ['f1120s||6|'], ['f1120s||21|']],
  ],
  '1120': [
    ['f1120||1c|', ['f1120||1a|'], ['f1120||1b|']],
    ['f1120||3|', ['f1120||1c|'], ['f1120||2|']],
    ['f1120||11|', ['3', '4', '5', '6', '7', '8', '9', '10'].map(l => `f1120||${l}|`), []],
    ['f1120||27|', ['12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26'].map(l => `f1120||${l}|`), []],
    ['f1120||28|', ['f1120||11|'], ['f1120||27|']],
  ],
}

const keyOf = (ref: string) => { const r = resolveBox(ref); return 'error' in r ? undefined : r }

export function booksToGolden(formType: string, packet: Pick<MapperOutput, 'inputs' | 'audit'>): BooksView {
  const engine = getEngineToCanonicalMap(formType)
  const lines = new Map<string, BooksLine>()
  const unplaced: BooksView['unplaced'] = []
  const place = (field: string): { form: string; key: string } | undefined => {
    if (EXTRA[formType]?.[field]) return keyOf(EXTRA[formType][field])
    const canonical = engine[field] ?? (field.includes('.') ? field : undefined)
    if (!canonical) return undefined
    const form = formOfKey(formType, canonical)
    return form ? { form, key: goldenKey(form, canonical) } : undefined
  }
  const byField = new Map<string, AuditEntry[]>()
  for (const a of packet.audit) byField.set(a.tax_field, [...(byField.get(a.tax_field) ?? []), a])
  for (const [field, amount] of Object.entries(packet.inputs)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue
    const at = place(field)
    if (!at) { unplaced.push({ field, amount }); continue }
    const id = `${at.form}|${at.key}`
    const cur = lines.get(id)
    const accounts = (byField.get(field) ?? []).map(a => ({ account: a.qbo_source, amount: a.amount, rule: a.confidence }))
    if (cur) { cur.value += amount; cur.accounts = [...(cur.accounts ?? []), ...accounts] }
    else lines.set(id, { ...at, value: amount, accounts })
  }
  for (const [total, plus, minus] of SUMS[formType] ?? []) {
    const t = keyOf(total)
    if (!t || lines.has(`${t.form}|${t.key}`)) continue
    const val = (refs: string[]) => refs.reduce((s, r) => { const k = keyOf(r); return s + (k ? lines.get(`${k.form}|${k.key}`)?.value ?? 0 : 0) }, 0)
    const parts = [...plus, ...minus].map(keyOf).filter(k => k && lines.has(`${k.form}|${k.key}`))
    if (!parts.length) continue
    lines.set(`${t.form}|${t.key}`, { ...t, value: val(plus) - val(minus), summed: true })
  }
  return { lines: [...lines.values()], unplaced }
}
