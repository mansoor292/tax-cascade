/**
 * PDF layout reader for the catalog: text runs and small drawn marks, per page,
 * in points with a TOP-LEFT origin (y grows downward), after page rotation.
 *
 * Why pdfjs and not Textract: every filed return we hold is a text PDF printed
 * by tax software onto the official IRS form (2026-10-17 probe: main-form pages
 * match the IRS blank's text at 96–100% of positions, 2022–2025). Position is
 * the whole game — a value is identified by WHICH BOX it sits in — and Textract's
 * reduced output throws geometry and checkboxes away. pdfjs gives exact run
 * positions, and its operator list gives the vector paths that several filers'
 * software uses to draw check marks (none of the twelve filed PDFs has a live
 * form field; all are flattened).
 */
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

export type BBox = [number, number, number, number]

export interface TextRun {
  text: string
  bbox: BBox
  /** Where the word was printed, when bbox has been moved onto a blank's
   *  coordinates (substitute-form alignment) */
  orig?: BBox
}

export interface LayoutPage {
  page: number
  width: number
  height: number
  runs: TextRun[]
  /** Bounding boxes of small vector paths (≤ 20pt each way): check marks,
   *  checkbox borders, rules. Template ones are subtracted by the caller. */
  marks: BBox[]
}

const MAX_MARK = 20

type Matrix = [number, number, number, number, number, number]

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function boxFromPoints(pts: Array<[number, number]>): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function readLayout(data: Uint8Array, opts: { marks?: boolean } = {}): Promise<LayoutPage[]> {
  // pdfjs transfers (detaches) the buffer it is given; hand it a copy so the
  // caller's bytes stay usable (hashing, a second pass).
  const doc = await getDocument({
    data: data.slice(),
    useSystemFonts: false,
    verbosity: 0,
  }).promise
  const out: LayoutPage[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale: 1 })
      const vt = vp.transform as Matrix
      const tc = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false })
      const runs: TextRun[] = []
      for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
        if (!it.str || !it.str.trim() || !it.transform) continue
        const t = it.transform as Matrix
        const m = multiply(vt, t)
        // Text space: x from 0 to width (already scaled into user units by
        // pdfjs), baseline at y=0; glyph box ≈ [-0.2h, 0.8h] around it.
        const h = it.height || Math.hypot(t[2], t[3]) || 8
        const w = it.width || 0
        const sx = Math.hypot(t[0], t[1]) || 1
        const sy = Math.hypot(t[2], t[3]) || 1
        // Convert user-unit width/height back into text-space units so the
        // matrix can place the corners.
        const tw = w / sx
        const th = h / sy
        const pts: Array<[number, number]> = [
          apply(m, 0, -0.2 * th),
          apply(m, tw, -0.2 * th),
          apply(m, 0, 0.8 * th),
          apply(m, tw, 0.8 * th),
        ]
        const b = boxFromPoints(pts)
        runs.push({ text: it.str, bbox: [r2(b[0]), r2(b[1]), r2(b[2]), r2(b[3])] })
      }
      const marks: BBox[] = []
      if (opts.marks !== false) {
        const ol = await page.getOperatorList()
        let ctm: Matrix = [1, 0, 0, 1, 0, 0]
        const stack: Matrix[] = []
        for (let i = 0; i < ol.fnArray.length; i++) {
          const fn = ol.fnArray[i]
          const args = ol.argsArray[i] as unknown[]
          if (fn === OPS.save) stack.push(ctm)
          else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
          else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix)
          else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm)
            const mtx = args?.[0] as Matrix | null
            if (Array.isArray(mtx) && mtx.length === 6) ctm = multiply(ctm, mtx)
          } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
          else if (fn === OPS.constructPath) {
            const minMax = args?.[2] as ArrayLike<number> | null
            if (!minMax || minMax.length < 4 || !Number.isFinite(minMax[0])) continue
            const m = multiply(vt, ctm)
            const b = boxFromPoints([
              apply(m, minMax[0], minMax[1]),
              apply(m, minMax[2], minMax[1]),
              apply(m, minMax[0], minMax[3]),
              apply(m, minMax[2], minMax[3]),
            ])
            const w = b[2] - b[0]
            const h = b[3] - b[1]
            if (w <= MAX_MARK && h <= MAX_MARK && (w > 1.5 || h > 1.5)) {
              marks.push([r2(b[0]), r2(b[1]), r2(b[2]), r2(b[3])])
            }
          }
        }
      }
      out.push({ page: p, width: r2(vp.width), height: r2(vp.height), runs, marks })
      page.cleanup()
    }
  } finally {
    await doc.destroy()
  }
  return out
}

/** Split a run into words with x positions estimated by character count.
 *  Runs from tax software are mostly single values; long template runs are
 *  never split for matching (they are compared whole). */
export function splitWords(run: TextRun): TextRun[] {
  const parts = run.text.split(/(\s+)/)
  if (parts.filter(p => p.trim()).length <= 1) return [{ text: run.text.trim(), bbox: run.bbox, ...(run.orig ? { orig: run.orig } : {}) }]
  const total = run.text.length || 1
  const [x0, y0, x1, y1] = run.bbox
  const per = (x1 - x0) / total
  const words: TextRun[] = []
  let pos = 0
  for (const part of parts) {
    if (part.trim()) {
      const a = x0 + per * pos
      const b = x0 + per * (pos + part.length)
      words.push({ text: part, bbox: [r2(a), y0, r2(b), y1] })
    }
    pos += part.length
  }
  return words
}
