/**
 * The golden schema at run time: which key a box of a given form and year
 * carries (data/schema, built by scripts/schema/build_schema.ts — see
 * crosswalk.ts for how keys are chosen).
 *
 * Keys are applied when a value is READ, not only when a return is
 * catalogued: catalogs are immutable, and a schema improvement must reach the
 * returns already stored without re-reading every PDF.
 */
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogEntry } from '../catalog/types.js'
import type { KeyPlace, SchemaKey } from './crosswalk.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCHEMA_DIR = join(HERE, '..', '..', 'data', 'schema')

interface FormSchemaFile {
  form: string
  title: string
  keys: SchemaKey[]
  revisions: Record<string, Record<string, string>>
}
interface Loaded extends FormSchemaFile { byKey: Map<string, SchemaKey>; aliasOf: Map<string, string> }

// Per-process cache; read-only data, so safe under the pm2 cluster.
const cache = new Map<string, Loaded | null>()

export function formSchema(form: string, dir = SCHEMA_DIR): Loaded | null {
  const id = `${dir}|${form}`
  if (cache.has(id)) return cache.get(id)!
  const file = join(dir, `${form}.json.gz`)
  if (!/^[a-z0-9]+$/.test(form) || !existsSync(file)) { cache.set(id, null); return null }
  const f = JSON.parse(gunzipSync(readFileSync(file)).toString()) as FormSchemaFile
  const byKey = new Map(f.keys.map(k => [k.key, k]))
  const aliasOf = new Map<string, string>()
  for (const k of f.keys) for (const a of k.aliases ?? []) aliasOf.set(a, k.key)
  const loaded = { ...f, byKey, aliasOf }
  cache.set(id, loaded)
  return loaded
}

/** The key of one box: form slug, revision, full widget name. */
export function keyFor(form: string, rev: string, widget: string | undefined): string | undefined {
  if (!widget) return undefined
  return formSchema(form)?.revisions[rev]?.[widget]
}

/** A key's description, following an alias to the key it names. */
export function keyInfo(form: string, key: string): SchemaKey | undefined {
  const s = formSchema(form)
  if (!s) return undefined
  return s.byKey.get(key) ?? s.byKey.get(s.aliasOf.get(key) ?? '')
}

/** The revision of a form a tax year is filed on: the newest one not after
 *  the year (1125-A's 2018 revision serves 2023), else the oldest. */
export function revForYear(form: string, year: number): string | undefined {
  const revs = Object.keys(formSchema(form)?.revisions ?? {}).sort((a, b) => Number(a) - Number(b))
  return [...revs].reverse().find(r => Number(r) <= year) ?? revs[0]
}

/** Where a key sits on one revision of its form — that year's section, line,
 *  column and words. Undefined when the box is not on that revision. */
export function placeIn(form: string, key: string, rev: string | undefined): KeyPlace | undefined {
  const k = keyInfo(form, key)
  if (!k || !rev) return undefined
  if (k.at?.[rev]) return k.at[rev]
  return k.revs.includes(rev) ? { section: k.section, line: k.line, ...(k.col ? { col: k.col } : {}), label: k.label } : undefined
}

/** The golden key for a name that may be an alias (an older fill-map or
 *  engine name for the same box). */
export function goldenKey(form: string, key: string): string {
  return formSchema(form)?.aliasOf.get(key) ?? key
}

/** Entries with their golden key. A box the schema knows gets the schema's
 *  key (overriding any key the catalog stored when it was read); other
 *  entries are returned as they are. */
export function keyEntries<T extends Pick<CatalogEntry, 'form' | 'rev'> & { widget?: string; canonical?: string }>(entries: T[]): T[] {
  return entries.map(e => {
    const k = keyFor(e.form, e.rev, e.widget)
    return k && k !== e.canonical ? { ...e, canonical: k } : e
  })
}
