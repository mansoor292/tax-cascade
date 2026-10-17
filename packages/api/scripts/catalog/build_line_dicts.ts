/**
 * Build the catalog's line dictionaries from the IRS's own blank forms.
 *
 *   npx tsx scripts/catalog/build_line_dicts.ts            # all forms below
 *   npx tsx scripts/catalog/build_line_dicts.ts f1120s     # one form, all years
 *
 * For each (form, revision) it downloads the blank from irs.gov/pub/irs-prior
 * (cached in data/irs_blanks_cache, not committed), joins every AcroForm widget
 * (position, kind, export value) to the IRS's accessibility description of that
 * box from the XFA template (see src/catalog/xfa.ts), parses the description
 * into section/line/row/column (src/catalog/describe.ts), records the page's
 * printed template text and drawn rules (subtracted at catalog time), attaches
 * the engine's canonical key where a VERIFIED field map covers the box, and
 * writes data/line_dicts/<form>--<rev>.json.gz.
 *
 * Why build-time and committed: the cataloguer must run in the API (Node, no
 * Python, no network to irs.gov at request time), and a dictionary is a
 * reviewable artifact — a wrong line id shows up in a diff and a test, not as a
 * silently mis-filed value months later.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFString, PDFHexString,
  PDFCheckBox, PDFRadioGroup, PDFRef, decodePDFRawStream,
} from 'pdf-lib'
import { readLayout, splitWords } from '../../src/catalog/pdf_layout.js'
import { parseXfaTemplate } from '../../src/catalog/xfa.js'
import { describe, type DescContext } from '../../src/catalog/describe.js'
import type { DictWidget, DictPage, LineDict } from '../../src/catalog/types.js'
import { BLANKS, titleFor } from './blanks_manifest.js'
import { buildIndex } from '../../src/catalog/dicts.js'
import * as M2024 from '../../src/maps/pdf_field_map_2024.js'
import * as M2025 from '../../src/maps/pdf_field_map_2025.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CACHE = join(ROOT, 'data', 'irs_blanks_cache')
const OUT = join(ROOT, 'data', 'line_dicts')

/** Verified canonical maps only. The "unverified copy" years (1120 2022/2023,
 *  1120-S 2023) are deliberately absent — a canonical key on the wrong box is
 *  worse than none, because checks would trust it. */
const CANONICAL: Record<string, Record<string, string>> = {
  'f1040--2022': M2024.F1040_2022,
  'f1040--2023': M2024.F1040_2023,
  'f1040--2024': M2024.F1040_2024,
  'f1040--2025': M2025.F1040_2025,
  'f1120--2024': M2024.F1120_2024,
  'f1120--2025': M2025.F1120_2025,
  'f1120s--2024': M2024.F1120S_2024,
  'f1120s--2025': M2025.F1120S_2025,
}

async function fetchBlank(slug: string, rev: string): Promise<Uint8Array | null> {
  mkdirSync(CACHE, { recursive: true })
  const file = join(CACHE, `${slug}--${rev}.pdf`)
  if (existsSync(file)) {
    const b = readFileSync(file)
    return b.length > 0 ? new Uint8Array(b) : null
  }
  const url = `https://www.irs.gov/pub/irs-prior/${slug}--${rev}.pdf`
  const res = await fetch(url)
  if (!res.ok) {
    writeFileSync(file, '') // negative cache: this revision doesn't exist
    return null
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  writeFileSync(file, buf)
  return buf
}

function xfaTemplate(pdf: PDFDocument): string | null {
  const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const xfa = acro?.lookup(PDFName.of('XFA'))
  if (!(xfa instanceof PDFArray)) return null
  for (let i = 0; i + 1 < xfa.size(); i += 2) {
    const k = xfa.lookup(i)
    const name = k instanceof PDFString || k instanceof PDFHexString ? k.decodeText() : ''
    if (name !== 'template') continue
    const s = xfa.lookup(i + 1)
    if (s instanceof PDFRawStream) return new TextDecoder().decode(decodePDFRawStream(s).decode())
  }
  return null
}

const FORM_TOKEN = /^(?:\d{3,4}(?:-[A-Z0-9]{1,4})?|\d{4}[A-Z]{1,2}|K-1|W-2|W-3)$/

function headerTokens(page: { height: number; runs: Array<{ text: string; bbox: number[] }> }): string[] {
  const top = page.runs.filter(r => r.bbox[1] < page.height * 0.12)
  const toks = new Set<string>()
  for (const r of top) for (const w of splitWords(r as never)) {
    const t = w.text.replace(/[.,()]/g, '')
    if (FORM_TOKEN.test(t)) toks.add(t)
  }
  return [...toks]
}

async function buildOne(slug: string, rev: string): Promise<LineDict | null> {
  const bytes = await fetchBlank(slug, rev)
  if (!bytes) return null
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const pages = pdf.getPages()
  const pageIndex = new Map<string, number>()
  pages.forEach((p, i) => pageIndex.set(p.ref.toString(), i))
  // Annotation ref → page, for widgets without a /P entry.
  const annotPage = new Map<string, number>()
  pages.forEach((p, i) => {
    const annots = p.node.Annots()
    if (!annots) return
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k)
      if (ref instanceof PDFRef) annotPage.set(ref.toString(), i)
    }
  })

  const layout = await readLayout(bytes)
  const xml = xfaTemplate(pdf)
  const xfa = xml ? parseXfaTemplate(xml) : []
  const xfaByName = new Map(xfa.map(f => [f.name, f]))
  const xfaOrder = new Map(xfa.map((f, i) => [f.name, i]))

  type Raw = { name: string; page: number; rect: [number, number, number, number]; kind: DictWidget['kind']; export?: string }
  const raw: Raw[] = []
  const form = pdf.getForm()
  for (const field of form.getFields()) {
    const name = field.getName()
    const kind: DictWidget['kind'] = field instanceof PDFCheckBox ? 'check' : field instanceof PDFRadioGroup ? 'radio' : 'text'
    const widgets = field.acroField.getWidgets()
    widgets.forEach((w, wi) => {
      const pref = w.P()
      let pi = pref ? pageIndex.get(pref.toString()) : undefined
      if (pi === undefined) {
        const ref = pdf.context.getObjectRef(w.dict)
        if (ref) pi = annotPage.get(ref.toString())
      }
      if (pi === undefined) return
      const pg = pages[pi]
      const { height } = pg.getSize()
      const r = w.getRectangle()
      const rect: [number, number, number, number] = [
        Math.round(r.x * 100) / 100,
        Math.round((height - r.y - r.height) * 100) / 100,
        Math.round((r.x + r.width) * 100) / 100,
        Math.round((height - r.y) * 100) / 100,
      ]
      let exportValue: string | undefined
      if (kind !== 'text') {
        const on = w.getOnValue()
        exportValue = on ? on.decodeText() : undefined
      }
      raw.push({ name: widgets.length > 1 && kind === 'radio' ? `${name}#${wi}` : name, page: pi + 1, rect, kind, export: exportValue })
    })
  }
  // Reading order = XFA template order (what the screen reader walks).
  raw.sort((a, b) => (xfaOrder.get(a.name.split('#')[0]) ?? 1e9) - (xfaOrder.get(b.name.split('#')[0]) ?? 1e9) || a.page - b.page || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])

  const canon = CANONICAL[`${slug}--${rev}`]
  const byShort = new Map<string, string>()
  if (canon) for (const [key, id] of Object.entries(canon)) byShort.set(id, key)

  const widgets: DictWidget[] = []
  let ctxPage = -1
  const ctx: DescContext = { section: '', line: '' }
  // A box spoken only as "No." / "Yes." / "Spouse." takes its question from
  // the box before it on the same line, so the catalog says
  // "Schedule B line 3 — … — No", not just "No".
  let lastQuestion = { line: '', label: '' }
  for (const w of raw) {
    if (w.page !== ctxPage) { ctxPage = w.page; ctx.line = '' }
    const x = xfaByName.get(w.name.split('#')[0])
    const desc = (x?.desc ?? '').replace(/^Page\s+\d+\.\s*/i, '')
    const d = describe(x?.desc ?? '', x?.containers ?? [], ctx)
    // Check boxes only: a TEXT box with a short label ("37. Refunded. Amount")
    // is its own thing — prefixing it labelled EV's 2024 refund as "Credited
    // to 2025 estimated tax — Refunded", and the AI scan read it as a credit.
    if (w.kind !== 'text' && d.label.split(/\s+/).length <= 2 && d.line && d.line === lastQuestion.line && lastQuestion.label) {
      d.label = `${lastQuestion.label} — ${d.label}`
    } else if (d.label.split(/\s+/).length > 2) {
      lastQuestion = { line: d.line, label: d.label.replace(/\s*(?:Yes|No)$/i, '').replace(/[.?]\s*$/, '') }
    }
    const last = w.name.split('.').pop() ?? w.name
    const short = last.replace(/\[0\]$/, '')
    const canonical = byShort.get(short) ?? byShort.get(last)
    widgets.push({
      name: w.name, page: w.page, rect: w.rect, kind: w.kind,
      ...(w.export ?? x?.on ? { export: w.export ?? x?.on } : {}),
      desc, section: d.section, line: d.line,
      ...(d.row ? { row: d.row } : {}),
      ...(d.col ? { col: d.col } : {}),
      label: d.label,
      ...(canonical ? { canonical } : {}),
    })
  }

  const dictPages: DictPage[] = layout.map(p => ({
    page: p.page,
    width: p.width,
    height: p.height,
    header: headerTokens(p),
    template: p.runs.map(r => [r.text, ...r.bbox] as [string, number, number, number, number]),
    // drawn rules/boxes of the blank, subtracted so only filer marks remain
    marks: p.marks,
  })) as DictPage[]

  return {
    form: slug,
    title: titleFor(slug),
    rev,
    source: `https://www.irs.gov/pub/irs-prior/${slug}--${rev}.pdf sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`,
    pages: dictPages,
    widgets,
  }
}

/** The newest revision of a form is often only in irs.gov/pub/irs-pdf (the
 *  prior-year archive lags: 8879-CORP Rev. 2022 and 1120-W 2023/2024 were
 *  missing there on 2026-10-17). Fetch it and name it by the revision year
 *  printed in its header ("(Rev. December 2022)" or the form's tax year). */
async function fetchCurrent(slug: string): Promise<string | null> {
  mkdirSync(CACHE, { recursive: true })
  const res = await fetch(`https://www.irs.gov/pub/irs-pdf/${slug}.pdf`)
  if (!res.ok) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  const [first] = await readLayout(buf, { marks: false })
  const head = (first?.runs ?? []).filter(r => r.bbox[1] < (first?.height ?? 792) * 0.15).map(r => r.text).join(' ')
  const m = /\(Rev\.\s+[A-Za-z]+\s+(\d{4})\)/.exec(head) || /\b(20\d{2})\b/.exec(head)
  if (!m) return null
  const rev = m[1]
  const file = join(CACHE, `${slug}--${rev}.pdf`)
  if (!existsSync(file) || readFileSync(file).length === 0) writeFileSync(file, buf)
  return rev
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const only = process.argv[2]
  const jobs = BLANKS.filter(b => !only || b.slug === only)
  let built = 0, missing = 0
  for (const b of jobs) {
    const current = await fetchCurrent(b.slug).catch(() => null)
    const revs = current && !b.revs.includes(current) ? [...b.revs, current] : b.revs
    for (const rev of revs) {
      const d = await buildOne(b.slug, rev).catch(e => { console.error(`${b.slug}--${rev}: ${e.message}`); return null })
      if (!d) { missing++; continue }
      const noDesc = d.widgets.filter(w => !w.desc).length
      const noLine = d.widgets.filter(w => !w.line).length
      writeFileSync(join(OUT, `${b.slug}--${rev}.json.gz`), gzipSync(JSON.stringify(d)))
      built++
      console.log(`${b.slug}--${rev}: ${d.pages.length}p ${d.widgets.length} boxes, ${noDesc} without IRS text, ${noLine} without a line, ${d.widgets.filter(w => w.canonical).length} canonical`)
    }
  }
  // The always-loaded index the cataloguer selects dictionaries with.
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(buildIndex(OUT)))
  console.log(`built ${built}, revisions not published ${missing}; index written`)
}

main().catch(e => { console.error(e); process.exit(1) })
