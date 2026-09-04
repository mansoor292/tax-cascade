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
 * Coded boxes (1120-S box 10/12/16/17; 1065 box 13/14/19/20) are NOT
 * guessed onto the form's code/amount pair fields — the discovered maps
 * don't cover them reliably, and a wrong box on a filing document is
 * worse than an attachment. They go on a generated statement page, the
 * same practice as the return builder's other-deduction statements. The
 * §199A Statement A (QBI, W-2 wages, UBIA) is always attached when any
 * of its amounts are nonzero.
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
}

export async function build1120SK1(
  taxYear: number, issuer: K1Issuer, recipient: K1Recipient, k1: K1Data1120S,
): Promise<K1Pdf> {
  const pdf = await loadBlank('f1120sk1', taxYear)
  const form = pdf.getForm()
  const m = F1120SK1_2025
  let filled = 0
  const put = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return
    if (setField(form, m[key], value)) filled++
  }

  put('meta.corp_ein', issuer.ein)
  put('meta.corp_name_addr', issuerBlock(issuer))
  put('meta.irs_center', 'e-file')
  put('meta.shareholder_id', recipient.tin)
  put('meta.shareholder_name', recipientBlock(recipient))
  put('meta.alloc_pct', `${k1.pct}%`)
  put('L1_ordinary', nz(k1.ordinary_income))
  put('L4_interest', nz(k1.interest_income))
  put('L5a_dividends', nz(k1.dividends_ordinary))
  put('L5b_qual_div', nz(k1.dividends_qualified))
  put('L6_royalties', nz(k1.royalties))
  put('L7_st_gain', nz(k1.st_cap_gain))
  put('L8a_lt_gain', nz(k1.lt_cap_gain))
  put('L11_179', nz(k1.section_179))

  const coded: StatementLine[] = []
  if (nz(k1.other_portfolio)) coded.push({ label: 'Box 10, other income (loss)', amount: nz(k1.other_portfolio) })
  if (nz(k1.charitable)) coded.push({ label: 'Box 12, code A — cash charitable contributions', amount: nz(k1.charitable) })
  if (nz(k1.tax_exempt_interest)) coded.push({ label: 'Box 16, code A — tax-exempt interest income', amount: nz(k1.tax_exempt_interest) })
  const qbi: StatementLine[] = []
  if (nz(k1.qbi_income)) qbi.push({ label: 'QBI — ordinary business income', amount: nz(k1.qbi_income) })
  if (nz(k1.w2_wages)) qbi.push({ label: 'W-2 wages', amount: nz(k1.w2_wages) })
  if (nz(k1.ubia)) qbi.push({ label: 'UBIA of qualified property', amount: nz(k1.ubia) })

  const sections: Array<{ heading: string; lines: StatementLine[] }> = []
  if (coded.length) sections.push({ heading: 'Coded box detail', lines: coded })
  if (qbi.length) sections.push({ heading: 'Box 17, code V — Statement A (Section 199A information)', lines: qbi })
  if (sections.length) {
    await appendStatement(pdf, await statementPage(
      `Schedule K-1 (Form 1120-S) ${taxYear} — Supplemental Statement`,
      `${issuer.name} — Shareholder: ${recipient.name} (${k1.pct}%)`,
      sections,
    ))
  }
  return { recipient: recipient.name, pct: k1.pct, pdf, filled }
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
