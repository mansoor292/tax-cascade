/**
 * End to end, with no taxpayer data: fill the official 2024 Form 1120-S with
 * known values, flatten it the way filing software prints a return, catalogue
 * it, and require every value back on its line — the property the whole
 * catalog rests on.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { catalogPdf } from './extract.js'
import { loadDicts } from './dicts.js'
import { checkTies } from './ties.js'
import type { Catalog, DictWidget } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BLANK = join(HERE, '..', '..', 'data', 'irs_forms', 'f1120s_2024.pdf')

function widget(sel: { section?: string; line: string; col?: string; kind?: string }): DictWidget {
  const d = loadDicts().dicts.find(x => x.form === 'f1120s' && x.rev === '2024')!
  const w = d.widgets.find(x => x.line === sel.line && (sel.section ?? '') === x.section && (sel.col === undefined ? !x.col : x.col === sel.col) && (!sel.kind || x.kind === sel.kind))
  if (!w) throw new Error(`no widget for ${JSON.stringify(sel)}`)
  return w
}

describe('catalogue a flattened official Form 1120-S', () => {
  let cat: Catalog
  const VALUES: Array<[{ section?: string; line: string; col?: string }, string, number]> = [
    [{ line: '1a' }, '8,895,990', 8895990],
    [{ line: '1b' }, '1,800,000', 1800000],
    [{ line: '1c' }, '7,095,990', 7095990],
    [{ line: '2' }, '1,670,000', 1670000],
    [{ line: '3' }, '5,425,990', 5425990],
    [{ line: '6' }, '5,425,990', 5425990],
    [{ line: '7' }, '60,000', 60000],
    [{ line: '21' }, '60,000', 60000],
    [{ line: '22' }, '5,365,990', 5365990],
    [{ section: 'Schedule L', line: '19', col: 'd' }, '1,040,000', 1040000],
    [{ section: 'Schedule L', line: '19', col: 'b' }, '3,000', 3000],
  ]

  beforeAll(async () => {
    const pdf = await PDFDocument.load(readFileSync(BLANK), { ignoreEncryption: true })
    const form = pdf.getForm()
    for (const [sel, text] of VALUES) form.getTextField(widget(sel).name).setText(text)
    form.getCheckBox(widget({ section: 'Schedule B', line: '1a', kind: 'check' }).name).check()
    form.flatten()
    const bytes = new Uint8Array(await pdf.save())
    cat = await catalogPdf(bytes, { filename: 'synthetic-1120s-2024.pdf', taxYear: 2024 })
  }, 60_000)

  it('classifies every page as the 2024 Form 1120-S and loses nothing', () => {
    const forms = cat.pages.filter(p => p.kind === 'form')
    expect(forms.length).toBe(5)
    expect(new Set(forms.map(p => `${p.form}--${p.rev}`))).toEqual(new Set(['f1120s--2024']))
    expect(cat.coverage.complete).toBe(true)
  })

  it('puts every value on its line', () => {
    for (const [sel, , value] of VALUES) {
      const e = cat.entries.find(x => x.form === 'f1120s' && x.line === sel.line && (sel.section ?? '') === x.section && (sel.col === undefined ? !x.col : x.col === sel.col))
      expect(e?.value, JSON.stringify(sel)).toBe(value)
      expect(e?.kind).toBe('amount')
    }
  })

  it('reads the ticked box', () => {
    const e = cat.entries.find(x => x.section === 'Schedule B' && x.line === '1a' && x.kind === 'check')
    expect(e?.value).toBe(true)
  })

  it('its arithmetic ties hold', () => {
    const broken = checkTies(cat.entries).filter(t => !t.ok)
    expect(broken).toEqual([])
  })
})
