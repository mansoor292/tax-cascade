/**
 * The cataloguer: a return PDF in, every value on every page out.
 *
 * How (see docs/RETURN_CATALOG_AND_REVIEW.md):
 *   1. Each page is matched to an IRS blank page by its printed template text,
 *      position-checked (filers' software prints onto the official form, so
 *      the template sits at the blank's coordinates).
 *   2. The blank's template text and drawn rules are subtracted; each word
 *      left is assigned to the blank's widget that contains it, and each drawn
 *      mark left inside a check widget ticks it.
 *   3. Pages that match no blank (statements, worksheets, state and vendor
 *      forms, cover letters) are kept whole as text rows with their amounts.
 *   4. Nothing is dropped. Text that lands in no widget is kept as an
 *      'unassigned' entry; an AMOUNT that lands in no widget makes the catalog
 *      incomplete, because it means a value we cannot place on a line.
 *
 * A second printed copy of a non-repeating form is catalogued as instance
 * 'copyN' and compared with the first; disagreements are counted, because two
 * different versions of the same page in one filed return is itself a finding.
 */
import { createHash } from 'node:crypto'
import { readLayout, splitWords, type LayoutPage, type TextRun, type BBox } from './pdf_layout.js'
import { candidateStages, pagesOf, type IndexedPage } from './dicts.js'
import { isAmount, parseAmount } from './amount.js'
import type { Catalog, CatalogEntry, CatalogPage, DictWidget } from './types.js'
import { isTranscriptText, transcriptEntries, type TranscriptContext } from './transcript.js'

export const EXTRACTOR_VERSION = 'catalog-1'

const POS_TOL = 2.5
const MIN_SCORE = 0.55
const CHECK_TEXT = new Set(['x', 'X', '✔', '✓', '✗', '✘', '■', '●', '☒', '☑', '✕', '✖'])
/** ZapfDingbats code points some software leaves unmapped (✔ is "4"). Only
 *  accepted when the glyph is ALONE inside a check widget. */
const DINGBAT_ALONE = new Set(['4', '8', '3', 'l', 'n', 'o', 'u'])

/** Forms that legitimately repeat within one return; any other form seen
 *  twice is a second printed copy. */
const REPEATABLE = new Set(['f1120ssk', 'f1065sk1', 'f8949', 'f1040se', 'f4562', 'f8582', 'f1040sc', 'f8829', 'f4797', 'f1116', 'f6781', 'f1125e', 'f1040sb'])

/** Labels of boxes that hold identifiers or codes, never amounts. */
const NOT_AMOUNT_LABEL = /\b(?:code|number|identification|E I N|EIN|S S N|SSN|P T I N|PTIN|Z I P|ZIP|phone|date|routing|account|no\.|percentage|%|shares)\b|calendar year|year beginning|year ending|digit year/i

const center = (b: BBox): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
/** Text baseline (the glyph box runs from -0.2h to 0.8h around it). Rows are
 *  compared by baseline because a value set in a bigger font than its label
 *  has a different top and centre but the same baseline. */
const baseline = (b: BBox): number => b[1] + 0.8 * (b[3] - b[1])

function inRect(pt: [number, number], r: BBox, tx = 2, ty = 1.5): boolean {
  return pt[0] >= r[0] - tx && pt[0] <= r[2] + tx && pt[1] >= r[1] - ty && pt[1] <= r[3] + ty
}

function textIndex(runs: TextRun[]): Map<string, TextRun[]> {
  const m = new Map<string, TextRun[]>()
  for (const r of runs) {
    const k = r.text.trim()
    if (!k) continue
    const l = m.get(k)
    if (l) l.push(r)
    else m.set(k, [r])
  }
  return m
}

const near = (a: BBox | [number, number, number, number], b: BBox) =>
  Math.abs(a[0] - b[0]) <= POS_TOL && Math.abs(a[1] - b[1]) <= POS_TOL

/** Share of the blank page's template runs found at the same place on the
 *  filed page. */
function score(idx: Map<string, TextRun[]>, cand: IndexedPage): number {
  let hit = 0
  for (const [t, boxes] of cand.byText) {
    const filed = idx.get(t)
    if (!filed) continue
    for (const b of boxes) if (filed.some(r => near(b, r.bbox))) hit++
  }
  return hit / cand.runCount
}

const FORM_TOKEN = /^(?:\d{3,4}(?:-[A-Z0-9]{1,4})?|\d{4}[A-Z]{1,2}|K-1)$/

function headerTokens(p: LayoutPage): Set<string> {
  const s = new Set<string>()
  for (const r of p.runs) {
    if (r.bbox[1] >= p.height * 0.12) continue
    for (const w of splitWords(r)) {
      const t = w.text.replace(/[.,()]/g, '')
      // A year is not a form number (every 2024 form prints "2024").
      if (FORM_TOKEN.test(t) && !/^(?:19|20)\d{2}$/.test(t)) s.add(t)
    }
  }
  return s
}

function revDistance(rev: string, year?: number): number {
  if (!year) return 0
  const r = Number(rev)
  if (!Number.isFinite(r)) return 50
  // Same year best; an older revision still in use next; a newer one last.
  return r === year ? 0 : r < year ? (year - r) : 20 + (r - year)
}

/** Share of the blank's template WORDS (2+ chars) that appear on the filed
 *  page, wherever they sit (multiset overlap). Word level, because substitute
 *  forms break the same text into different runs. */
function textScore(wordCount: Map<string, number>, cand: IndexedPage): number {
  let hit = 0, total = 0
  for (const [t, boxes] of cand.words) {
    if (t.length < 2) continue
    total += boxes.length
    hit += Math.min(boxes.length, wordCount.get(t) ?? 0)
  }
  return total ? hit / total : 0
}

const MIN_TEXT_SCORE = 0.85

function wordsOf(p: LayoutPage): TextRun[] {
  return p.runs.flatMap(r => splitWords(r))
}

interface Hit { cand: IndexedPage; score: number; aligned: boolean }

function better(c: IndexedPage, s: number, best: { cand: IndexedPage; score: number } | null, year?: number): boolean {
  return !best || s > best.score + 0.02 ||
    (Math.abs(s - best.score) <= 0.02 && revDistance(c.dict.rev, year) < revDistance(best.cand.dict.rev, year))
}

/** Match a page to a blank. Official-form printing matches by position. A
 *  SUBSTITUTE form (the filer's software drew its own facsimile — EV's 2022
 *  return: same words, every label shifted by up to ~20pt) matches by text
 *  and is then aligned before values are read. */
/** A position score this high means the page is printed on this very blank;
 *  later (more distant) revisions need not be tried. */
const SURE = 0.9

function classify(p: LayoutPage, idx: Map<string, TextRun[]>, all: IndexedPage[] | undefined, year?: number): Hit | null {
  if (all) return classifyAmong(p, idx, all, year)
  const stages = candidateStages(headerTokens(p), p.width, p.height, year)
  let seen: IndexedPage[] = []
  for (const files of stages) {
    seen = seen.concat(pagesOf(files, p.width, p.height))
    const hit = classifyAmong(p, idx, seen, year)
    if (hit && !hit.aligned && hit.score >= SURE) return hit
  }
  return classifyAmong(p, idx, seen, year)
}

function classifyAmong(p: LayoutPage, idx: Map<string, TextRun[]>, all: IndexedPage[], year?: number): Hit | null {
  const hdr = headerTokens(p)
  let cands = all.filter(c => c.page.width && Math.abs(c.page.width - p.width) < 2 && Math.abs(c.page.height - p.height) < 2)
  const byHeader = cands.filter(c => c.page.header.some(t => hdr.has(t)))
  if (byHeader.length) cands = byHeader
  let best: { cand: IndexedPage; score: number } | null = null
  for (const c of cands) {
    const s = score(idx, c)
    if (s >= MIN_SCORE && better(c, s, best, year)) best = { cand: c, score: s }
  }
  if (best) return { ...best, aligned: false }
  const wordCount = new Map<string, number>()
  for (const w of wordsOf(p)) if (w.text.length > 1) wordCount.set(w.text, (wordCount.get(w.text) ?? 0) + 1)
  // A text-only match is accepted only when the page header names the same
  // form: New York's IT-182 repeats Form 8582's wording almost word for word.
  if (!byHeader.length) return null
  let bestText: { cand: IndexedPage; score: number } | null = null
  for (const c of cands) {
    const ts = textScore(wordCount, c)
    if (ts >= MIN_TEXT_SCORE && better(c, ts, bestText, year)) bestText = { cand: c, score: ts }
  }
  if (bestText) return { ...bestText, aligned: true }
  return null
}

/** Move a substitute form's runs onto the blank's coordinates. Anchors are
 *  template strings printed exactly once on both pages; each run takes the
 *  offset of the nearest anchor on its own line (else the nearest line), so
 *  regions that shifted differently are each corrected locally. */
function alignToBlank(p: LayoutPage, cand: IndexedPage): LayoutPage {
  // Anchors: words of 3+ letters printed exactly once on each page.
  const filedWords = new Map<string, TextRun[]>()
  for (const w of wordsOf(p)) {
    if (w.text.length < 3 || !/[A-Za-z]{3}/.test(w.text)) continue
    const l = filedWords.get(w.text)
    if (l) l.push(w)
    else filedWords.set(w.text, [w])
  }
  const anchors: Array<{ x: number; y: number; dx: number; dy: number }> = []
  for (const [t, boxes] of cand.words) {
    const f = filedWords.get(t)
    if (boxes.length !== 1 || !f || f.length !== 1) continue
    const b = boxes[0], r = f[0].bbox
    anchors.push({ x: r[0], y: baseline(r), dx: b[0] - r[0], dy: baseline(b) - baseline(r) })
  }
  if (anchors.length < 5) return p
  const offsetFor = (bb: BBox): [number, number] => {
    const cy = baseline(bb)
    const sameLine = anchors.filter(a => Math.abs(a.y - cy) <= 3)
    const pool = sameLine.length ? sameLine : [...anchors].sort((a, b) => Math.abs(a.y - cy) - Math.abs(b.y - cy)).slice(0, 3)
    let best = pool[0]
    for (const a of pool) if (Math.abs(a.x - bb[0]) < Math.abs(best.x - bb[0])) best = a
    return [best.dx, best.dy]
  }
  const shift = (bb: BBox): BBox => {
    const [dx, dy] = offsetFor(bb)
    return [bb[0] + dx, bb[1] + dy, bb[2] + dx, bb[3] + dy]
  }
  // Shift word by word (a run can span regions that moved differently), and
  // remember where each word really was for the line-label pass.
  return {
    ...p,
    runs: wordsOf(p).map(w => ({ text: w.text, bbox: shift(w.bbox), orig: w.bbox })),
    marks: p.marks.map(shift),
  }
}

const LINE_LABEL = /^\d{1,2}[a-z]?$/

/** On a substitute form, the line number printed just left of a value's box
 *  ("27  1,240,884") says which line the value is — more reliably than its
 *  aligned position, because facsimiles change the row spacing. Returns the
 *  line id, e.g. "27" or "29a". */
function lineLabelLeftOf(o: BBox, words: TextRun[]): { line: string; column: number } | null {
  const cy = baseline(o)
  const sameRow = (a: TextRun, b: TextRun) => Math.abs(baseline(a.bbox) - baseline(b.bbox)) <= 1.5
  // "Stmt 7", "See Statement 4", "Form 1125-A", "line 27" — a number that
  // follows one of these is a reference, not this line's label (EV 2022's
  // substitute Schedule L prints "Stmt 7" on the same line as line 14's value).
  const isReference = (w: TextRun) => words.some(p => sameRow(p, w) && p.bbox[2] <= w.bbox[0] + 1 && w.bbox[0] - p.bbox[2] < 15 &&
    /^(Stmt|Statement|See|Form|Line|line|lines|Schedule|Sch\.?|Part|Pt\.?|from|of|and)$/i.test(p.text))
  const left = words.filter(w => w.bbox[2] <= o[0] + 1 && Math.abs(baseline(w.bbox) - cy) <= 6)
  const cands: Array<{ line: string; dy: number; x: number }> = []
  for (const w of left) {
    if (isReference(w)) continue
    // A line label sits at the left margin or just before the amount box;
    // a number in the middle of the row is instruction text ("Add lines 3
    // through 10").
    if (!(w.bbox[0] < 80 || o[0] - w.bbox[2] <= 60)) continue
    const dy = Math.abs(baseline(w.bbox) - cy)
    if (LINE_LABEL.test(w.text)) {
      // "10" followed by "a" on the same row → 10a
      const letter = words.find(q => sameRow(q, w) && /^[a-z]$/.test(q.text) && q.bbox[0] >= w.bbox[2] - 1 && q.bbox[0] - w.bbox[2] < 10)
      cands.push({ line: /^\d+$/.test(w.text) && letter ? w.text + letter.text : w.text, dy, x: w.bbox[0] })
    } else if (/^[a-z]$/.test(w.text) && w.bbox[0] < 80) {
      // a lone sub-letter row ("b  Less accumulated depreciation"): its number
      // is the nearest line label above, at the left margin.
      if (words.some(q => sameRow(q, w) && /^\d{1,2}$/.test(q.text) && Math.abs(q.bbox[2] - w.bbox[0]) < 10)) continue
      const above = words
        .filter(q => /^\d{1,2}$/.test(q.text) && q.bbox[0] < 80 && baseline(q.bbox) < baseline(w.bbox) - 1 && baseline(w.bbox) - baseline(q.bbox) < 30)
        .sort((a, b) => baseline(b.bbox) - baseline(a.bbox))[0]
      if (above) cands.push({ line: above.text + w.text, dy, x: w.bbox[0] })
    }
  }
  if (!cands.length) return null
  cands.sort((a, b) => a.dy - b.dy || b.x - a.x)
  return { line: cands[0].line, column: 0 }
}

interface Placed { word: TextRun; widget?: DictWidget }

/** True when the blank prints this word as several adjacent runs ("1" + "a"
 *  for line 1a) that the filer's software re-set as one. */
function spelledByBlank(w: TextRun, cand: IndexedPage): boolean {
  const target = w.text.replace(/\s+/g, '')
  if (target.length < 2 || target.length > 12) return false
  const parts = cand.page.template
    .filter(t => Math.abs(t[2] - w.bbox[1]) <= POS_TOL && t[1] >= w.bbox[0] - 3 && t[3] <= w.bbox[2] + 6)
    .sort((a, b) => a[1] - b[1])
  return parts.length > 1 && parts.map(t => t[0].replace(/\s+/g, '')).join('') === target
}

function isCheckGlyph(t: string, alone: boolean): boolean {
  return CHECK_TEXT.has(t) || (alone && DINGBAT_ALONE.has(t))
}

function short(name: string): string {
  return (name.split('.').pop() ?? name).replace(/\[0\]$/, '')
}

function readingOrder(words: TextRun[]): TextRun[] {
  return [...words].sort((a, b) => {
    const dy = center(a.bbox)[1] - center(b.bbox)[1]
    return Math.abs(dy) > 2 ? dy : a.bbox[0] - b.bbox[0]
  })
}

function joinWords(words: TextRun[]): string {
  return readingOrder(words).map(w => w.text).join(' ').replace(/\s+/g, ' ').trim()
}

function formPage(p: LayoutPage, cand: IndexedPage, instance: string, aligned = false): { entries: CatalogEntry[]; unassignedAmounts: number; residue: CatalogPage['residue'] } {
  const { dict, page: bp, widgets } = cand
  // Aligned (substitute-form) pages sit only approximately on the blank, so
  // the template is recognised by word within a window, and a value goes to
  // the nearest box on its own line rather than the box containing it.
  const tmplX = aligned ? 30 : 6
  const tmplY = aligned ? 5 : POS_TOL
  // 1. Subtract the template: whole runs (exact text, same place) first, then
  //    word by word for runs the filer's software split differently from the
  //    blank (x is estimated from character counts, hence the wider x
  //    tolerance). Punctuation-only tokens — dot leaders, "$", "(" — carry no
  //    value and are dropped.
  const leftovers: TextRun[] = []
  for (const r of p.runs) {
    const t = r.text.trim()
    const boxes = cand.allRuns.get(t)
    if (boxes && boxes.some(b => near(b, r.bbox))) continue
    for (const w of splitWords(r)) {
      if (/^[.\s$(),:;%_~•-]+$/.test(w.text)) continue
      const wb = cand.words.get(w.text)
      if (wb && wb.some(b => Math.abs(b[0] - w.bbox[0]) <= tmplX && Math.abs(b[1] - w.bbox[1]) <= tmplY)) continue
      if (spelledByBlank(w, cand)) continue
      leftovers.push(w)
    }
  }
  // 2. Assign words to the smallest widget containing their centre (aligned
  //    pages: the nearest text widget on the same line, within 45pt).
  const origWords: TextRun[] = aligned ? p.runs.map(r => ({ text: r.text, bbox: r.orig ?? r.bbox })) : []
  if (aligned) {
    // "Stmt 7" / "See Statement 4": the number names a statement, it is not a
    // value; keep it out of the boxes (it stays on the page as unassigned text).
    const refs = new Set(origWords.filter((w, i, all) => /^\d{1,2}$/.test(w.text) && all.some(p => Math.abs(baseline(p.bbox) - baseline(w.bbox)) <= 1.5 && p.bbox[2] <= w.bbox[0] + 1 && w.bbox[0] - p.bbox[2] < 15 && /^(Stmt|Statement)$/i.test(p.text))).map(w => `${w.text}@${w.bbox[0]},${w.bbox[1]}`))
    for (let i = leftovers.length - 1; i >= 0; i--) {
      const o = leftovers[i].orig
      if (o && refs.has(`${leftovers[i].text}@${o[0]},${o[1]}`)) leftovers.splice(i, 1)
    }
  }
  const placed: Placed[] = leftovers.map(word => {
    const c = center(word.bbox)
    let best: DictWidget | undefined
    let area = Infinity
    if (aligned && word.orig && isAmount(word.text) && /[,.]/.test(word.text)) {
      const label = lineLabelLeftOf(word.orig, origWords)
      if (label) {
        const onLine = widgets.filter(w => w.kind === 'text' && w.line === label.line).sort((a, b) => a.rect[0] - b.rect[0])
        // The nearest box on that line by aligned position. Counting values
        // to the left is NOT used to pick a column: Schedule L leaves columns
        // (a) and (c) blank on most lines, so the first printed value is (b).
        let dist = Infinity
        for (const w of onLine) {
          // Sanity: the labelled line's box on the official form must be near
          // where alignment put the value; otherwise the "label" was some other
          // number on the row (EV 2022 prints total assets beside checkbox A's
          // "4 Schedule M-3 attached").
          if (Math.abs((w.rect[1] + w.rect[3]) / 2 - c[1]) > 40) continue
          const d = Math.abs((w.rect[0] + w.rect[2]) / 2 - c[0]) + 3 * Math.abs((w.rect[1] + w.rect[3]) / 2 - c[1])
          if (d < dist) { dist = d; best = w }
        }
        if (best) return { word, widget: best }
      }
    }
    for (const w of widgets) {
      if (!inRect(c, w.rect)) continue
      const a = (w.rect[2] - w.rect[0]) * (w.rect[3] - w.rect[1])
      if (a < area) { area = a; best = w }
    }
    if (!best && aligned) {
      let dist = 45
      for (const w of widgets) {
        if (w.kind !== 'text' || c[1] < w.rect[1] - 4 || c[1] > w.rect[3] + 4) continue
        const dx = c[0] < w.rect[0] ? w.rect[0] - c[0] : c[0] > w.rect[2] ? c[0] - w.rect[2] : 0
        if (dx < dist) { dist = dx; best = w }
      }
    }
    return { word, widget: best }
  })
  // 3. Drawn marks the blank doesn't have.
  const blankMarks = bp.marks ?? []
  const filerMarks = p.marks.filter(m => !blankMarks.some(b => Math.abs(b[0] - m[0]) <= 1 && Math.abs(b[1] - m[1]) <= 1 && Math.abs(b[2] - m[2]) <= 1 && Math.abs(b[3] - m[3]) <= 1))

  const byWidget = new Map<string, TextRun[]>()
  for (const pl of placed) {
    if (!pl.widget) continue
    const l = byWidget.get(pl.widget.name)
    if (l) l.push(pl.word)
    else byWidget.set(pl.widget.name, [pl.word])
  }
  const usedMarks = new Set<number>()
  const entries: CatalogEntry[] = []
  const base = (w: DictWidget) => ({
    form: dict.form, title: dict.title, rev: dict.rev, instance, page: p.page,
    section: w.section, line: w.line, ...(w.row ? { row: w.row } : {}), ...(w.col ? { col: w.col } : {}),
    label: w.label, desc: w.desc, widget: w.name, ...(w.canonical ? { canonical: w.canonical } : {}),
    id: `${dict.form}--${dict.rev}:${instance}:${short(w.name)}`,
  })
  for (const w of widgets) {
    const words = byWidget.get(w.name) ?? []
    if (w.kind !== 'text') {
      const alone = words.length === 1
      const glyph = words.some(x => isCheckGlyph(x.text, alone))
      let mark = false
      filerMarks.forEach((m, i) => {
        if (inRect(center(m), w.rect, 1, 1)) { mark = true; usedMarks.add(i) }
      })
      if (glyph || mark) {
        entries.push({ ...base(w), kind: 'check', value: true, raw: words.map(x => x.text).join(' ') || '[mark]', method: glyph ? 'geometry' : 'mark', bbox: w.rect })
      } else if (words.length) {
        // Text inside a check box that isn't a check glyph: keep it, as text.
        entries.push({ ...base(w), kind: 'text', value: joinWords(words), raw: joinWords(words), method: 'geometry', bbox: w.rect })
      }
      continue
    }
    if (!words.length) continue
    const raw = joinWords(words)
    let kind: CatalogEntry['kind'] = 'text'
    let value: CatalogEntry['value'] = raw
    // A box labelled with "$" or "Amount" holds money even when its label also
    // says "tax year" (K-1 item I: "Loans from shareholder. Beginning of tax
    // year. $").
    const moneyBox = /\$\s*$|\bAmount\b/.test(w.label)
    if (moneyBox || !NOT_AMOUNT_LABEL.test(w.label)) {
      // Money boxes may carry a software note ("SEE STATEMENT 1 385,560");
      // the amount is the right-most amount-shaped token.
      const toks = readingOrder(words).map(x => x.text)
      const amts = toks.filter(t => isAmount(t) && (/[,.]/.test(t) || toks.length === 1))
      if (amts.length) {
        kind = 'amount'
        value = parseAmount(amts[amts.length - 1])
      }
    }
    entries.push({ ...base(w), kind, value, raw, method: 'geometry', bbox: w.rect })
  }
  // 4. Everything else stays in the catalog, marked unassigned.
  const residue: CatalogPage['residue'] = []
  let unassignedAmounts = 0
  // Single non-digit glyphs outside every box are arrows and bullets the
  // filer's font maps to letters ("a" for the IRS's ▶) — no information.
  const loose = placed.filter(pl => !pl.widget && !/^[^\d]$/.test(pl.word.text)).map(pl => pl.word)
  // Group loose words into lines so a stray "SEE STATEMENT 4" is one entry.
  const lines: TextRun[][] = []
  for (const w of readingOrder(loose)) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(center(last[last.length - 1].bbox)[1] - center(w.bbox)[1]) <= 2 && w.bbox[0] - last[last.length - 1].bbox[2] < 12) last.push(w)
    else lines.push([w])
  }
  lines.forEach((ws, i) => {
    const raw = ws.map(w => w.text).join(' ')
    const bbox: BBox = [Math.min(...ws.map(w => w.bbox[0])), Math.min(...ws.map(w => w.bbox[1])), Math.max(...ws.map(w => w.bbox[2])), Math.max(...ws.map(w => w.bbox[3]))]
    // On a substitute (aligned) page, template text that escaped subtraction
    // can look like an amount ("14." in "line 14.", "2022."); only a figure
    // with a thousands separator or cents is treated as a value there.
    const amountShaped = aligned ? /,\d{3}|\.\d{2}$/.test(raw) : /[,.]/.test(raw)
    const amt = ws.length === 1 && isAmount(raw) && amountShaped ? parseAmount(raw) : null
    // Software prints its own notes in the page margins (a penalty summary in
    // the footer, a client code in the header). Kept, but not form values.
    const margin = bbox[1] > p.height * 0.955 || bbox[3] < p.height * 0.035
    if (amt !== null && !margin) unassignedAmounts++
    residue.push({ text: raw, bbox })
    entries.push({
      id: `${dict.form}--${dict.rev}:${instance}:loose${p.page}_${i}`,
      form: dict.form, title: dict.title, rev: dict.rev, instance, page: p.page,
      section: '(unassigned)', line: '', label: margin ? 'Software note in the page margin' : 'Text outside any box', desc: `Printed on ${dict.title} page ${bp.page} outside every box`,
      kind: amt !== null ? 'amount' : 'text', value: amt ?? raw, raw, method: 'geometry', bbox,
    })
  })
  filerMarks.forEach((m, i) => {
    if (usedMarks.has(i)) return
    // A drawn mark outside every check box: almost always a strike-through or
    // signature flourish; recorded, not counted against completeness.
    residue.push({ text: '[mark]', bbox: m })
  })
  return { entries, unassignedAmounts, residue }
}

/** A page's words grouped into printed lines, left to right. */
function pageLines(p: LayoutPage): TextRun[][] {
  const words = readingOrder(p.runs.flatMap(r => splitWords(r)))
  const lines: TextRun[][] = []
  for (const w of words) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(center(last[0].bbox)[1] - center(w.bbox)[1]) <= 2.5) last.push(w)
    else lines.push([w])
  }
  return lines.map(ws => ws.sort((a, b) => a.bbox[0] - b.bbox[0]))
}

const lineBox = (ws: TextRun[]): BBox => [Math.min(...ws.map(w => w.bbox[0])), Math.min(...ws.map(w => w.bbox[1])), Math.max(...ws.map(w => w.bbox[2])), Math.max(...ws.map(w => w.bbox[3]))]

/** Worksheets print check boxes as a bare "X" next to "Yes"/"No". Attach
 *  each X to the label it belongs to — the box precedes its label, so the
 *  nearest label to its right (else to its left) — and render "☐Yes ☒No".
 *  Read naively, "Yes X No" looks like a Yes (EZA's 2023 §199A worksheet says
 *  NOT an SSTB, with the X in front of "No"). */
function markAnswers(ws: TextRun[]): string {
  const labels = ws.filter(w => /^(Yes|No)$/i.test(w.text))
  const marks = ws.filter(w => /^[Xx✔✓]$/.test(w.text))
  if (labels.length < 2 || !marks.length) return ws.map(w => w.text).join(' ')
  const ticked = new Set<TextRun>()
  for (const m of marks) {
    const right = labels.filter(l => l.bbox[0] >= m.bbox[2] - 1 && l.bbox[0] - m.bbox[2] <= 30).sort((a, b) => a.bbox[0] - b.bbox[0])[0]
    const left = labels.filter(l => l.bbox[2] <= m.bbox[0] + 1 && m.bbox[0] - l.bbox[2] <= 30).sort((a, b) => b.bbox[2] - a.bbox[2])[0]
    const owner = right ?? left
    if (owner) ticked.add(owner)
  }
  return ws.filter(w => !marks.includes(w) || ![...ticked].length)
    .map(w => (labels.includes(w) ? `${ticked.has(w) ? '☒' : '☐'}${w.text}` : w.text)).join(' ')
}

/** Statement / worksheet / unmatched page → one row per printed line. */
function statementPage(p: LayoutPage): { entries: CatalogEntry[]; heading: string } {
  const textLines = pageLines(p)
  const heading = textLines.slice(0, 3).map(ws => ws.map(w => w.text).join(' ')).join(' / ').slice(0, 200)
  const entries: CatalogEntry[] = textLines.map((ws, i) => {
    const raw = markAnswers(ws)
    // An amount on a statement row has a separator, or sits in the right part
    // of the page (years and line numbers in the description stay text).
    const amtWords = ws.filter(w => isAmount(w.text) && (/[,.]/.test(w.text) || w.bbox[0] > p.width * 0.55))
    const amounts = amtWords.map(w => parseAmount(w.text)).filter((n): n is number => n !== null)
    const label = ws.filter(w => !amtWords.includes(w)).map(w => w.text).join(' ').trim()
    const bbox: BBox = [Math.min(...ws.map(w => w.bbox[0])), Math.min(...ws.map(w => w.bbox[1])), Math.max(...ws.map(w => w.bbox[2])), Math.max(...ws.map(w => w.bbox[3]))]
    return {
      id: `stmt:p${p.page}:r${i + 1}`,
      form: 'statement', title: 'Statement or worksheet', rev: '', instance: '', page: p.page,
      section: heading, line: String(i + 1), label, desc: heading,
      kind: 'row' as const, value: amounts.length ? amounts[amounts.length - 1] : (label || raw), raw,
      ...(amounts.length ? { amounts } : {}), method: 'row' as const, bbox,
    }
  })
  return { entries, heading }
}

/** Does an unmatched page look like an official IRS form we lack a blank for? */
function looksLikeIrsForm(p: LayoutPage): string | null {
  const top = p.runs.filter(r => r.bbox[1] < p.height * 0.15).map(r => r.text).join(' ')
  if (!/OMB No\.|Department of the Treasury|Internal Revenue Service/.test(top)) return null
  const m = /(?:Form|SCHEDULE|Schedule)\s+([0-9]{3,4}[A-Z0-9-]*|[A-Z0-9-]{1,4})/.exec(top)
  return m ? m[0] : 'an IRS form'
}

export interface CatalogOptions {
  filename: string
  taxYear?: number
  /** override for tests */
  pages?: IndexedPage[]
}

export async function catalogPdf(bytes: Uint8Array, opts: CatalogOptions): Promise<Catalog> {
  const layout = await readLayout(bytes)
  const all = opts.pages
  const pages: CatalogPage[] = []
  const entries: CatalogEntry[] = []
  const seen = new Map<string, number>()
  const firstValues = new Map<string, Map<string, string>>()
  let copyConflicts = 0
  const problems: string[] = []
  const warnings: string[] = []

  const tctx: TranscriptContext = { section: 'Header' }
  for (const p of layout) {
    if (p.runs.length && isTranscriptText(p.runs.map(r => r.text).join(' '))) {
      const tl = pageLines(p).map(ws => ({ raw: ws.map(w => w.text).join(' '), bbox: lineBox(ws) }))
      const te = transcriptEntries(tl, p.page, tctx)
      entries.push(...te)
      pages.push({ page: p.page, kind: 'transcript', heading: `IRS transcript${tctx.form ? ' Form ' + tctx.form : ''}${tctx.period ? ' period ending ' + tctx.period : ''}`, entries: te.length, residue: [] })
      continue
    }
    if (!p.runs.length) {
      pages.push({ page: p.page, kind: 'blank', entries: 0, residue: [] })
      problems.push(`page ${p.page}: no text layer (scanned or empty) — nothing could be read`)
      continue
    }
    const idx = textIndex(p.runs)
    const hit = classify(p, idx, all, opts.taxYear)
    if (!hit) {
      const st = statementPage(p)
      entries.push(...st.entries)
      const irs = looksLikeIrsForm(p)
      if (irs) warnings.push(`page ${p.page}: looks like ${irs} but no blank matches, so it is kept as text rows — add the form to scripts/catalog/blanks_manifest.ts`)
      pages.push({ page: p.page, kind: 'statement', heading: st.heading, entries: st.entries.length, residue: [] })
      continue
    }
    const { cand } = hit
    const key = `${cand.dict.form}--${cand.dict.rev}#p${cand.page.page}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    const repeatable = REPEATABLE.has(cand.dict.form)
    const instance = n === 1 ? '' : repeatable ? `#${n}` : `copy${n}`
    const fp = formPage(hit.aligned ? alignToBlank(p, cand) : p, cand, instance, hit.aligned)
    entries.push(...fp.entries)
    if (fp.unassignedAmounts) problems.push(`page ${p.page} (${cand.dict.title} ${cand.dict.rev} p${cand.page.page}): ${fp.unassignedAmounts} amount(s) printed outside every box`)
    const vals = new Map(fp.entries.filter(e => e.widget).map(e => [e.widget!, String(e.value)]))
    if (n === 1) firstValues.set(key, vals)
    else if (!repeatable) {
      const first = firstValues.get(key)!
      const names = new Set([...first.keys(), ...vals.keys()])
      let diff = 0
      for (const nm of names) if ((first.get(nm) ?? '') !== (vals.get(nm) ?? '')) diff++
      if (diff) {
        copyConflicts++
        warnings.push(`page ${p.page}: second copy of ${cand.dict.title} p${cand.page.page} differs from the first in ${diff} box(es)`)
      }
    }
    pages.push({
      page: p.page,
      kind: n > 1 && !repeatable ? 'duplicate' : 'form',
      form: cand.dict.form, title: cand.dict.title, rev: cand.dict.rev, blank_page: cand.page.page,
      instance, score: Math.round(hit.score * 1000) / 1000, ...(hit.aligned ? { aligned: true } : {}),
      entries: fp.entries.length, residue: fp.residue,
    })
  }

  const coverage = {
    pages: pages.length,
    form_pages: pages.filter(p => p.kind === 'form').length,
    statement_pages: pages.filter(p => p.kind === 'statement').length,
    duplicate_pages: pages.filter(p => p.kind === 'duplicate').length,
    transcript_pages: pages.filter(p => p.kind === 'transcript').length,
    blank_pages: pages.filter(p => p.kind === 'blank').length,
    entries: entries.length,
    residue_tokens: pages.reduce((s, p) => s + p.residue.length, 0),
    copy_conflicts: copyConflicts,
    complete: false,
    problems,
    warnings,
  }
  // Complete = nothing unreadable and every amount in a form's body is on a
  // line. Pages kept as rows lose no data (every printed line is stored), so a
  // missing blank is a warning about structure, not a gap.
  coverage.complete = problems.length === 0

  return {
    version: 1,
    extractor: EXTRACTOR_VERSION,
    source: { filename: opts.filename, sha256: createHash('sha256').update(bytes).digest('hex'), pages: layout.length },
    ...(opts.taxYear ? { tax_year: opts.taxYear } : {}),
    pages,
    entries,
    coverage,
  }
}
