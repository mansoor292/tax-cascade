/**
 * Form 1120-S supporting statements the package builder never printed.
 *
 * Why this exists (2026-10-15 parity sprint): the filed 2025 EZ-Advisors
 * return attached a statement for every "attach statement" line it used —
 * Schedule L lines 6, 9, 18 and 21, Schedule M-2 line 3, the meals split of
 * line 20, Schedule K line 17d and the item H(4) amended-return explanation.
 * All of that detail was already stored on the return (the Schedule L
 * itemizations were added precisely so the balance sheet could be
 * explained) and none of it reached the PDF, so our package had bare
 * Schedule L totals the IRS instructions say must be itemized.
 *
 * Layout follows the filed return's: entity name and EIN at the top of each
 * page, then one titled block per statement with a Total row. The other-
 * income and line 20 itemizations stay with generateStatements in
 * build_return_pdf.ts; this module adds only what nothing else prints.
 *
 * Sources (all in input_data; a block prints only when its source has rows):
 *   schedL_other_current_assets_detail       [{label, boy, eoy}]   Sch L line 6
 *   schedL_other_investments_detail          [{label, boy, eoy}]   Sch L line 9
 *   schedL_other_current_liabilities_detail  [{label, boy, eoy}]   Sch L line 18
 *   schedL_other_liabilities_detail          [{label, boy, eoy}]   Sch L line 21
 *   schedM2_other_additions_detail           [{label, amount}]     M-2 line 3, column (a)
 *   meals_entertainment_detail               [{label, amount, deductible}]  line 20 meals
 *   schedK_other_items_detail                [{label|code, amount}]  Sch K line 17d
 *   amended_return_changes_detail            [{description, line, explanation, previous, amended}]
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Attachment, AttachmentContext } from './types.js'

const money = (v: number) => (Object.is(Math.round(v), -0) ? 0 : Math.round(v)).toLocaleString('en-US')
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[$,\s]/g, '')) : NaN
  return isFinite(n) ? n : undefined
}
const rowsOf = (v: unknown): Array<Record<string, any>> => (Array.isArray(v) ? v.filter(r => r && typeof r === 'object') : [])

interface Column { header: string; x: number; align: 'left' | 'right'; width?: number }
interface Block { title: string; columns: Column[]; rows: string[][]; total?: string[] }

/** Wrap text to a width; returns at least one line. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(next, size) > width && cur) { lines.push(cur); cur = w }
    else cur = next
  }
  if (cur || !lines.length) lines.push(cur)
  return lines
}

export function statementBlocks1120S(inputData: Record<string, any>): Block[] {
  const blocks: Block[] = []
  const boyEoy = (title: string, key: string) => {
    const rows = rowsOf(inputData[key])
    if (!rows.length) return
    const cols: Column[] = [
      { header: '(a) Description', x: 40, align: 'left', width: 230 },
      { header: '(b) Beginning of the year', x: 420, align: 'right' },
      { header: '(c) End of the year', x: 572, align: 'right' },
    ]
    let tb = 0; let te = 0
    const body = rows.map(r => {
      const b = num(r.boy) ?? 0; const e = num(r.eoy) ?? 0
      tb += b; te += e
      return [String(r.label ?? r.description ?? ''), money(b), money(e)]
    })
    blocks.push({ title, columns: cols, rows: body, total: ['Total:', money(tb), money(te)] })
  }

  boyEoy('Statement - 1120S - Schedule L - Line 9 - Other investments', 'schedL_other_investments_detail')
  boyEoy('Statement - 1120S - Schedule L - Line 21 - Other liabilities', 'schedL_other_liabilities_detail')

  const m2 = rowsOf(inputData.schedM2_other_additions_detail)
  if (m2.length) {
    let t = 0
    const body = m2.map(r => { const a = num(r.amount ?? r.value) ?? 0; t += a; return [String(r.label ?? ''), money(a), ''] })
    blocks.push({
      title: 'Statement - 1120S - Schedule M2 - Line 3 - Other additions',
      columns: [
        { header: 'Type', x: 40, align: 'left', width: 230 },
        { header: '(a) Accumulated adjustments account', x: 420, align: 'right' },
        { header: '(b) Other adjustments account', x: 572, align: 'right' },
      ],
      rows: body, total: ['Total:', money(t), ''],
    })
  }

  boyEoy('Statement - 1120S - Schedule L - Line 6 - Other current assets', 'schedL_other_current_assets_detail')
  boyEoy('Statement - 1120S - Schedule L - Line 18 - Other current liabilities', 'schedL_other_current_liabilities_detail')

  const meals = rowsOf(inputData.meals_entertainment_detail)
  if (meals.length) {
    let tg = 0; let td = 0
    const body = meals.map(r => {
      const g = num(r.amount ?? r.gross) ?? 0
      const d = num(r.deductible) ?? Math.round(g / 2)
      tg += g; td += d
      return [String(r.label ?? 'Meals'), money(g), money(d)]
    })
    // Tie the split back to line 20: the itemized statement carries the
    // deductible meals as one row, so the two statements reconcile here.
    const other = rowsOf(inputData.other_deductions_detail)
    const line20 = other.reduce((t, r) => t + (num(r.amount ?? r.value) ?? 0), 0)
    const rows = [...body]
    const total = ['Total:', money(tg), money(td)]
    blocks.push({
      title: 'Statement - 1120S - Deductions - Line 20 - Other deductions - Meals and Entertainment',
      columns: [
        { header: 'Meals and entertainment', x: 40, align: 'left', width: 230 },
        { header: 'Deductible Amount', x: 420, align: 'right' },
        { header: 'Total Deductible Amount', x: 572, align: 'right' },
      ],
      rows, total,
    })
    if (line20) {
      blocks.push({
        title: 'Line 20 - Other deductions other than meals and entertainment (itemized on the Line 20 statement)',
        columns: [{ header: 'Description', x: 40, align: 'left', width: 300 }, { header: 'Amount', x: 572, align: 'right' }],
        rows: [['Other deductions other than meals and entertainment', money(line20 - td)]],
        total: ['Line 20 total:', money(line20)],
      })
    }
  }

  const amended = rowsOf(inputData.amended_return_changes_detail)
  if (amended.length) {
    let tp = 0; let ta = 0
    const body = amended.map(r => {
      const p = num(r.previous) ?? 0; const a = num(r.amended) ?? 0
      tp += p; ta += a
      return [String(r.description ?? ''), String(r.line ?? ''), String(r.explanation ?? ''), money(p), money(a)]
    })
    blocks.push({
      title: 'Statement - 1120S - Info Line H(4) - Amended return changes',
      columns: [
        { header: 'Description', x: 40, align: 'left', width: 130 },
        { header: 'Line Number', x: 175, align: 'left', width: 40 },
        { header: 'Explanation', x: 230, align: 'left', width: 170 },
        { header: 'Amount On Previous Return', x: 495, align: 'right', width: 80 },
        { header: 'Amount On Amended Return', x: 572, align: 'right', width: 70 },
      ],
      rows: body, total: ['Total:', '', '', money(tp), money(ta)],
    })
  }

  const k17d = rowsOf(inputData.schedK_other_items_detail)
  if (k17d.length) {
    let t = 0
    const body = k17d.map(r => { const a = num(r.amount) ?? 0; t += a; return [String(r.label ?? r.code ?? ''), money(a)] })
    blocks.push({
      title: 'Statement - 1120S - Schedule K - Line 17D - Other items and amounts',
      columns: [{ header: 'Description', x: 40, align: 'left', width: 300 }, { header: 'Amount', x: 572, align: 'right' }],
      rows: body, total: ['Total:', money(t)],
    })
  }
  return blocks
}

export async function renderStatementBlocks(
  entityName: string, ein: string | undefined, blocks: Block[],
): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const size = 8
  let page: PDFPage = pdf.addPage([612, 792])
  let y = 0
  const header = () => {
    y = 760
    page.drawText(entityName.toUpperCase(), { x: 40, y, font: bold, size: 9, color: rgb(0, 0, 0) })
    if (ein) page.drawText(ein, { x: 572 - bold.widthOfTextAtSize(ein, 9), y, font: bold, size: 9, color: rgb(0, 0, 0) })
    y -= 22
  }
  const ensure = (need: number) => {
    if (y - need < 50) { page = pdf.addPage([612, 792]); header() }
  }
  const cell = (text: string, c: Column, f: PDFFont) => {
    if (!text) return
    const x = c.align === 'right' ? c.x - f.widthOfTextAtSize(text, size) : c.x
    page.drawText(text, { x, y, font: f, size, color: rgb(0, 0, 0) })
  }
  header()
  for (const b of blocks) {
    ensure(48)
    page.drawText(b.title, { x: 40, y, font: bold, size: 9, color: rgb(0, 0, 0) }); y -= 13
    // Headers wrap inside their column so long ones never run into the next.
    const heads = b.columns.map(c => (c.width ? wrap(c.header, bold, size, c.width) : [c.header]))
    const headTop = y
    heads.forEach((lines, i) => lines.forEach((t, j) => { y = headTop - j * 10; cell(t, b.columns[i], bold) }))
    y = headTop - Math.max(...heads.map(h => h.length)) * 10 - 2
    for (const row of [...b.rows, ...(b.total ? [b.total] : [])]) {
      const isTotal = row === b.total
      // Left-aligned columns wrap; the row is as tall as its tallest cell.
      const wrapped = row.map((t, i) => {
        const c = b.columns[i]
        return c && c.align === 'left' && c.width ? wrap(t, isTotal ? bold : font, size, c.width) : [t]
      })
      const height = Math.max(...wrapped.map(w => w.length))
      ensure(height * 10 + 4)
      const top = y
      wrapped.forEach((lines, i) => {
        const c = b.columns[i]
        if (!c) return
        lines.forEach((t, j) => { y = top - j * 10; cell(t, c, isTotal ? bold : font) })
      })
      y = top - height * 10 - 2
    }
    y -= 12
  }
  return pdf
}

export async function buildStatements1120S(ctx: AttachmentContext): Promise<Attachment | null> {
  const blocks = statementBlocks1120S(ctx.inputData || {})
  if (!blocks.length) return null
  const pdf = await renderStatementBlocks(ctx.entity.name, ctx.entity.ein, blocks)
  return { seq: 5, label: 'Statements (Form 1120-S)', pdf }
}
