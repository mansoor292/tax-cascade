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
import type { SchemaKey } from './crosswalk.js'

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
