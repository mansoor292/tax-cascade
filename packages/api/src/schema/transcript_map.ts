/**
 * IRS return transcript lines → golden keys.
 *
 * The IRS's Tax Return Transcript reports each return in its own words
 * ("Ordinary Income/Loss", "Salary and Wages Less Jobs Credit"). A curated
 * table per return type (data/schema/transcript/<type>.json) names, for each
 * line, the box it reports — by its place on the newest form — and whether it
 * is the figure as filed or the IRS's own recomputation ("Per Computer").
 * The golden key comes from the schema, so a transcript line and the filed
 * box line up whatever year's form the return was on.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_DIR, formSchema } from './index.js'

export type Variant = 'as_filed' | 'irs_computed'
export interface TranscriptLineKey { form: string; key: string; variant: Variant; /** -1: the IRS prints the form's positive amount as a credit */ sign?: -1 }

interface TableFile {
  form_type: string
  main_form: string
  lines: Record<string, { box?: string; form?: string; key?: string; variant: Variant; sign?: -1 }>
}

/** "f1120s|Schedule L|24|d" → the key whose box sits there on the newest
 *  form. A place holding several boxes (a line with a code box and an amount
 *  box) must be named by key instead. */
export function resolveBox(ref: string): { form: string; key: string } | { error: string } {
  const [form, section, line, col = ''] = ref.split('|')
  const s = formSchema(form)
  if (!s) return { error: `no schema for ${form}` }
  const newest = Object.keys(s.revisions).sort((a, b) => Number(b) - Number(a))[0]
  const at = s.keys.filter(k => k.section === section && k.line === line && (k.col ?? '') === col && k.kind === 'text' && k.revs.includes(newest))
  if (at.length === 1) return { form, key: at[0].key }
  return { error: at.length ? `${ref}: ${at.length} boxes (${at.map(k => k.key).join(', ')}) — name the key` : `${ref}: no box on the ${newest} form` }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const cache = new Map<string, Map<string, TranscriptLineKey> | null>()

/** The table for a return type, keyed by "section|label" (lower case). */
export function transcriptTable(formType: string, dir = join(SCHEMA_DIR, 'transcript')): Map<string, TranscriptLineKey> | null {
  const id = `${dir}|${formType}`
  if (cache.has(id)) return cache.get(id)!
  const file = join(dir, `${formType}.json`)
  if (!/^[0-9A-Z]+$/.test(formType) || !existsSync(file)) { cache.set(id, null); return null }
  const t = JSON.parse(readFileSync(file, 'utf8')) as TableFile
  const out = new Map<string, TranscriptLineKey>()
  for (const [line, v] of Object.entries(t.lines)) {
    const r = v.key && v.form ? { form: v.form, key: v.key } : v.box ? resolveBox(v.box) : { error: 'no box or key' }
    if ('error' in r) continue // tests hold every entry to resolving; a stale one is skipped, never guessed
    out.set(norm(line), { ...r, variant: v.variant, ...(v.sign === -1 ? { sign: -1 as const } : {}) })
  }
  cache.set(id, out)
  return out
}

/** Every entry of the table with how it resolved (for tests and the build). */
export function auditTable(formType: string, dir = join(SCHEMA_DIR, 'transcript')): Array<{ line: string; ref: string; resolved?: { form: string; key: string }; error?: string }> {
  const t = JSON.parse(readFileSync(join(dir, `${formType}.json`), 'utf8')) as TableFile
  return Object.entries(t.lines).map(([line, v]) => {
    if (v.key && v.form) return { line, ref: `${v.form}:${v.key}`, ...(formSchema(v.form)?.byKey.has(v.key) ? { resolved: { form: v.form, key: v.key } } : { error: `${v.form}:${v.key} is not a schema key` }) }
    const r = v.box ? resolveBox(v.box) : { error: 'no box or key' }
    return { line, ref: v.box ?? '', ...('error' in r ? { error: r.error } : { resolved: r }) }
  })
}

/** The golden key of one return-transcript line, if the table names one. */
export function transcriptKey(formType: string, section: string, label: string): TranscriptLineKey | undefined {
  return transcriptTable(formType)?.get(norm(`${section}|${label}`))
}
