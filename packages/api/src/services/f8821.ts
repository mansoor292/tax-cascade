/**
 * Form 8821 (Tax Information Authorization), filled for a practice client.
 *
 * Catipult creates the 8821 (Mansoor, 2026-10-24): taxpayer, the practice's
 * designee (its own CAF, or the platform's for practitioners without one),
 * the forms and periods to read. Two shapes:
 *   - the DRAFT (fill8821): a fillable form, generated on request and never
 *     stored, line 6 left blank. While onboarding is pending it carries the
 *     full TIN (decrypted for this response only).
 *   - the SIGNED copy (signed8821, 2026-10-25): what goes to TaxNow's staff,
 *     who submit it to the IRS. The signer is verified first (Didit), then
 *     draws a signature; their name prints as read off the verified ID, the
 *     drawing sits on the signature line, the form is flattened so nothing
 *     can be retyped, and a last page records who signed, how they were
 *     verified, and when. It is made once, at signing, and kept (encrypted)
 *     as the record of exactly what was sent (services/practice.ts).
 *
 * Line 6 of the blank has fields only for Print Name (f1_32) and Title
 * (f1_33); Signature and Date are bare lines above them, so the drawing and
 * the date are placed by position (SIG_BOX, DATE_AT, measured on Rev. 01-2021).
 *
 * Field names are the blank's widgets (data/irs_forms/f8821.pdf, Rev. as
 * downloaded from irs.gov/pub/irs-pdf/f8821.pdf); each one's meaning is the
 * IRS's own <speak> text in the blank's XFA template, quoted beside it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName, PDFDict, StandardFonts, degrees, rgb } from 'pdf-lib'

const BLANK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'irs_forms', 'f8821.pdf')
const P = 'topmostSubform[0].Page1[0].'

const F = {
  taxpayer: `${P}f1_6[0]`,      // 1. Taxpayer name and address
  tin: `${P}f1_7[0]`,           // 1. Taxpayer identification number(s)
  phone: `${P}f1_8[0]`,         // 1. Daytime telephone number
  designee: `${P}f1_10[0]`,     // 2. Name and address
  caf: `${P}f1_11[0]`,          // CAF No.
  ptin: `${P}f1_12[0]`,         // PTIN
  dPhone: `${P}f1_13[0]`,       // Telephone No.
  dFax: `${P}f1_14[0]`,         // Fax No.
  // The second designee: the same block, one row down (widgets f1_15–f1_19
  // sit 60pt below f1_10–f1_14 on Rev. 01-2021).
  designee2: `${P}f1_15[0]`,    // 2. Name and address (second designee)
  caf2: `${P}f1_16[0]`,         // CAF No.
  ptin2: `${P}f1_17[0]`,        // PTIN
  dPhone2: `${P}f1_18[0]`,      // Telephone No.
  dFax2: `${P}f1_19[0]`,        // Fax No.
  // 3. "By checking here, I authorize access to my IRS records via an
  // Intermediate Service Provider." TaxNow reads under its designees' CAF as
  // an ISP, and its own 8821s tick this (seen on BCL's, 2026-10-27).
  isp: `${P}c1_10[0]`,
  rows: [                       // 3. (a) type, (b) form, (c) years or periods, (d) specific matters
    [`${P}Table_Line3[0].BodyRow1[0].f1_20[0]`, `${P}Table_Line3[0].BodyRow1[0].f1_21[0]`, `${P}Table_Line3[0].BodyRow1[0].f1_22[0]`, `${P}Table_Line3[0].BodyRow1[0].f1_23[0]`],
    [`${P}Table_Line3[0].BodyRow2[0].f1_24[0]`, `${P}Table_Line3[0].BodyRow2[0].f1_25[0]`, `${P}Table_Line3[0].BodyRow2[0].f1_26[0]`, `${P}Table_Line3[0].BodyRow2[0].f1_27[0]`],
    [`${P}Table_Line3[0].BodyRow3[0].f1_28[0]`, `${P}Table_Line3[0].BodyRow3[0].f1_29[0]`, `${P}Table_Line3[0].BodyRow3[0].f1_30[0]`, `${P}Table_Line3[0].BodyRow3[0].f1_31[0]`],
  ],
  printName: `${P}f1_32[0]`,    // 6. Print Name
  title: `${P}f1_33[0]`,        // 6. Title (if applicable)
}

// Line 6, page 1, in PDF points from the bottom left: the Signature line runs
// x 58–430 at y 131, the Date column starts at x 436 on the same line. The
// box dips a little below the line, as a hand signature does.
const SIG_BOX = { x: 60, y: 124, width: 360, height: 34 }
const DATE_AT = { x: 442, y: 135 }

export interface Designee { name?: string; address?: string; city?: string; state?: string; zip?: string; caf?: string; ptin?: string; phone?: string; fax?: string }

export interface F8821Input {
  taxpayer: { name: string; address?: string; phone?: string }
  tin: string                     // full TIN while pending, else masked (XX-XXX1234)
  designee: Designee & {
    /** A second designee, printed in line 2's second block (TaxNow's 8821s name two). */
    second?: Designee
    /** Tick line 3's Intermediate Service Provider box. */
    isp?: boolean
  }
  scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number; year_end_month?: number }
  /** A test client's form: stamped across page 1 so it can never be filed. */
  test?: boolean
}

/** What a signed copy adds to the draft. */
export interface SignedInput {
  /** The name read off the signer's verified ID: it prints as line 6's Print Name. */
  name: string
  title?: string
  /** ISO time of signing; its date prints on the Date line. */
  signedAt: string
  /** The signature as drawn, a PNG. */
  png: Uint8Array
  /** The record printed on the last page, one "label: value" per line. */
  audit: Array<[string, string]>
}

const FORM_LABEL: Record<string, string> = { '1120S': '1120-S', '1120': '1120', '1065': '1065', '1040': '1040' }
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function formatTin(tin: string): string {
  const d = tin.replace(/\D/g, '')
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`
  return tin
}

/** Line 3 rows: what the designee may read. Fiscal years say their year end. */
export function line3Rows(scope: F8821Input['scope']): Array<[string, string, string, string]> {
  const from = scope.from_year, to = scope.to_year
  const yem = scope.year_end_month ?? 12
  const years = from && to ? (yem === 12 ? `${from} through ${to}` : `Tax years ending ${MONTH[yem - 1]} ${from} through ${MONTH[yem - 1]} ${to}`) : ''
  const rows: Array<[string, string, string, string]> = []
  if (scope.income?.length) rows.push(['Income', scope.income.map(f => FORM_LABEL[f] ?? f).join(', '), years, ''])
  if (scope.payroll?.length) rows.push(['Employment', scope.payroll.join(', '), from && to ? `${from} through ${to}` : '', ''])
  return rows.slice(0, 3)
}

/** The draft: every field filled but line 6, still fillable. */
export async function fill8821(input: F8821Input): Promise<Uint8Array> {
  return (await filled(input)).save()
}

async function filled(input: F8821Input): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(readFileSync(BLANK), { ignoreEncryption: true })
  // The blank is an XFA form; drop the XFA so viewers show the AcroForm values set here.
  const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  acro?.delete(PDFName.of('XFA'))
  const form = pdf.getForm()
  const set = (name: string, v: string | undefined) => { if (v) form.getTextField(name).setText(v) }
  const d = input.designee
  set(F.taxpayer, [input.taxpayer.name, input.taxpayer.address].filter(Boolean).join('\n'))
  set(F.tin, formatTin(input.tin))
  set(F.phone, input.taxpayer.phone)
  set(F.designee, [d.name, d.address, [d.city, d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n'))
  set(F.caf, d.caf)
  set(F.ptin, d.ptin)
  set(F.dPhone, d.phone)
  set(F.dFax, d.fax)
  const d2 = d.second
  if (d2?.name) {
    set(F.designee2, [d2.name, d2.address, [d2.city, d2.state, d2.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n'))
    set(F.caf2, d2.caf)
    set(F.ptin2, d2.ptin)
    set(F.dPhone2, d2.phone)
    set(F.dFax2, d2.fax)
  }
  if (d.isp) form.getCheckBox(F.isp).check()
  line3Rows(input.scope).forEach((row, i) => row.forEach((v, j) => set(F.rows[i][j], v)))
  form.updateFieldAppearances()
  if (input.test) {
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    // Centred across the page at 35°, sized to fit inside its margins.
    const page = pdf.getPage(0), a = (35 * Math.PI) / 180
    const size = Math.min(44, (page.getWidth() - 100) / (bold.widthOfTextAtSize(TEST_STAMP, 1) * Math.cos(a)))
    const w = bold.widthOfTextAtSize(TEST_STAMP, size)
    page.drawText(TEST_STAMP, {
      x: page.getWidth() / 2 - (w / 2) * Math.cos(a), y: page.getHeight() / 2 - (w / 2) * Math.sin(a) - 60,
      size, font: bold, color: rgb(0.85, 0.1, 0.1), opacity: 0.35, rotate: degrees(35),
    })
  }
  return pdf
}

/** Printed across a test client's 8821 (practice_client.test). */
export const TEST_STAMP = 'TEST — NOT FOR FILING'

/** The signed copy: the draft with line 6 completed, flattened, plus the
 *  signing record as a last page. */
export async function signed8821(input: F8821Input, s: SignedInput): Promise<Uint8Array> {
  const pdf = await filled(input)
  const form = pdf.getForm()
  form.getTextField(F.printName).setText(s.name)
  if (s.title) form.getTextField(F.title).setText(s.title)
  form.updateFieldAppearances()
  form.flatten()

  const page = pdf.getPage(0)
  const img = await pdf.embedPng(s.png)
  // Fit the drawing in the box, keeping its shape, resting on the line.
  const k = Math.min(SIG_BOX.width / img.width, SIG_BOX.height / img.height)
  page.drawImage(img, { x: SIG_BOX.x, y: SIG_BOX.y, width: img.width * k, height: img.height * k })
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText(usDate(s.signedAt), { x: DATE_AT.x, y: DATE_AT.y, size: 10, font })

  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const audit = pdf.addPage([612, 792])
  let y = 740
  audit.drawText('Form 8821 — electronic signature record', { x: 50, y, size: 14, font: bold })
  y -= 22
  for (const line of wrap('The taxpayer signed page 1 of this form electronically, after their identity was verified as recorded below. This page is part of the signed form.', 90)) {
    audit.drawText(line, { x: 50, y, size: 10, font, color: rgb(0.25, 0.25, 0.25) }); y -= 14
  }
  y -= 10
  for (const [label, value] of s.audit) {
    const lines = wrap(value, 62)
    audit.drawText(label, { x: 50, y, size: 10, font: bold })
    for (const line of lines) { audit.drawText(line, { x: 210, y, size: 10, font }); y -= 14 }
    y -= 4
  }
  return pdf.save()
}

export function usDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${m}/${d}/${y}`
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > width) { out.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}
