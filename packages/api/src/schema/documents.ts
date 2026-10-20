/**
 * The source documents on the golden schema: what the W-2s, 1099s, 1098s and
 * K-1s on file say, placed on the return's lines BEFORE any computation —
 * a return's "books" when it has no QuickBooks (a 1040 above all).
 *
 * Figures come from services/document_merge.ts — the very function the
 * compute path merges documents with — run on empty inputs, so this column
 * is what a fresh compute would take from the same documents. Each figure is
 * placed like for like (a W-2's box 1 against 1040 line 1a, not 1z).
 *
 * For a 1040 the K-1s the group's own S corporations issued are added from
 * their filed returns (the catalog), through the ownership the entity map
 * records — unless K-1 documents are on file too, which would count twice.
 */
import { getEngineToCanonicalMap } from '../maps/engine_to_pdf.js'
import { mergeDocuments } from '../services/document_merge.js'
import type { CatalogEntry } from '../catalog/types.js'
import { resolveBox } from './transcript_map.js'
import { resolveKey } from './validate.js'

export interface DocLine { form: string; key: string; value: number; sources: string[] }
export interface DocumentsView { lines: DocLine[]; unplaced: Array<{ field: string; value: number }>; notes: string[] }

/** Document fields placed on the box the document reports (the engine's
 *  own map names the computed total line instead, or nothing). */
const PLACE: Record<string, Record<string, string>> = {
  '1040': {
    wages: 'f1040||1a|', withholding: 'f1040||25a|',
    ira_distributions: 'f1040||4a|', pensions_annuities: 'f1040||5a|',
    net_se_income: 'f1040sc|Part I|1|', student_loan_interest: 'f1040s1|Part II|21|',
    k1_ordinary_income: 'f1040se|Part II|32|',
  },
  '1120S': {
    schedule_k_interest: 'f1120s|Schedule K|4|', schedule_k_dividends_ordinary: 'f1120s|Schedule K|5a|',
    schedule_k_dividends_qualified: 'f1120s|Schedule K|5b|', schedule_k_st_cap_gain: 'f1120s|Schedule K|7|',
    schedule_k_lt_cap_gain: 'f1120s|Schedule K|8a|',
  },
}
/** Inputs the merge derives from others rather than reads from a document. */
const DERIVED_INPUTS = new Set(['schedule1_income'])

const keyOf = (ref: string) => { const r = resolveBox(ref); return 'error' in r ? undefined : r }

export function documentsToGolden(formType: string, docs: any[]): DocumentsView {
  const inputs: Record<string, any> = {}
  const sources = new Map<string, string[]>()
  const log: Array<{ field: string; value: number; sources: string[]; confidence?: string }> = []
  mergeDocuments(docs, formType, {
    mergedInputs: inputs,
    setIfUnset: (field, value, sourceType, count) => {
      if (value && (inputs[field] === undefined || inputs[field] === null)) { inputs[field] = value; sources.set(field, [`${count} × ${sourceType}`]) }
    },
    autoMergeLog: log,
  })
  for (const l of log) if (!sources.has(l.field) && l.value) sources.set(l.field, l.sources)
  const engine = getEngineToCanonicalMap(formType)
  const lines = new Map<string, DocLine>()
  const unplaced: DocumentsView['unplaced'] = []
  for (const [field, value] of Object.entries(inputs)) {
    if (typeof value !== 'number' || !value || DERIVED_INPUTS.has(field)) continue
    const at = PLACE[formType]?.[field] ? keyOf(PLACE[formType][field]) : engine[field] ? resolveKey(formType, engine[field]) : undefined
    if (!at) { unplaced.push({ field, value }); continue }
    const id = `${at.form}|${at.key}`
    const cur = lines.get(id)
    if (cur) { cur.value += value; cur.sources.push(...(sources.get(field) ?? [])) }
    else lines.set(id, { ...at, value, sources: [...(sources.get(field) ?? [])] })
  }
  const notes = log.filter(l => !l.value).map(l => l.sources.join('; '))
  return { lines: [...lines.values()], unplaced, notes }
}

/** K-1 box → the 1040 line it lands on (box refs on the newest forms). */
const K1_TO_1040: Array<[RegExp, string]> = [
  [/^1$/, 'f1040se|Part II|32|'],
  [/^4$/, 'f1040||2b|'],
  [/^5a$/, 'f1040||3b|'],
  [/^5b$/, 'f1040||3a|'],
  [/^7$/, 'f1040sd|Part I|5|'],
  [/^8a$/, 'f1040sd|Part II|12|'],
]

/** The figures of one S corporation's K-1 (its filed return's Schedule K-1
 *  entries, first copy) placed on the owner's 1040 lines. */
export function k1ToGolden(entries: CatalogEntry[], issuer: string): DocLine[] {
  const k1 = entries.filter(e => e.form === 'f1120ssk' && (!e.instance || e.instance === 'k1:1' || e.instance === '#1') && typeof e.value === 'number' && e.section === 'Part III')
  const out = new Map<string, DocLine>()
  const add = (ref: string, value: number, what: string) => {
    const at = keyOf(ref)
    if (!at || !value) return
    const id = `${at.form}|${at.key}`
    const cur = out.get(id)
    if (cur) { cur.value += value; cur.sources.push(what) }
    else out.set(id, { ...at, value, sources: [what] })
  }
  for (const e of k1) {
    const hit = K1_TO_1040.find(([re]) => re.test(e.line) && !e.col)
    if (hit) add(hit[1], e.value as number, `K-1 from ${issuer}, box ${e.line}`)
  }
  // box 16 code D (distributions): the code sits in the box beside the amount
  const box16 = entries.filter(e => e.form === 'f1120ssk' && e.section === 'Part III' && e.line === '16' && (!e.instance || e.instance === 'k1:1' || e.instance === '#1'))
  for (let i = 0; i < box16.length - 1; i++) {
    if (String(box16[i].value ?? box16[i].raw).trim().toUpperCase() === 'D' && typeof box16[i + 1].value === 'number') {
      add('f7203|Part I|6|', box16[i + 1].value as number, `K-1 from ${issuer}, box 16 code D`)
    }
  }
  return [...out.values()]
}
