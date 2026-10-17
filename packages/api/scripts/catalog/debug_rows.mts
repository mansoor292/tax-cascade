/**
 * Print a page's words with positions, grouped into printed lines, between two
 * y coordinates — for diagnosing where a value sits relative to its label.
 *   npx tsx scripts/catalog/debug_rows.mts RETURN.pdf PAGE Y0 Y1
 * Prints the return's text: pipe through a mask, never paste it anywhere.
 */
import { readFileSync } from 'node:fs'
import { readLayout, splitWords } from '../../src/catalog/pdf_layout.js'
const [file, pg, y0, y1] = process.argv.slice(2)
const L = await readLayout(new Uint8Array(readFileSync(file)))
const p = L[Number(pg) - 1]
const ws = p.runs.flatMap(r => splitWords(r)).filter(w => w.bbox[1] >= Number(y0) && w.bbox[1] <= Number(y1))
ws.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
let lastY = -1, line: string[] = []
for (const w of ws) { if (Math.abs(w.bbox[1] - lastY) > 2.5) { if (line.length) console.log(line.join('  ')); line = []; lastY = w.bbox[1] } line.push(`${w.text.slice(0, 18)}@${Math.round(w.bbox[0])},${Math.round(w.bbox[1])}`) }
console.log(line.join('  '))
