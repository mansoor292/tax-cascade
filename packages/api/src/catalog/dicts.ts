/**
 * Loads the line dictionaries built by scripts/catalog/build_line_dicts.ts.
 *
 * All 307 dictionaries together are ~200 MB of heap and 1.5 s to parse — too
 * much for every pm2 worker to hold (root CLAUDE.md: cluster mode, one worker
 * per core). So a small index (form, revision, page sizes, the form numbers
 * each page prints in its header) is always loaded, and a page pulls in only
 * the dictionaries whose header form numbers it shares, through a bounded
 * cache. A typical return touches 20–40 of them.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LineDict, DictPage, DictWidget } from './types.js'
import { splitWords } from './pdf_layout.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DICT_DIR = join(HERE, '..', '..', 'data', 'line_dicts')

export interface IndexedPage {
  dict: LineDict
  page: DictPage
  widgets: DictWidget[]
  /** template run text → runs with that text (runs of 2+ characters: the
   *  classification signal; single characters match everywhere) */
  byText: Map<string, Array<[number, number, number, number]>>
  runCount: number
  /** EVERY template run, including single characters, for subtraction */
  allRuns: Map<string, Array<[number, number, number, number]>>
  /** template WORDS with estimated positions, for subtraction when the filer's
   *  software split a run differently from the blank */
  words: Map<string, Array<[number, number, number, number]>>
}

export interface DictIndexEntry {
  file: string
  form: string
  rev: string
  pages: Array<{ page: number; width: number; height: number; header: string[] }>
}

const INDEX_FILE = 'index.json'

function indexPages(dict: LineDict): IndexedPage[] {
  const out: IndexedPage[] = []
  for (const page of dict.pages) {
    const byText = new Map<string, Array<[number, number, number, number]>>()
    const allRuns = new Map<string, Array<[number, number, number, number]>>()
    const words = new Map<string, Array<[number, number, number, number]>>()
    const add = (m: typeof byText, k: string, b: [number, number, number, number]) => {
      const l = m.get(k)
      if (l) l.push(b)
      else m.set(k, [b])
    }
    let runCount = 0
    for (const [t, x0, y0, x1, y1] of page.template) {
      const key = t.trim()
      if (!key) continue
      add(allRuns, key, [x0, y0, x1, y1])
      for (const w of splitWords({ text: t, bbox: [x0, y0, x1, y1] })) add(words, w.text, w.bbox)
      if (key.length < 2) continue
      runCount++
      add(byText, key, [x0, y0, x1, y1])
    }
    if (runCount < 15) continue // near-empty pages (instructions stubs) never classify
    out.push({ dict, page, widgets: dict.widgets.filter(w => w.page === page.page), byText, runCount, allRuns, words })
  }
  return out
}

function readDict(dir: string, file: string): LineDict {
  return JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString('utf8')) as LineDict
}

/** Build the index from the dictionary files (the build script writes it;
 *  this is the fallback when it is missing). */
export function buildIndex(dir: string = DICT_DIR): DictIndexEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => n.endsWith('.json.gz')).sort().map(file => {
    const d = readDict(dir, file)
    return { file, form: d.form, rev: d.rev, pages: d.pages.map(p => ({ page: p.page, width: p.width, height: p.height, header: p.header })) }
  })
}

let indexCache: { dir: string; index: DictIndexEntry[] } | null = null

export function loadIndex(dir: string = DICT_DIR): DictIndexEntry[] {
  if (indexCache?.dir === dir) return indexCache.index
  const f = join(dir, INDEX_FILE)
  const index = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as DictIndexEntry[] : buildIndex(dir)
  indexCache = { dir, index }
  return index
}

/** Bounded LRU of parsed dictionaries (Map preserves insertion order). */
const MAX_CACHED = 80
const cache = new Map<string, IndexedPage[]>()

export function loadDictPages(file: string, dir: string = DICT_DIR): IndexedPage[] {
  const key = `${dir}|${file}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const pages = indexPages(readDict(dir, file))
  cache.set(key, pages)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return pages
}

/** Candidate dictionary files for a printed page, in the order to try them:
 *  same page size and a shared header form number, nearest revision to the
 *  tax year first (the year itself, then older revisions still in use, then
 *  newer). Returned as stages so the caller can stop at the first strong
 *  match instead of parsing every revision of every 1040 schedule. */
export function candidateStages(header: Set<string>, width: number, height: number, year?: number, dir: string = DICT_DIR): string[][] {
  const index = loadIndex(dir)
  const sized = (p: { width: number; height: number }) => Math.abs(p.width - width) < 2 && Math.abs(p.height - height) < 2
  let entries = index.filter(e => e.pages.some(p => sized(p) && p.header.some(t => header.has(t))))
  if (!entries.length) entries = index.filter(e => ['f1040', 'f1120', 'f1120s', 'f1065', 'f1120ssk', 'f1065sk1'].includes(e.form))
  const dist = (rev: string) => {
    const r = Number(rev)
    if (!year || !Number.isFinite(r)) return 0
    return r === year ? 0 : r < year ? 1 + Math.min(year - r, 20) : 30 + (r - year)
  }
  const byDist = new Map<number, string[]>()
  for (const e of entries) {
    // one stage for the tax year, one for each older year, newer ones last
    const d = dist(e.rev)
    const stage = d === 0 ? 0 : d < 30 ? (d <= 2 ? 1 : 2) : 3
    byDist.set(stage, [...(byDist.get(stage) ?? []), e.file])
  }
  return [...byDist.entries()].sort((a, b) => a[0] - b[0]).map(([, files]) => files)
}

export function pagesOf(files: string[], width: number, height: number, dir: string = DICT_DIR): IndexedPage[] {
  return files.flatMap(f => loadDictPages(f, dir)).filter(p => Math.abs(p.page.width - width) < 2 && Math.abs(p.page.height - height) < 2)
}

/** Every dictionary, fully parsed — for tools and tests only (≈200 MB). */
export function loadDicts(dir: string = DICT_DIR): { dicts: LineDict[]; pages: IndexedPage[] } {
  const dicts: LineDict[] = []
  if (existsSync(dir)) for (const f of readdirSync(dir).filter(n => n.endsWith('.json.gz')).sort()) dicts.push(readDict(dir, f))
  return { dicts, pages: dicts.flatMap(indexPages) }
}
