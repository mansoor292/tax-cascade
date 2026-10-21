/**
 * The golden schema: one key for every box of every IRS form we catalogue,
 * the same key in every year the box exists.
 *
 * Why (owner, 2026-10-20): a filed return, the IRS's processed copy, a
 * proforma, an amendment, a scenario and the books must line up box by box
 * before anything can be compared or filled. Until now only the boxes the
 * PDF builder fills carried a key — 893 of 40,448 boxes (2.2%), the main form
 * in 2024/25 and the 1040 since 2022 — and the IRS renumbers lines (1120-S
 * ordinary business income is line 21 on the 2022 form, line 22 from 2023),
 * so a key on a line number alone means a different thing in different years.
 *
 * How: keys are anchored on the newest revision of each form and carried
 * back year by year by matching boxes on the IRS's own description of them
 * (the XFA text in data/line_dicts), not on the line number:
 *   1. a VERIFIED key (the PDF builder's field maps) always wins;
 *   2. a key the engine already writes for that line (`f7203.L3a_…`,
 *      `schedE.L26_…`) is adopted, so engine output lines up;
 *   3. otherwise one is generated: `<prefix>.L<line>_<words>[_<column>]`.
 * Matching an older box to a newer one, in order of trust: same line and the
 * same description; the same description on another line (a renumbering —
 * only when that description is unique in both years); the same line and a
 * similar description. Anything unmatched is a box that did not exist in the
 * newer year and gets a key of its own.
 *
 * Pure functions here; scripts/schema/build_schema.ts does the I/O and
 * writes data/schema/<form>.json.gz, a reviewable, committed artifact.
 */
import type { DictWidget, LineDict } from '../catalog/types.js'

export type KeySource = 'verified' | 'engine' | 'generated'

export interface SchemaKey {
  key: string
  form: string
  section: string
  line: string
  row?: string
  col?: string
  /** The IRS's description of the box, from the newest revision that has it */
  label: string
  kind: DictWidget['kind']
  revs: string[]
  source: KeySource
  /** Other names the engine writes for the same box */
  aliases?: string[]
  /** Where the box sits on an older revision, when that differs from the
   *  newest (the 2023 1040 prints AGI on line 11; the 2025 form on 11a). A
   *  year's view prints that year's line and words, not the newest form's. */
  at?: Record<string, KeyPlace>
}

export interface KeyPlace { section: string; line: string; col?: string; label: string }

export interface FormSchema {
  form: string
  title: string
  keys: SchemaKey[]
  /** rev → full widget name → key */
  revisions: Record<string, Record<string, string>>
  report: CrosswalkReport
}

export interface CrosswalkReport {
  widgets: number
  by: Record<'verified' | 'engine' | 'same_line' | 'renumbered' | 'similar' | 'by_name' | 'generated' | 'renamed', number>
  /** Blind check: for revisions with a verified map, how often matching alone
   *  (ignoring that map) chose the verified key */
  blind?: { compared: number; agreed: number; disagreements: Array<{ rev: string; line: string; verified: string; matched: string | null }> }
  /** Fill-map names that contradict the IRS's own description of the box */
  conflicts?: Array<{ rev: string; widget: string; line: string; map_says: string; description_says: string; kept?: 'map' }>
}

/** Engine prefix for a form's boxes. Main forms by section; schedules by the
 *  prefix the engine already writes; anything else by the form's own slug. */
const FORM_PREFIX: Record<string, string> = {
  f1040s1: 'sched1', f1040s2: 'sched2', f1040s3: 'sched3', f1040sc: 'schedC', f1040sd: 'schedD',
  f1040se: 'schedE', f1040s8: 'f8812', f4562: 'dep',
  // the engine writes Form 1125-A as cogs.*, the 1040's Schedule B as schedB.*
  // and Form 1120-X as amended.*
  f1125a: 'cogs', f1040sb: 'schedB', f1120x: 'amended',
}
const SECTION_PREFIX: Record<string, string> = {
  'Schedule B': 'schedB', 'Schedule C': 'schedC', 'Schedule J': 'schedJ', 'Schedule K': 'schedK',
  'Schedule L': 'schedL', 'Schedule M-1': 'schedM1', 'Schedule M-2': 'schedM2',
}
const MAIN = new Set(['f1040', 'f1120', 'f1120s'])

export function prefixFor(form: string, section: string): string {
  if (MAIN.has(form)) return SECTION_PREFIX[section] ?? (form === 'f1040' && section === '' ? 'f1040' : 'meta')
  return FORM_PREFIX[form] ?? form
}

/** "L22", "J1a" (1120 Schedule J, as the engine writes it), "D" (a lettered item). */
export function lineToken(prefix: string, line: string, row?: string): string {
  if (!line) return ''
  const l = line.replace(/[^A-Za-z0-9]/g, '')
  const r = row ? `_r${row.replace(/[^A-Za-z0-9]/g, '')}` : ''
  if (prefix === 'schedJ') return `J${l}${r}`
  return /^\d/.test(l) ? `L${l}${r}` : `${l}${r}`
}

const STOP = new Set(['the', 'of', 'and', 'or', 'a', 'an', 'to', 'for', 'from', 'on', 'in', 'is', 'if', 'this', 'that', 'your', 'you', 'by', 'with', 'see', 'instructions', 'enter', 'here', 'attach', 'statement', 'form', 'schedule', 'line', 'lines', 'amount', 'add', 'subtract', 'through', 'other', 'any'])

/** The description with its own line marker, cross-references to other line
 *  numbers, years and instructions removed — what stays the same when the
 *  IRS renumbers a line ("Ordinary business income (loss). Subtract line 20
 *  from line 6" in 2022 and "… line 21 …" in 2023 normalise alike). */
export function normLabel(label: string): string {
  return label.toLowerCase()
    .replace(/^\s*(line\s+)?[0-9]{1,2}[a-z]?\s*[.:)]\s*/, '')
    .replace(/^\s*[a-z]\d?\s*[.:)]\s+/, '')
    .replace(/\b(lines?|line)\s+\d+[a-z]?(\s*(,|and|or|through|to|from|minus|plus|-)\s*(line\s+)?\d+[a-z]?)*/g, ' ')
    .replace(/\b(19|20)\d\d\b/g, ' ')
    .replace(/\(\s*(see|attach|if|enter)[^)]*\)/g, ' ')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/(^| )[a-z](?= |$)/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function words(label: string): string[] {
  return normLabel(label).split(' ').filter(w => w && !STOP.has(w) && !/^\d+$/.test(w))
}

export function slugOf(label: string, max = 4): string {
  const w = words(label).slice(0, max)
  return (w.join('_') || 'box').replace(/%/g, 'pct').slice(0, 40)
}

export function generatedKey(form: string, w: Pick<DictWidget, 'section' | 'line' | 'row' | 'col' | 'label' | 'kind' | 'export'>): string {
  // a numbered line on a main form's page 1 with no fill-map name: the
  // form's own prefix (meta. is the page header)
  let prefix = MAIN.has(form) && w.section === '' && w.line ? form : prefixFor(form, w.section)
  const tok = lineToken(prefix, w.line, w.row)
  // income./cogs./deductions./tax./payments. keys always carry a line number
  // (canonical_schema rejects the old descriptive shape without one): a header
  // box on those forms takes the form's own prefix
  if (!tok && ['income', 'cogs', 'deductions', 'tax', 'payments'].includes(prefix)) prefix = form
  const col = w.col ? `_${w.col.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}` : ''
  // A Yes/No pair shares its description; the export value tells them apart.
  const exp = w.kind !== 'text' && w.export && /^[A-Za-z0-9]{1,8}$/.test(w.export) ? `_x${w.export.toLowerCase()}` : ''
  return `${prefix}.${tok ? `${tok}_` : 'hdr_'}${slugOf(w.label)}${col}${exp}`
}

/** An engine key's line token and column: `f7203.L3a_ordinary_income` →
 *  { prefix f7203, token L3a }; `schedD.L1a_proceeds_d` → column d. */
export function parseEngineKey(key: string): { prefix: string; token: string; col?: string } | null {
  const m = /^([A-Za-z0-9_]+)\.((?:L|J)\d+[a-z]?(?:_r\d+)?)_([a-z0-9_]+)$/.exec(key)
  if (!m) return null
  const col = /_([a-h])$/.exec(m[3])?.[1]
  return { prefix: m[1], token: m[2], ...(col ? { col } : {}) }
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b)
  // two descriptions with no words left ("Form", "Amount") say nothing about
  // each other — no evidence, not a perfect match
  if (!A.size || !B.size) return 0
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / (A.size + B.size - n)
}

const sig = (w: DictWidget, withLine: boolean) =>
  [w.section, withLine ? w.line : '', w.row ?? '', w.col ?? '', w.kind, normLabel(w.label)].join('|')
const place = (w: DictWidget) => [w.section, w.line, w.row ?? '', w.col ?? '', w.kind].join('|')
/** Printed order: page, then top to bottom, then left to right (the
 *  dictionary's own order is not reliable — the 2025 1040 lists line 16's
 *  "Amount" box before its "(specify)" box). */
const printed = (a: DictWidget, b: DictWidget) => a.page - b.page || Math.round(a.rect[1] - b.rect[1]) || a.rect[0] - b.rect[0]

/** Match an older revision's boxes to a newer one's (whose keys are known).
 *  Returns old widget name → newer widget name, and how each was matched. */
export type MatchHow = 'same_line' | 'renumbered' | 'similar' | 'by_name'
export function matchRevisions(older: DictWidget[], newer: DictWidget[]): Map<string, { to: string; how: MatchHow }> {
  const out = new Map<string, { to: string; how: MatchHow }>()
  const taken = new Set<string>()
  const left = () => older.filter(w => !out.has(w.name))
  const free = () => newer.filter(w => !taken.has(w.name))
  const pairInOrder = (how: 'same_line' | 'renumbered', withLine: boolean, uniqueOnly: boolean) => {
    const groupsNew = new Map<string, DictWidget[]>()
    for (const w of free()) groupsNew.set(sig(w, withLine), [...(groupsNew.get(sig(w, withLine)) ?? []), w])
    const groupsOld = new Map<string, DictWidget[]>()
    for (const w of left()) groupsOld.set(sig(w, withLine), [...(groupsOld.get(sig(w, withLine)) ?? []), w])
    for (const [s, olds] of groupsOld) {
      const news = groupsNew.get(s)?.sort(printed)
      olds.sort(printed)
      if (!news || !normLabel(olds[0].label)) continue
      if (uniqueOnly && (olds.length !== 1 || news.length !== 1)) continue
      // repeated boxes on one line (K-1 "Line 1 of 5 … Code") pair in printed order
      for (let i = 0; i < Math.min(olds.length, news.length); i++) {
        out.set(olds[i].name, { to: news[i].name, how })
        taken.add(news[i].name)
      }
    }
  }
  pairInOrder('same_line', true, false)
  // A renumbering: the same description on another line, unique in both years
  // and specific enough (two words or more) to trust.
  pairInOrder('renumbered', false, true)
  // (two tokens of the full description — "other deductions" is specific,
  // although "other" alone is a filler word)
  for (const [k, v] of [...out]) {
    if (v.how === 'renumbered' && normLabel(older.find(w => w.name === k)!.label).split(' ').length < 2) { out.delete(k); taken.delete(v.to) }
  }
  // Same place, similar words (the IRS rewords a description now and then;
  // header boxes too: "TYPE OR PRINT. Name" became "Name")
  for (const w of left()) {
    const cands = free().filter(n => place(n) === place(w) && (w.line || n.page === w.page))
      .map(n => ({ n, s: jaccard(words(w.label), words(n.label)) }))
      .filter(x => x.s >= 0.4).sort((a, b) => b.s - a.s)
    if (cands.length && (cands.length === 1 || cands[0].s > cands[1].s)) {
      out.set(w.name, { to: cands[0].n.name, how: 'similar' })
      taken.add(cands[0].n.name)
    }
  }
  // A line the IRS split ("7" became "7a", "11" became "11a" on the 2025
  // 1040): the same line number family and largely the same words.
  const family = (l: string) => /^\d+/.exec(l)?.[0] ?? ''
  for (const w of left()) {
    if (!family(w.line)) continue
    const cands = free().filter(n => family(n.line) === family(w.line) && n.section === w.section && (n.col ?? '') === (w.col ?? '') && n.kind === w.kind)
      .map(n => ({ n, s: jaccard(words(w.label), words(n.label)) }))
      .filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s)
    if (cands.length && (cands.length === 1 || cands[0].s > cands[1].s)) {
      out.set(w.name, { to: cands[0].n.name, how: 'similar' })
      taken.add(cands[0].n.name)
    }
  }
  // The same line with the same number of boxes in both years, the
  // descriptions too terse to compare (the 2025 1040 labels many boxes just
  // "Amount"): pair them in printed order.
  {
    const groupsNew = new Map<string, DictWidget[]>()
    for (const n of free()) if (n.line) groupsNew.set(place(n), [...(groupsNew.get(place(n)) ?? []), n])
    const groupsOld = new Map<string, DictWidget[]>()
    for (const w of left()) if (w.line) groupsOld.set(place(w), [...(groupsOld.get(place(w)) ?? []), w])
    for (const [pl, olds] of groupsOld) {
      const news = groupsNew.get(pl)?.sort(printed)
      olds.sort(printed)
      if (!news || news.length !== olds.length) continue
      // never pair two boxes whose descriptions plainly disagree (2022 1120-S
      // line 19 "Other deductions" is not 2023 line 19 "Energy efficient
      // commercial buildings deduction" — it moved to line 20)
      const disagree = olds.some((w, i) => words(w.label).length && words(news[i].label).length && jaccard(words(w.label), words(news[i].label)) === 0)
      if (disagree) continue
      olds.forEach((w, i) => { out.set(w.name, { to: news[i].name, how: 'similar' }); taken.add(news[i].name) })
    }
  }
  // Boxes the IRS left undescribed (Schedule O) or reworded past recognition,
  // header boxes above all: the same place on the same page. Position, not
  // the field name — names shift when a box is inserted (1040 2022 → 2023
  // moved every header name one along).
  for (const w of left()) {
    const cands = free().filter(n => n.page === w.page && place(n) === place(w))
      .map(n => ({ n, o: overlap(n.rect, w.rect) })).filter(x => x.o >= 0.5).sort((a, b) => b.o - a.o)
    const n = cands[0]?.n
    if (n && (!words(w.label).length || !words(n.label).length || jaccard(words(w.label), words(n.label)) >= 0.2)) {
      out.set(w.name, { to: n.name, how: 'by_name' })
      taken.add(n.name)
    }
  }
  return out
}

/** Intersection over union of two rectangles. */
function overlap(a: DictWidget['rect'], b: DictWidget['rect']): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  const area = (r: DictWidget['rect']) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
  const u = area(a) + area(b) - inter
  return u > 0 ? inter / u : 0
}

const revNum = (r: string) => Number(r) || 0

/** Engine names that sit under another form's prefix than their box, so the
 *  line-token match cannot find them (the 1040 alias table files Schedule 2's
 *  additional Medicare tax and NIIT under `tax.`). form → { engine name: key }. */
export const EXPLICIT_ALIASES: Record<string, Record<string, string>> = {
  f1040: {
    'result.L37_balance_due': 'owed.L37_amount_owed',
    // older 1040 proformas stored descriptive names (inventory of prod rows, 2026-10-20)
    'income.w2_wages': 'income.L1a_w2_wages', 'deductions.total': 'deductions.L14_total',
    'deductions.taxable_income': 'tax.L15_taxable_income', 'tax.add_16_17': 'tax.L18_add_16_17',
    'tax.other_taxes': 'tax.L23_other_taxes', 'payments.w2_withholding': 'payments.L25a_w2',
    'payments.total_withholding': 'payments.L25d_total', 'payments.estimated': 'payments.L26_estimated',
    'payments.total_payments': 'payments.L33_total', 'result.penalty': 'penalty.L38_est_penalty',
    'preparer.phone': 'preparer.firm_phone',
  },
  f1040s1: { 'schedule1.k1_income': 'sched1.L5_rental_partnership_scorp' },
  f1040s2: { 'tax.L11_addl_medicare': 'sched2.L11_additional_medicare', 'tax.L12_niit': 'sched2.L12_niit' },
  f8959: { 'f8959.L10_wages_from_L4': 'f8959.L10_box' },
  // 2025 split 4562 line 23 into 23a/23b; the builder fills the engine's line-23 figure into 23a (f2_3)
  f4562: { 'dep.L23_263a': 'dep.L23a_assets_shown_part_iii' },
  // one box, two names across the fill maps and the engine
  f1120: { 'meta.business_code': 'meta.business_activity_code', 'preparer.firm_phone': 'preparer.phone' },
  f1120s: { 'meta.business_activity_code': 'meta.business_code', 'preparer.firm_phone': 'preparer.phone' },
}

/** Build one form's schema from all its revisions. `engineKeys` are the keys
 *  the engine writes under this form's prefix. */
export function buildFormSchema(form: string, dicts: LineDict[], engineKeys: string[] = [], opts: { blind?: boolean } = {}): FormSchema {
  const revs = [...dicts].sort((a, b) => revNum(b.rev) - revNum(a.rev))
  const keys = new Map<string, SchemaKey>()
  const revisions: Record<string, Record<string, string>> = {}
  const by: CrosswalkReport['by'] = { verified: 0, engine: 0, same_line: 0, renumbered: 0, similar: 0, by_name: 0, generated: 0, renamed: 0 }
  const blind: NonNullable<CrosswalkReport['blind']> = { compared: 0, agreed: 0, disagreements: [] }
  const conflicts: NonNullable<CrosswalkReport['conflicts']> = []

  // Engine keys by (prefix, token, col): adopted for a box with no verified key.
  const engineAt = new Map<string, string[]>()
  for (const k of engineKeys) {
    const p = parseEngineKey(k)
    if (!p) continue
    const at = `${p.prefix}|${p.token}|${p.col ?? ''}`
    engineAt.set(at, [...(engineAt.get(at) ?? []), k])
  }
  // The amount box of a line is its right-most text box (a line may also
  // carry a small "specify"/form-number box: Schedule 2 line 4).
  const amountBox = new Set<string>()
  for (const d of revs) {
    const right = new Map<string, DictWidget>()
    for (const w of d.widgets) {
      if (w.kind !== 'text' || !w.line) continue
      const at = place(w)
      const cur = right.get(at)
      if (!cur || w.rect[0] > cur.rect[0]) right.set(at, w)
    }
    for (const w of right.values()) amountBox.add(w.name + '@' + d.rev)
  }
  let engineRev = ''
  const engineFor = (w: DictWidget): string[] => {
    // engine keys name amounts — never a check box or a side box of the line
    if (w.kind !== 'text' || !amountBox.has(w.name + '@' + engineRev)) return []
    const prefix = prefixFor(form, w.section)
    const tok = lineToken(prefix, w.line, w.row)
    return tok ? (engineAt.get(`${prefix}|${tok}|${w.col ?? ''}`) ?? []) : []
  }
  const alias = (key: string, other: string) => {
    const k = keys.get(key)!
    if (other !== key && !(k.aliases ?? []).includes(other)) k.aliases = [...(k.aliases ?? []), other]
  }
  /** A generated key renamed to a verified one everywhere it was used. */
  const rename = (from: string, to: string) => {
    const k = keys.get(from)!
    keys.delete(from)
    keys.set(to, { ...k, key: to, source: 'verified' })
    for (const m of Object.values(revisions)) for (const n of Object.keys(m)) if (m[n] === from) m[n] = to
  }
  const claim = (key: string, w: DictWidget, rev: string, source: KeySource, usedInRev: Set<string>, unique = false): string => {
    let k = key
    // one box per key within a revision; a generated key is a new concept, so
    // it must not reuse any key of the form
    for (let i = 2; usedInRev.has(k) || (unique && keys.has(k)); i++) k = `${key}_${i}`
    usedInRev.add(k)
    const cur = keys.get(k)
    if (cur) {
      if (!cur.revs.includes(rev)) cur.revs.push(rev)
    } else {
      keys.set(k, { key: k, form, section: w.section, line: w.line, ...(w.row ? { row: w.row } : {}), ...(w.col ? { col: w.col } : {}), label: w.label, kind: w.kind, revs: [rev], source })
    }
    return k
  }

  let newer: { dict: LineDict; map: Record<string, string> } | null = null
  for (const d of revs) {
    const map: Record<string, string> = {}
    const used = new Set<string>()
    revisions[d.rev] = map
    engineRev = d.rev
    const matched = newer ? matchRevisions(d.widgets, newer.dict.widgets) : new Map<string, { to: string; how: MatchHow }>()
    const carriedOf = (w: DictWidget) => { const m = matched.get(w.name); return m ? { key: newer!.map[m.to], how: m.how } : undefined }
    // Blind check: where both years' fill maps name a box the same, did
    // matching alone pick that box? (Where the maps renamed it, the names
    // cannot judge the match, so those are not counted.)
    if (newer && opts.blind !== false) {
      for (const w of d.widgets) {
        if (!w.canonical) continue
        const truth = newer.dict.widgets.find(n => n.canonical === w.canonical)
        if (!truth) continue
        const m = matched.get(w.name)
        blind.compared++
        if (m?.to === truth.name) blind.agreed++
        else if (blind.disagreements.length < 40) blind.disagreements.push({ rev: d.rev, line: `${w.section} ${w.line}${w.col ? ' ' + w.col : ''}`.trim(), verified: w.canonical, matched: m ? newer.map[m.to] ?? null : null })
      }
    }
    const rest: DictWidget[] = []
    // 1. Boxes carried from the newer year (the same box, possibly renumbered).
    for (const w of d.widgets) {
      const c = carriedOf(w)
      if (!c?.key || used.has(c.key)) { rest.push(w); continue }
      let key = c.key
      if (w.canonical && w.canonical !== key) {
        // The fill map names this box differently from the box it matched.
        //  - The name is new to the form: the fill maps renamed the box
        //    between years — a generated name gives way to it, a verified
        //    one keeps it as an alias.
        //  - The name already belongs to another box: either the match or the
        //    map is wrong. An identical description wins over the map (the
        //    2022 1040 fill map is two boxes off in the header: "first name"
        //    on the box the IRS describes as the SSN); a weaker match gives
        //    way to the map. Both are reported.
        const V = w.canonical
        if (!keys.has(V)) {
          if (keys.get(key)?.source === 'generated') { rename(key, V); key = V; by.renamed++ }
          else alias(key, V)
        } else if (c.how === 'same_line' || c.how === 'renumbered') {
          conflicts.push({ rev: d.rev, widget: w.name, line: `${w.section} ${w.line}`.trim(), map_says: V, description_says: key })
        } else if (!used.has(V)) {
          conflicts.push({ rev: d.rev, widget: w.name, line: `${w.section} ${w.line}`.trim(), map_says: V, description_says: key, kept: 'map' })
          key = V
        }
      }
      map[w.name] = claim(key, w, d.rev, keys.get(key)?.source ?? 'generated', used)
      by[c.how]++
    }
    // 2. Verified keys of boxes new in this year.
    const rest2: DictWidget[] = []
    for (const w of rest) {
      if (w.canonical && !used.has(w.canonical)) { map[w.name] = claim(w.canonical, w, d.rev, 'verified', used); by.verified++ }
      else rest2.push(w)
    }
    // 3. A key the engine already writes for the line; 4. a generated one.
    for (const w of rest2) {
      const eng = engineFor(w).filter(k => !used.has(k) && !keys.has(k))
      if (eng.length) { map[w.name] = claim(eng[0], w, d.rev, 'engine', used); by.engine++; continue }
      map[w.name] = claim(generatedKey(form, w), w, d.rev, 'generated', used, true)
      by.generated++
    }
    newer = { dict: d, map }
  }

  // Engine names for a box that already has a key become aliases of it, so
  // the hub resolves both (schedK.L5a_dividends / schedK.L5a_ordinary_dividends).
  const anchor = revs[0]
  if (anchor) {
    engineRev = anchor.rev
    for (const w of anchor.widgets) {
      const k = revisions[anchor.rev][w.name]
      const extra = engineFor(w).filter(e => e !== k && !keys.has(e))
      if (extra.length) keys.get(k)!.aliases = [...new Set([...(keys.get(k)!.aliases ?? []), ...extra])]
    }
  }
  for (const [name, key] of Object.entries(EXPLICIT_ALIASES[form] ?? {})) if (keys.has(key)) alias(key, name)
  for (const k of keys.values()) {
    k.revs.sort((a, b) => revNum(a) - revNum(b))
    // the newest revision's wording describes the key
    const newest = revs.find(d => d.rev === k.revs[k.revs.length - 1])
    const w = newest?.widgets.find(x => revisions[newest.rev][x.name] === k.key)
    if (w) Object.assign(k, { section: w.section, line: w.line, label: w.label })
  }
  // where each key sits on the older revisions, when that differs
  const widgetOf = new Map<string, Map<string, DictWidget>>()
  for (const d of revs) {
    const m = new Map<string, DictWidget>()
    for (const w of d.widgets) { const k = revisions[d.rev][w.name]; if (k && !m.has(k)) m.set(k, w) }
    widgetOf.set(d.rev, m)
  }
  for (const k of keys.values()) {
    for (const rev of k.revs) {
      const w = widgetOf.get(rev)?.get(k.key)
      if (!w || (w.section === k.section && w.line === k.line && (w.col ?? '') === (k.col ?? '') && w.label === k.label)) continue
      k.at = { ...(k.at ?? {}), [rev]: { section: w.section, line: w.line, ...(w.col ? { col: w.col } : {}), label: w.label } }
    }
  }
  return {
    form, title: revs[0]?.title ?? form,
    keys: [...keys.values()],
    revisions,
    report: { widgets: revs.reduce((s, d) => s + d.widgets.length, 0), by, ...(blind.compared ? { blind } : {}), ...(conflicts.length ? { conflicts } : {}) },
  }
}
