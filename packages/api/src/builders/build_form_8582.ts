/**
 * Form 8582 Builder — Passive Activity Loss Limitations
 *
 * Fills Parts I, II, III (lines 1a-11) from calcForm8582 result. Worksheet
 * tables on pages 1-3 (Part 4/5/6/7) are not auto-filled — those require
 * per-activity detail that the scaffold doesn't track yet.
 */

import { PDFDocument } from 'pdf-lib'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { fillFromMap } from './pdf_filler.js'
import type { Form8582_Inputs, Form8582_Result } from '../engine/tax_engine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORMS_DIR = join(__dirname, '../../data/irs_forms')

async function ensureBlankPdf(path: string, url: string): Promise<void> {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed ${url}: ${res.status}`)
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
}

// Field IDs are laid out sequentially on page 1, top to bottom:
// header (name, id), Part I (1a-2d, 3), Part II (4-9), Part III (10-11).
const FIELD_MAP_8582: Record<string, string> = {
  taxpayer_name:  'f1_01',
  taxpayer_id:    'f1_02',
  L1a:            'f1_03',  // rental RE current-year income
  L1b:            'f1_04',  // rental RE current-year loss (negative)
  L1c:            'f1_05',  // prior-year unallowed rental RE loss (negative)
  L1d:            'f1_06',  // combine 1a/1b/1c
  L2a:            'f1_07',  // other passive income
  L2b:            'f1_08',  // other passive loss (negative)
  L2c:            'f1_09',  // prior-year unallowed other (negative)
  L2d:            'f1_10',  // combine 2a/2b/2c
  L3:             'f1_11',  // combine 1d + 2d
  L4:             'f1_12',  // smaller of loss on 1d or 3
  L5:             'f1_13',  // 150,000 (or 75,000 MFS)
  L6:             'f1_14',  // MAGI
  L7:             'f1_15',  // L5 - L6
  L8:             'f1_16',  // L7 * 50%, max 25K/12.5K
  L9:             'f1_17',  // smaller of L4 or L8
  L10:            'f1_18',  // income on 1a + 2a
  L11:            'f1_19',  // L9 + L10 — total losses allowed
}

export async function buildForm8582Pdf(
  inputs: Form8582_Inputs & { taxpayer_name?: string; taxpayer_id?: string },
  result: Form8582_Result,
  year: number = 2025,
): Promise<{ pdf: PDFDocument; filled: number; missed: string[] }> {
  const pdfPath = join(FORMS_DIR, `f8582_${year}.pdf`)
  // Download from IRS on first use — the repo doesn't ship PDF templates.
  await ensureBlankPdf(pdfPath, `https://www.irs.gov/pub/irs-pdf/f8582.pdf`)

  const pdf = await PDFDocument.load(readFileSync(pdfPath))
  const form = pdf.getForm()

  const c = result.computed
  const data: Record<string, string | number> = {
    taxpayer_name: inputs.taxpayer_name || '',
    taxpayer_id:   inputs.taxpayer_id || '',
    L1a: c.L1a, L1b: c.L1b, L1c: c.L1c, L1d: c.L1d,
    L2a: c.L2a, L2b: c.L2b, L2c: c.L2c, L2d: c.L2d,
    L3:  c.L3,  L4:  c.L4,  L5:  c.L5,  L6:  c.L6,
    L7:  c.L7,  L8:  c.L8,  L9:  c.L9,  L10: c.L10, L11: c.L11,
  }

  const { filled, missed } = fillFromMap(form, FIELD_MAP_8582, data)
  return { pdf, filled, missed }
}
