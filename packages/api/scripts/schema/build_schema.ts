/**
 * Build the golden schema (src/schema/crosswalk.ts) from the line dictionaries.
 *
 *   npx tsx scripts/schema/build_schema.ts          # every form
 *   npx tsx scripts/schema/build_schema.ts f1120s   # one form
 *
 * Writes data/schema/<form>.json.gz (keys + per-revision box → key) and
 * data/schema/index.json (what was built and how each box got its key),
 * and prints the blind check: for every revision that has a verified fill
 * map, how often matching alone picked the verified key. Committed, like the
 * line dictionaries, so a key that moves shows up in a diff.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LineDict } from '../../src/catalog/types.js'
import { buildFormSchema, parseEngineKey } from '../../src/schema/crosswalk.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DICTS = join(ROOT, 'data', 'line_dicts')
const OUT = join(ROOT, 'data', 'schema')

/** Every `<prefix>.<L|J><line>_…` key the engine, services, maps and builders write. */
function engineKeys(): string[] {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) { if (!/__fixtures__|node_modules/.test(f)) walk(p); continue }
      if (!/\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue
      for (const m of readFileSync(p, 'utf8').matchAll(/['`]([a-zA-Z0-9]+\.(?:L|J)\d+[a-z]?(?:_r\d+)?_[a-z0-9_]+)['`]/g)) found.add(m[1])
    }
  }
  for (const d of ['engine', 'services', 'maps', 'builders', 'routes']) walk(join(ROOT, 'src', d))
  return [...found].filter(k => parseEngineKey(k)).sort()
}

const only = process.argv[2]
const byForm = new Map<string, LineDict[]>()
for (const f of readdirSync(DICTS).filter(f => f.endsWith('.json.gz')).sort()) {
  const d = JSON.parse(gunzipSync(readFileSync(join(DICTS, f))).toString()) as LineDict
  if (only && d.form !== only) continue
  byForm.set(d.form, [...(byForm.get(d.form) ?? []), d])
}
const eng = engineKeys()
mkdirSync(OUT, { recursive: true })
const index: Record<string, unknown> = {}
let tot = { widgets: 0, keys: 0, compared: 0, agreed: 0 }
for (const [form, dicts] of [...byForm.entries()].sort()) {
  const s = buildFormSchema(form, dicts, eng)
  writeFileSync(join(OUT, `${form}.json.gz`), gzipSync(JSON.stringify({ form: s.form, title: s.title, keys: s.keys, revisions: s.revisions })))
  index[form] = { title: s.title, revisions: Object.keys(s.revisions).sort(), keys: s.keys.length, ...s.report }
  tot = { widgets: tot.widgets + s.report.widgets, keys: tot.keys + s.keys.length, compared: tot.compared + (s.report.blind?.compared ?? 0), agreed: tot.agreed + (s.report.blind?.agreed ?? 0) }
  const b = s.report.by
  console.log(`${form.padEnd(9)} ${String(s.report.widgets).padStart(5)} boxes → ${String(s.keys.length).padStart(4)} keys | verified ${b.verified} engine ${b.engine} same-line ${b.same_line} renumbered ${b.renumbered} similar ${b.similar} by-place ${b.by_name} renamed ${b.renamed} new ${b.generated}${s.report.blind ? ` | blind ${s.report.blind.agreed}/${s.report.blind.compared}` : ''}`)
  for (const x of s.report.blind?.disagreements ?? []) console.log(`     blind miss ${x.rev} ${x.line}: verified ${x.verified}, matching chose ${x.matched}`)
  for (const x of s.report.conflicts ?? []) console.log(`     map conflict ${x.rev} ${x.line} ${x.widget.split('.').pop()}: map says ${x.map_says}, IRS description says ${x.description_says}${x.kept ? ' (kept the map)' : ''}`)
}
if (!only) writeFileSync(join(OUT, 'index.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), engine_keys: eng.length, forms: index }, null, 1) + '\n')
console.log(`\n${byForm.size} forms, ${tot.widgets} boxes, ${tot.keys} keys; blind check ${tot.agreed}/${tot.compared}`)
