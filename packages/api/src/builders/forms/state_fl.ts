/**
 * Florida F-1120 corporate income/franchise tax return, drawn on the
 * Department's own form (data/state_forms/fl_f1120_2025.pdf, R. 01/26).
 *
 * Why this exists (2026-10-15 parity sprint): the 2025 Form 1120 was filed with
 * a Florida return and our package had none. Florida publishes F-1120 only as
 * a flat hand-print form — no form fields — so values are drawn at measured
 * coordinates (state_fl_layout_2025.ts): amounts one digit per box with the
 * cents in their own two boxes, identifiers and dates one character per box,
 * Yes/No answers as an X in the printed box.
 *
 * The filed copy was the filer's software's substitute form: different page
 * breaks (lines 14-19 on page 1, not 2), its own form code, a coupon data
 * block and two "DATA" scan pages. Those are that vendor's artifacts; this
 * prints the official form, and the parity harness compares Florida by value
 * rather than by box for exactly that reason.
 *
 * Data: input_data.state_fl_f1120 on the federal 1120, keyed by line (L1..L19,
 * schedI_L1.., schedIIIA_L1_a.., question letters). Values are carried as
 * filed; computing them (federal TI + additions - subtractions, the $50,000
 * exemption — shared across a controlled group — and the 5.5% rate) is later
 * engine work. FEIN defaults to the entity's.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import type { Attachment, AttachmentContext } from './types.js'
import {
  FL_AMOUNTS, FL_CELL_H, FL_CELL_W, FL_CELLS, FL_COMB, FL_COUPON_YEAR_ENDING,
  FL_PAGE_HEADERS, FL_TEXT, FL_TICKS,
} from './state_fl_layout_2025.js'
import type { FlComb } from './state_fl_layout_2025.js'

const VERIFIED_YEAR = 2025
const SEQ = 1200
const SIZE = 9
const BLACK = rgb(0, 0, 0)

function amount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) throw new Error(`FL F-1120: "${v}" is not an amount`)
  return n
}

export async function buildFlF1120(ctx: AttachmentContext): Promise<Attachment | null> {
  const data = ctx.inputData.state_fl_f1120
  if (!data || typeof data !== 'object' || !Object.keys(data).length) return null
  if (ctx.taxYear !== VERIFIED_YEAR) {
    console.error(`[state_fl] F-1120: layout verified for ${VERIFIED_YEAR} (R. 01/26) only; not rendering tax year ${ctx.taxYear}`)
    return null
  }
  const path = `data/state_forms/fl_f1120_${VERIFIED_YEAR}.pdf`
  if (!existsSync(path)) return null
  const pdf = await PDFDocument.load(readFileSync(path))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pages = pdf.getPages()
  let filled = 0

  const page = (n: number): PDFPage => pages[n - 1]
  const draw = (p: number, s: string, x: number, base: number, f: PDFFont = font, size = SIZE) => {
    const pg = page(p)
    pg.drawText(s, { x, y: pg.getHeight() - base, size, font: f, color: BLACK })
  }
  const centred = (p: number, s: string, cx: number, base: number, f: PDFFont = font, size = SIZE) =>
    draw(p, s, cx - f.widthOfTextAtSize(s, size) / 2, base, f, size)
  const cellBase = (y: number) => y + FL_CELL_H / 2 + SIZE * 0.35

  const fein = String(data.fein ?? ctx.entity.ein ?? '')
  const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '')

  function comb(key: string, spec: FlComb, v: unknown) {
    const n = amount(v)
    if (n === null) return
    const whole = Math.trunc(Math.abs(Math.round(n * 100)) / 100)
    const cents = String(Math.abs(Math.round(n * 100)) % 100).padStart(2, '0')
    const ds = String(whole)
    if (ds.length > spec.dollars.length) throw new Error(`FL F-1120 ${key}: ${ds.length} digits for ${spec.dollars.length} boxes`)
    const start = spec.dollars.length - ds.length
    ds.split('').forEach((d, i) => centred(spec.page, d, spec.dollars[start + i] + FL_CELL_W / 2, cellBase(spec.y)))
    cents.split('').forEach((d, i) => spec.cents[i] !== undefined && centred(spec.page, d, spec.cents[i] + FL_CELL_W / 2, cellBase(spec.y)))
    if (n < 0) {
      // Lines 1-8 have a "negative" box; elsewhere the minus goes in the box before the first digit.
      if (spec.neg !== null) centred(spec.page, 'X', spec.neg + FL_CELL_W / 2, cellBase(spec.y), bold)
      else if (start > 0) centred(spec.page, '-', spec.dollars[start - 1] + FL_CELL_W / 2, cellBase(spec.y))
      else throw new Error(`FL F-1120 ${key}: no box left for the minus sign`)
    }
    filled++
  }

  function cells(key: string, s: string) {
    const spec = FL_CELLS[key]
    if (!s) return
    if (s.length > spec.xs.length) throw new Error(`FL F-1120 ${key}: ${s.length} characters for ${spec.xs.length} boxes`)
    s.split('').forEach((c, i) => centred(spec.page, c, spec.xs[i] + FL_CELL_W / 2, cellBase(spec.y)))
    filled++
  }

  function text(key: string, v: unknown, spec = FL_TEXT[key] ?? FL_AMOUNTS[key]) {
    if (v === null || v === undefined || v === '') return
    const isAmount = key in FL_AMOUNTS || /^L1[46][a-d]$/.test(key)
    const s = isAmount ? String(Math.round(amount(v)!)) : String(v)
    const x = spec.align === 'right' ? spec.x - font.widthOfTextAtSize(s, SIZE) : spec.x
    draw(spec.page, s, x, spec.base)
    filled++
  }

  function tick(key: string, v: unknown) {
    if (v === null || v === undefined || v === '' || v === false) return
    const opt = v === true ? 'yes' : String(v).toLowerCase() === 'true' ? 'yes' : String(v)
    const spec = FL_TICKS[`${key}:${opt}`] ?? FL_TICKS[`${key}:${opt.toLowerCase()}`] ?? FL_TICKS[`${key}:${opt.toUpperCase()}`]
    if (!spec) throw new Error(`FL F-1120 ${key}: no box for "${v}"`)
    centred(spec.page, 'X', spec.x, spec.base, bold)
    filled++
  }

  // Amount boxes (lines 1-19, coupon). The coupon repeats lines 17-19 unless told otherwise.
  const couponDefaults: Record<string, unknown> = {
    coupon_amount_due: (amount(data.L17) ?? 0) > 0 ? data.L17 : undefined,
    coupon_credit: data.L18, coupon_refund: data.L19,
  }
  for (const [key, spec] of Object.entries(FL_COMB)) comb(key, spec, key in data ? data[key] : couponDefaults[key])

  // One-character boxes
  cells('fein', digits(fein))
  cells('coupon_fein', digits(data.coupon_fein ?? fein))
  cells('year_end_date', digits(data.year_end_date))
  cells('E_activity_code', digits(data.E_activity_code))
  const ye = digits(data.coupon_year_ending ?? data.year_end_date)
  if (ye) {
    if (ye.length > FL_COUPON_YEAR_ENDING.xs.length) throw new Error('FL F-1120 coupon_year_ending: expected MMDDYY')
    ye.split('').forEach((c, i) => centred(FL_COUPON_YEAR_ENDING.page, c, FL_COUPON_YEAR_ENDING.xs[i], FL_COUPON_YEAR_ENDING.base))
    filled++
  }

  // Text and schedule amounts
  const couponText: Record<string, unknown> = {
    coupon_name: data.coupon_name ?? data.name, coupon_address: data.coupon_address ?? data.address,
    coupon_city_state: data.coupon_city_state, coupon_zip: data.coupon_zip,
  }
  for (const key of Object.keys(FL_TEXT)) text(key, key in couponText ? couponText[key] : data[key])
  for (const key of Object.keys(FL_AMOUNTS)) text(key, data[key])

  // Pages 3-6 header
  for (const h of FL_PAGE_HEADERS) {
    if (data.name) draw(h.page, String(data.name), h.name, h.base)
    if (fein) draw(h.page, fein, h.fein, h.base)
    if (data.taxable_year_ending) draw(h.page, String(data.taxable_year_ending), h.year, h.base)
  }

  // Check boxes
  for (const key of ['name_address_changed', 'preparer_self_employed', 'C_consolidated', 'D_initial', 'D_final',
    'F_extension', 'G1_controlled_group', 'G2_federal_consolidated', 'G3_parent_in_florida', 'I_partnership',
    'L_federal_return']) tick(key, data[key])

  return { seq: SEQ, label: 'FL F-1120', pdf, filled }
}
