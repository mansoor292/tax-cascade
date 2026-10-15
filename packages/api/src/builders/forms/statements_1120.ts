/**
 * Supporting statements for a Form 1120 package.
 *
 * The generic generateStatements() printed three lists (line 26, 1125-A line
 * 5, line 10). A filed 1120 attaches a statement for every "attach statement"
 * line it uses — Schedule L lines 6, 9, 14, 18, 21, the line 26 meals split
 * (total vs deductible, which is what M-1 line 5c reconciles), the M-2
 * itemizations — and Schedule L detail was stored on the return
 * (`schedL_*_detail`) but never printed. This builder owns all 1120
 * statements; generateStatements() now serves the 1120-S only.
 *
 * Itemizations (input_data):
 *   other_deductions_detail        [{label, amount, kind?: 'meals', total?}]   line 26
 *   other_income_detail            [{label, amount}]                           line 10
 *   other_costs_detail             [{label, amount}]                           1125-A line 5 (own page, after 1125-A)
 *   schedL_other_current_assets_detail      [{label, boy, eoy}]                Sch L line 6
 *   schedL_other_investments_detail         [{label, boy, eoy}]                Sch L line 9
 *   schedL_other_assets_detail              [{label, boy, eoy}]                Sch L line 14
 *   schedL_other_current_liabilities_detail [{label, boy, eoy}]                Sch L line 18
 *   schedL_other_liabilities_detail         [{label, boy, eoy}]                Sch L line 21
 *   schedM2_other_increases_detail / schedM2_other_decreases_detail [{label, amount}]  M-2 lines 3 / 6
 * A row may leave its amount out (null) — a category the books carry with
 * nothing in it this year prints as a description with no amount, as filed.
 * Totals are added with cents and rounded once.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { AttachmentBuilder, Attachment } from './types.js'
import { money } from './acroform.js'

type Row = { label: string; cols: Array<number | null> }
interface Section { title: string; head: string[]; rows: Row[] }

const amt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const lbl = (o: any) => String(o?.label ?? o?.description ?? o?.name ?? '')

function balanceSection(title: string, raw: unknown): Section | null {
  const items = arr(raw)
  if (!items.length) return null
  return {
    title, head: ['Description', 'Beginning Amount', 'Ending Amount'],
    rows: items.map(o => ({ label: lbl(o), cols: [amt(o.boy), amt(o.eoy)] })),
  }
}
function listSection(title: string, items: any[]): Section | null {
  if (!items.length) return null
  return { title, head: ['Description', 'Amount'], rows: items.map(o => ({ label: lbl(o), cols: [amt(o.amount ?? o.value)] })) }
}

export function sections1120(inputData: Record<string, any>): { main: Section[]; cogs: Section[] } {
  const ded = arr(inputData.other_deductions_detail)
  const meals = ded.filter(o => o?.kind === 'meals')
  const other = ded.filter(o => o?.kind !== 'meals')
  const main = [
    balanceSection('Schedule L - Line 14 - Other assets', inputData.schedL_other_assets_detail),
    balanceSection('Schedule L - Line 18 - Other current liabilities', inputData.schedL_other_current_liabilities_detail),
    meals.length ? {
      title: 'Line 26 - Other deductions - Meals and entertainment',
      head: ['Meals and entertainment', 'Total amount', 'Deductible amount'],
      rows: meals.map(o => ({ label: lbl(o), cols: [amt(o.total), amt(o.amount)] })),
    } : null,
    listSection(meals.length ? 'Line 26 - Other deductions - Other than meals and entertainment' : 'Line 26 - Other deductions', other),
    balanceSection('Schedule L - Line 6 - Other current assets', inputData.schedL_other_current_assets_detail),
    balanceSection('Schedule L - Line 9 - Other investments', inputData.schedL_other_investments_detail),
    balanceSection('Schedule L - Line 21 - Other liabilities', inputData.schedL_other_liabilities_detail),
    listSection('Schedule M-2 - Line 3', arr(inputData.schedM2_other_increases_detail)),
    listSection('Schedule M-2 - Line 6', arr(inputData.schedM2_other_decreases_detail)),
    listSection('Line 10 - Other income', arr(inputData.other_income_detail)),
  ].filter((s): s is Section => !!s)
  const cogs = [listSection('Form 1125-A - Line 5 - Other costs', arr(inputData.other_costs_detail))]
    .filter((s): s is Section => !!s)
  return { main, cogs }
}

async function render(name: string, ein: string, sections: Section[]): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const X_LABEL = 50, X_RIGHT = [400, 560]  // right edges of the amount columns
  let page: PDFPage = pdf.addPage([612, 792])
  let y = 0
  const text = (s: string, x: number, f: PDFFont = font, size = 9) =>
    page.drawText(s, { x, y, size, font: f, color: rgb(0, 0, 0) })
  const right = (s: string, xr: number, f: PDFFont = font) => text(s, xr - f.widthOfTextAtSize(s, 9), f)
  const newPage = (first: boolean) => {
    if (!first) page = pdf.addPage([612, 792])
    y = 760
    text(name.toUpperCase(), X_LABEL, bold, 10)
    right(ein || '', 560, bold)
    y -= 22
  }
  newPage(true)
  for (const s of sections) {
    if (y < 100) newPage(false)
    text(`Statement - Form 1120 - ${s.title}`, X_LABEL, bold, 10); y -= 13
    const cols = s.head.length - 1
    const xr = cols === 1 ? [560] : X_RIGHT
    text(s.head[0], X_LABEL, bold)
    s.head.slice(1).forEach((h, i) => right(h, xr[i], bold))
    y -= 11
    const totals = Array(cols).fill(0)
    for (const r of s.rows) {
      if (y < 50) { newPage(false); text(`${s.title} (continued)`, X_LABEL, bold); y -= 14 }
      text(r.label.slice(0, 70), X_LABEL)
      r.cols.forEach((v, i) => { if (v !== null) { right(money(v), xr[i]); totals[i] += v } })
      y -= 10.5
    }
    text('Total:', X_LABEL, bold)
    totals.forEach((t, i) => {
      // a column with no amounts at all (beginning balances of a new line) stays blank
      if (s.rows.some(r => r.cols[i] !== null)) right(money(t), xr[i], bold)
    })
    y -= 16
  }
  return pdf
}

export const buildStatements1120: AttachmentBuilder = async (ctx) => {
  if (ctx.formType !== '1120') return null
  const { main, cogs } = sections1120(ctx.inputData || {})
  const out: Attachment[] = []
  const ein = String(ctx.entity.ein || '')
  if (main.length) out.push({ seq: 1, label: 'Statements', pdf: await render(ctx.entity.name, ein, main) })
  if (cogs.length) out.push({ seq: 9, label: 'Statement (Form 1125-A)', pdf: await render(ctx.entity.name, ein, cogs) })
  return out
}
