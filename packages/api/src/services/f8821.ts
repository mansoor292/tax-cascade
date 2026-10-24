/**
 * Form 8821 (Tax Information Authorization), filled for a practice client.
 *
 * Catipult creates the 8821 (Mansoor, 2026-10-24): taxpayer, the practice's
 * designee (its own CAF, or the platform's for practitioners without one),
 * the forms and periods to read, and — once signed — the signer's name and
 * title. Generated on request and streamed, never stored: while onboarding is
 * pending it carries the full TIN (decrypted for this response only); after
 * the client is readable the TIN has been wiped and only the last four print.
 *
 * Field names are the blank's widgets (data/irs_forms/f8821.pdf, Rev. as
 * downloaded from irs.gov/pub/irs-pdf/f8821.pdf); each one's meaning is the
 * IRS's own <speak> text in the blank's XFA template, quoted beside it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib'

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
  rows: [                       // 3. (a) type, (b) form, (c) years or periods, (d) specific matters
    [`${P}Table_Line3[0].BodyRow1[0].f1_20[0]`, `${P}Table_Line3[0].BodyRow1[0].f1_21[0]`, `${P}Table_Line3[0].BodyRow1[0].f1_22[0]`, `${P}Table_Line3[0].BodyRow1[0].f1_23[0]`],
    [`${P}Table_Line3[0].BodyRow2[0].f1_24[0]`, `${P}Table_Line3[0].BodyRow2[0].f1_25[0]`, `${P}Table_Line3[0].BodyRow2[0].f1_26[0]`, `${P}Table_Line3[0].BodyRow2[0].f1_27[0]`],
    [`${P}Table_Line3[0].BodyRow3[0].f1_28[0]`, `${P}Table_Line3[0].BodyRow3[0].f1_29[0]`, `${P}Table_Line3[0].BodyRow3[0].f1_30[0]`, `${P}Table_Line3[0].BodyRow3[0].f1_31[0]`],
  ],
  signature: `${P}f1_32[0]`,    // 6. Taxpayer signature
  title: `${P}f1_33[0]`,        // 6. Title (if applicable)
}

export interface F8821Input {
  taxpayer: { name: string; address?: string; phone?: string }
  tin: string                     // full TIN while pending, else masked (XX-XXX1234)
  designee: { name?: string; address?: string; city?: string; state?: string; zip?: string; caf?: string; ptin?: string; phone?: string; fax?: string }
  scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number; year_end_month?: number }
  signer?: { name: string; title?: string; signedAt?: string; electronic?: boolean } | null
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

export async function fill8821(input: F8821Input): Promise<Uint8Array> {
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
  line3Rows(input.scope).forEach((row, i) => row.forEach((v, j) => set(F.rows[i][j], v)))
  if (input.signer) {
    const when = input.signer.signedAt ? ` ${input.signer.signedAt.slice(0, 10)}` : ''
    set(F.signature, input.signer.electronic ? `/s/ ${input.signer.name}${when}` : input.signer.name)
    set(F.title, input.signer.title)
  }
  form.updateFieldAppearances()
  return pdf.save()
}
