/**
 * Build Schedule K-1 PDFs — the ISSUER side of pass-throughs.
 *
 * Born from an SOP-04 tester note: as managing partner she had to send
 * K-1s out, and Cati could only consume them. Two paths:
 *
 *   1120-S — per-shareholder K-1s from the engine's pro-rata `k1s`
 *   allocations (calc1120S), filled onto the official f1120sk1 blank via
 *   the curated F1120SK1_2025 map.
 *
 *   1065 — Cati has NO 1065 return engine (that rule stands); this fills
 *   partner K-1s from caller-supplied Schedule K totals via calc1065K1s'
 *   pro-rata allocator, onto f1065sk1 using the Textract-discovered map.
 *
 * Coded boxes on the 1065 K-1 (13/14/19/20) are NOT guessed onto the form's
 * code/amount pair fields — the discovered map doesn't cover them reliably,
 * and a wrong box on a filing document is worse than an attachment, so they
 * go on a generated statement page. The 2025 1120-S K-1's code/amount rows
 * (boxes 10, 12, 13, 15, 16, 17) were read off the blank's widget
 * rectangles during the 2026-10-15 parity sprint and are filled on the form,
 * as the filed EZ-Advisors K-1 had them (16C, 16D, 17A, 17V); only rows that
 * overflow a box spill to the statement page. The §199A statement (QBI,
 * W-2 wages, UBIA, SSTB flag) is attached when any of its amounts are
 * nonzero, laid out as the filed return's was.
 *
 * Zero amounts stay blank (K-1 convention), matching setField's refusal
 * to fill empty values — pass undefined, not 0.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { readFileSync, existsSync } from 'fs'
import { F1120SK1_2025 } from '../maps/pdf_field_map_2025.js'
import { setField, checkBox } from './pdf_filler.js'
import type { K1Allocation1065 } from '../engine/tax_engine.js'

export interface K1Issuer {
  name: string
  ein?: string
  address?: string
  city?: string
  state?: string
  zip?: string
}

export interface K1Recipient {
  name: string
  tin?: string
  address?: string   // full "street, city, state zip" or multiline
}

export interface K1Pdf {
  recipient: string
  pct: number
  pdf: PDFDocument
  filled: number
}

const nz = (n: number | undefined | null): number | undefined =>
  typeof n === 'number' && Math.round(n) !== 0 ? Math.round(n) : undefined

function issuerBlock(issuer: K1Issuer): string {
  const cityLine = [issuer.city, issuer.state, issuer.zip].filter(Boolean).join(' ')
  return [issuer.name, issuer.address, cityLine].filter(Boolean).join('\n')
}

function recipientBlock(r: K1Recipient): string {
  return [r.name, r.address].filter(Boolean).join('\n')
}

function loadBlank(formName: string, year: number): PDFDocument | Promise<PDFDocument> {
  for (const y of [year, 2025, 2024]) {
    const path = `data/irs_forms/${formName}_${y}.pdf`
    if (existsSync(path)) return PDFDocument.load(readFileSync(path))
  }
  throw new Error(`No blank ${formName} PDF available for ${year}`)
}

// ─── Statement page (shared) ───

interface StatementLine { label: string; amount?: number; text?: string }

async function statementPage(
  title: string, subtitle: string, sections: Array<{ heading: string; lines: StatementLine[] }>,
): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Courier)
  const bold = await pdf.embedFont(StandardFonts.CourierBold)
  const page = pdf.addPage([612, 792])
  let y = 740
  const draw = (text: string, x: number, f = font, size = 10) => {
    page.drawText(text, { x, y, font: f, size, color: rgb(0, 0, 0) })
  }
  draw(title, 72, bold, 12); y -= 16
  draw(subtitle, 72, font, 9); y -= 28
  for (const s of sections) {
    draw(s.heading, 72, bold, 10); y -= 16
    for (const l of s.lines) {
      draw(l.label, 90)
      if (l.amount !== undefined) draw(l.amount.toLocaleString().padStart(14), 400)
      if (l.text) draw(l.text, 400)
      y -= 14
    }
    y -= 12
  }
  return pdf
}

async function appendStatement(main: PDFDocument, stmt: PDFDocument): Promise<void> {
  const pages = await main.copyPages(stmt, stmt.getPageIndices())
  pages.forEach(p => main.addPage(p))
}

// ─── 1120-S Schedule K-1 ───

/** One entry in a coded box (10, 12, 13, 15, 16, 17). `statement` prints the code only, with the amount on the attached statement. */
export interface K1Code { code: string; amount?: number; statement?: boolean }

export interface K1Data1120S {
  name: string
  pct: number
  ordinary_income: number
  charitable: number
  section_179: number
  w2_wages: number
  qbi_income: number
  ubia: number
  interest_income?: number
  dividends_ordinary?: number
  dividends_qualified?: number
  royalties?: number
  st_cap_gain?: number
  lt_cap_gain?: number
  other_portfolio?: number
  tax_exempt_interest?: number
  nondeductible_expenses?: number
  distributions?: number
  investment_income?: number
  rental_real_estate?: number
  other_rental?: number
  collectibles_gain?: number
  unrecaptured_1250?: number
  net_1231_gain?: number
  /** Coded boxes beyond what the allocation above implies (16C, 16D, 17A, 17V, …). */
  codes?: Partial<Record<'10' | '12' | '13' | '15' | '16' | '17', K1Code[]>>
  /** Part I/II items other than the names and identifying numbers. */
  items?: {
    C?: string | null          // IRS center; undefined = "e-file", null/"" = leave blank
    D_boy?: number; D_eoy?: number
    F2_tin?: string; F2_name?: string
    F3?: string
    H_boy?: number; H_eoy?: number
    I_boy?: number; I_eoy?: number
    final?: boolean; amended?: boolean
  }
  /** Section 199A: marks the activity SSTB on the QBI statement. */
  sstb?: boolean
  qbi_1231_gain?: number
  qbi_179?: number
  reit_dividends?: number
  ptp_income?: number
}

/**
 * Coded-box rows on the 2025 K-1, [code, amount] per row, top to bottom —
 * read off the blank's widget rectangles (box 10 has 5 rows, 12 has 8, 13
 * has 5, 15 and 16 have 5, 17 has 10). These used to go on a statement page
 * because the Textract-discovered map did not cover them; the rectangles do.
 */
export const K1_1120S_CODE_ROWS_2025: Record<string, Array<[string, string]>> = (() => {
  const rows = (first: number, count: number): Array<[string, string]> =>
    Array.from({ length: count }, (_, i) => [`f1_${first + 2 * i}`, `f1_${first + 2 * i + 1}`])
  return { '10': rows(33, 5), '12': rows(44, 8), '13': rows(60, 5), '15': rows(70, 5), '16': rows(80, 5), '17': rows(90, 10) }
})()

/** Single boxes and Part I/II items on the 2025 K-1 that F1120SK1_2025 does not carry. */
export const K1_1120S_EXTRA_2025 = {
  L2_rental_re: 'f1_22', L3_other_rental: 'f1_23', L8b_collectibles: 'f1_30', L8c_unrecaptured: 'f1_31',
  D_boy: 'f1_09', D_eoy: 'f1_10', F2_tin: 'f1_13', F2_name: 'f1_14', F3: 'f1_15',
  H_boy: 'f1_17', H_eoy: 'f1_18', I_boy: 'f1_19', I_eoy: 'f1_20',
  final: 'c1_01[0]', amended: 'c1_02[0]',
} as const

/** Whole dollars; zero is a value here (item I can genuinely be 0 at year end). */
const whole = (n: number | undefined): string | undefined =>
  typeof n === 'number' && isFinite(n) ? Math.round(n).toLocaleString('en-US') : undefined

export async function build1120SK1(
  taxYear: number, issuer: K1Issuer & { irs_center?: string | null }, recipient: K1Recipient, k1: K1Data1120S,
): Promise<K1Pdf> {
  const pdf = await loadBlank('f1120sk1', taxYear)
  const form = pdf.getForm()
  const m = F1120SK1_2025
  // The coded rows and Part I/II extras are verified against the 2025 blank
  // only; on any other year's blank they would land in other boxes.
  const layout2025 = taxYear === 2025
  let filled = 0
  const putId = (id: string | undefined, value: string | number | undefined) => {
    if (!id || value === undefined || value === '') return
    if (setField(form, id, value)) filled++
  }
  const put = (key: string, value: string | number | undefined) => putId(m[key], value)

  put('meta.corp_ein', issuer.ein)
  put('meta.corp_name_addr', issuerBlock(issuer))
  const center = k1.items && 'C' in k1.items ? k1.items.C : issuer.irs_center
  put('meta.irs_center', center === undefined ? 'e-file' : (center || undefined))
  put('meta.shareholder_id', recipient.tin)
  put('meta.shareholder_name', recipientBlock(recipient))
  // The form prints the "%" after the box.
  put('meta.alloc_pct', `${k1.pct}`)
  put('L1_ordinary', nz(k1.ordinary_income))
  put('L4_interest', nz(k1.interest_income))
  put('L5a_dividends', nz(k1.dividends_ordinary))
  put('L5b_qual_div', nz(k1.dividends_qualified))
  put('L6_royalties', nz(k1.royalties))
  put('L7_st_gain', nz(k1.st_cap_gain))
  put('L8a_lt_gain', nz(k1.lt_cap_gain))
  put('L9_1231', nz(k1.net_1231_gain))
  put('L11_179', nz(k1.section_179))

  // Coded boxes: what the allocation implies, then what the caller states.
  // 16C, 16D, 17A and 17V used to print only when typed in as supplemental
  // rows, though the engine knows all four: the blind test (2026-10-16) found
  // a K-1 with no distributions and no nondeductible expenses on it — the two
  // figures the shareholder's Form 7203 basis computation is built from.
  const codes: Record<string, K1Code[]> = { '10': [], '12': [], '13': [], '15': [], '16': [], '17': [] }
  if (nz(k1.other_portfolio)) codes['10'].push({ code: 'A', amount: nz(k1.other_portfolio) })
  if (nz(k1.charitable)) codes['12'].push({ code: 'A', amount: nz(k1.charitable) })
  if (nz(k1.tax_exempt_interest)) codes['16'].push({ code: 'A', amount: nz(k1.tax_exempt_interest) })
  if (nz(k1.nondeductible_expenses)) codes['16'].push({ code: 'C', amount: nz(k1.nondeductible_expenses) })
  if (nz(k1.distributions)) codes['16'].push({ code: 'D', amount: nz(k1.distributions) })
  // Section 199A information goes by statement (code V); investment income is code A.
  const hasQbi = [k1.qbi_income, k1.w2_wages, k1.ubia, k1.qbi_1231_gain, k1.qbi_179, k1.reit_dividends, k1.ptp_income].some(v => nz(v))
  if (hasQbi) codes['17'].push({ code: 'V', amount: nz(k1.qbi_income), statement: true })
  if (nz(k1.investment_income)) codes['17'].push({ code: 'A', amount: nz(k1.investment_income) })
  for (const [box, list] of Object.entries(k1.codes || {})) {
    for (const c of list || []) {
      if (!codes[box]) continue
      // A stated code replaces the implied one with the same letter.
      codes[box] = codes[box].filter(x => x.code !== c.code)
      codes[box].push(c)
    }
  }

  const overflow: StatementLine[] = []
  const lineSeventeen: Array<{ code: string; amount?: number }> = []
  if (layout2025) {
    const x = K1_1120S_EXTRA_2025
    putId(x.L2_rental_re, nz(k1.rental_real_estate))
    putId(x.L3_other_rental, nz(k1.other_rental))
    putId(x.L8b_collectibles, nz(k1.collectibles_gain))
    putId(x.L8c_unrecaptured, nz(k1.unrecaptured_1250))
    const it = k1.items || {}
    putId(x.D_boy, whole(it.D_boy)); putId(x.D_eoy, whole(it.D_eoy))
    putId(x.F2_tin, it.F2_tin); putId(x.F2_name, it.F2_name); putId(x.F3, it.F3)
    putId(x.H_boy, whole(it.H_boy)); putId(x.H_eoy, whole(it.H_eoy))
    putId(x.I_boy, whole(it.I_boy)); putId(x.I_eoy, whole(it.I_eoy))
    if (it.final && checkBox(form, x.final)) filled++
    if (it.amended && checkBox(form, x.amended)) filled++

    for (const [box, list] of Object.entries(codes)) {
      const rows = K1_1120S_CODE_ROWS_2025[box]
      // Box 17 with a statement-only code: the first row carries the
      // "See Statement" caption (drawn below), the codes start on the second.
      const needsCaption = box === '17' && list.some(c => c.statement)
      let r = needsCaption ? 1 : 0
      for (const c of list) {
        if (c.statement) lineSeventeen.push({ code: c.code, amount: c.amount })
        if (r >= rows.length) {
          overflow.push({ label: `Box ${box}, code ${c.code}`, amount: c.statement ? undefined : nz(c.amount), text: c.statement ? 'See statement' : undefined })
          continue
        }
        putId(rows[r][0], c.code)
        if (!c.statement) putId(rows[r][1], whole(c.amount))
        r++
      }
      if (needsCaption) {
        const font = await pdf.embedFont(StandardFonts.Helvetica)
        // Between row 1 and row 2 of box 17, where the filed K-1 prints it.
        pdf.getPage(0).drawText('See Statement', { x: 470, y: 792 - 489, size: 10, font, color: rgb(0, 0, 0) })
      }
    }
  } else {
    for (const [box, list] of Object.entries(codes)) {
      for (const c of list) overflow.push({ label: `Box ${box}, code ${c.code}`, amount: nz(c.amount) })
    }
  }

  if (overflow.length) {
    await appendStatement(pdf, await statementPage(
      `Schedule K-1 (Form 1120-S) ${taxYear} — Supplemental Statement`,
      `${issuer.name} — Shareholder: ${recipient.name} (${k1.pct}%)`,
      [{ heading: 'Coded box detail', lines: overflow }],
    ))
  }

  // Section 199A statement (box 17 code V) and the box 17 statement lines.
  if (hasQbi || lineSeventeen.length) {
    await appendStatement(pdf, await k1QbiStatement(issuer, k1, lineSeventeen))
  }
  return { recipient: recipient.name, pct: k1.pct, pdf, filled }
}

/**
 * The statement a filed 1120-S K-1 carries for box 17: the Section 199A
 * table (one row per activity, with the SSTB flag) and the "Line 17 - Other
 * information" list for codes reported by statement. Laid out like the
 * filed 2025 return's, which is what the shareholder's preparer works from.
 */
async function k1QbiStatement(
  issuer: K1Issuer, k1: K1Data1120S, lineSeventeen: Array<{ code: string; amount?: number }>,
): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([612, 792])
  let y = 750
  const draw = (t: string, x: number, f = font, size = 9) => page.drawText(t, { x, y, font: f, size, color: rgb(0, 0, 0) })
  const right = (t: string, xRight: number, f = font, size = 9) => draw(t, xRight - f.widthOfTextAtSize(t, size), f, size)

  draw(issuer.name.toUpperCase(), 40, bold, 10)
  if (issuer.ein) right(issuer.ein, 572, bold, 10)
  y -= 24
  const cols = [
    ['SSTB', 40], ['Qualified Business', 100], ['Section 1231 Gain', 175], ['Section 179', 250],
    ['QBI Wages', 310], ['Unadjusted Basis', 375], ['Qualified REIT', 455], ['Qualified PTP', 520],
  ] as const
  const qbiRow = [k1.qbi_income, k1.qbi_1231_gain, k1.qbi_179, k1.w2_wages, k1.ubia, k1.reit_dividends, k1.ptp_income]
  const show = (v: number | undefined, i: number) => {
    // The filed statement prints 0 for the trailing columns and leaves 1231/179 blank.
    if (v === undefined || v === null) return i >= 4 ? '0' : ''
    return Math.round(v).toLocaleString('en-US')
  }
  draw('Schedule K-1 (1120-S) - Qualified Business Income Deduction', 40, bold, 10); y -= 16
  for (const [label, x] of cols) draw(label, x, bold, 8)
  y -= 10
  draw('Income/(Loss)', 100, bold, 8); draw('(Loss)', 175, bold, 8)
  draw('Immediately After', 375, bold, 8); draw('Dividends', 455, bold, 8); draw('Income/(Loss)', 520, bold, 8)
  y -= 10
  draw('Acquisition', 375, bold, 8)
  y -= 14
  const colRight = [160, 235, 295, 360, 440, 505, 572]
  if (k1.sstb) draw('X', 40)
  qbiRow.forEach((v, i) => { const s = show(v, i); if (s) right(s, colRight[i]) })
  y -= 14
  draw('Total:', 40, bold)
  qbiRow.forEach((v, i) => { const s = show(v, i); if (s) right(s, colRight[i], bold) })
  y -= 30

  if (lineSeventeen.length) {
    draw('Schedule K-1 (1120-S) -Line 17 - Other information', 40, bold, 10); y -= 16
    draw('Description', 40, bold, 8); draw('Amount', 300, bold, 8); y -= 14
    for (const l of lineSeventeen) {
      draw(l.code, 40)
      // Printed as the filed statement prints it: whole dollars, no separators.
      if (typeof l.amount === 'number') draw(String(Math.round(l.amount)), 300)
      y -= 14
    }
  }
  return pdf
}

// ─── 1065 Schedule K-1 ───
// Field ids from the Textract-discovered map (data/field_maps/
// f1065sk1_2024_fields.json), spot-checked visually against a rendered
// fill before shipping. Only ids the discovery verified are used on-form.
const F1065SK1 = {
  partnership_ein:   'f1_6',
  partnership_block: 'f1_7',
  irs_center:        'f1_8',
  partner_tin:       'f1_9',
  partner_block:     'f1_10',
  entity_type:       'f1_13',
  profit_pct_end:    'f1_15',
  loss_pct_end:      'f1_17',
  capital_pct_end:   'f1_19',
  L1_ordinary:       'f1_34',
  L2_rental_re:      'f1_35',
  L3_other_rental:   'f1_36',
  L4a_guaranteed_services: 'f1_37',
  L4b_guaranteed_capital:  'f1_38',
  L4c_guaranteed_total:    'f1_39',
  L5_interest:       'f1_40',
  L6a_dividends:     'f1_41',
  L6b_qual_div:      'f1_42',
  L7_royalties:      'f1_44',
  L8_st_gain:        'f1_45',
  L9a_lt_gain:       'f1_46',
  L10_1231:          'f1_49',
  L12_179:           'f1_54',
} as const

export async function build1065K1(
  taxYear: number, issuer: K1Issuer, recipient: K1Recipient, alloc: K1Allocation1065,
): Promise<K1Pdf> {
  const pdf = await loadBlank('f1065sk1', taxYear)
  const form = pdf.getForm()
  let filled = 0
  const put = (id: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return
    if (setField(form, id, value)) filled++
  }

  put(F1065SK1.partnership_ein, issuer.ein)
  put(F1065SK1.partnership_block, issuerBlock(issuer))
  put(F1065SK1.irs_center, 'e-file')
  put(F1065SK1.partner_tin, recipient.tin)
  put(F1065SK1.partner_block, recipientBlock(recipient))
  put(F1065SK1.entity_type, alloc.entity_type || 'Individual')
  put(F1065SK1.profit_pct_end, `${alloc.profit_pct}%`)
  put(F1065SK1.loss_pct_end, `${alloc.loss_pct}%`)
  put(F1065SK1.capital_pct_end, `${alloc.capital_pct}%`)
  // General vs limited partner (Part II, box G)
  checkBox(form, alloc.is_general ? 'c1_4[0]' : 'c1_4[1]')
  // Domestic partner (H1)
  checkBox(form, 'c1_5[0]')

  put(F1065SK1.L1_ordinary, nz(alloc.ordinary_income))
  put(F1065SK1.L2_rental_re, nz(alloc.rental_real_estate))
  put(F1065SK1.L3_other_rental, nz(alloc.other_rental))
  put(F1065SK1.L4a_guaranteed_services, nz(alloc.guaranteed_payments_services))
  put(F1065SK1.L4b_guaranteed_capital, nz(alloc.guaranteed_payments_capital))
  put(F1065SK1.L4c_guaranteed_total, nz((alloc.guaranteed_payments_services || 0) + (alloc.guaranteed_payments_capital || 0)))
  put(F1065SK1.L5_interest, nz(alloc.interest_income))
  put(F1065SK1.L6a_dividends, nz(alloc.dividends_ordinary))
  put(F1065SK1.L6b_qual_div, nz(alloc.dividends_qualified))
  put(F1065SK1.L7_royalties, nz(alloc.royalties))
  put(F1065SK1.L8_st_gain, nz(alloc.st_cap_gain))
  put(F1065SK1.L9a_lt_gain, nz(alloc.lt_cap_gain))
  put(F1065SK1.L10_1231, nz(alloc.net_1231_gain))
  put(F1065SK1.L12_179, nz(alloc.section_179))

  const coded: StatementLine[] = []
  if (nz(alloc.charitable)) coded.push({ label: 'Box 13, code A — cash charitable contributions', amount: nz(alloc.charitable) })
  if (nz(alloc.se_earnings)) coded.push({ label: 'Box 14, code A — net earnings from self-employment', amount: nz(alloc.se_earnings) })
  if (nz(alloc.distributions)) coded.push({ label: 'Box 19, code A — cash distributions', amount: nz(alloc.distributions) })
  const qbi: StatementLine[] = []
  if (nz(alloc.qbi_income)) qbi.push({ label: 'QBI — ordinary business income', amount: nz(alloc.qbi_income) })
  if (nz(alloc.w2_wages)) qbi.push({ label: 'W-2 wages', amount: nz(alloc.w2_wages) })
  if (nz(alloc.ubia)) qbi.push({ label: 'UBIA of qualified property', amount: nz(alloc.ubia) })

  const sections: Array<{ heading: string; lines: StatementLine[] }> = []
  if (coded.length) sections.push({ heading: 'Coded box detail', lines: coded })
  if (qbi.length) sections.push({ heading: 'Box 20, code Z — Statement A (Section 199A information)', lines: qbi })
  if (sections.length) {
    await appendStatement(pdf, await statementPage(
      `Schedule K-1 (Form 1065) ${taxYear} — Supplemental Statement`,
      `${issuer.name} — Partner: ${recipient.name} (${alloc.profit_pct}% profit)`,
      sections,
    ))
  }
  return { recipient: recipient.name, pct: alloc.profit_pct, pdf, filled }
}
