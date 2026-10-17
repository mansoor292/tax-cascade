/**
 * Turn the IRS's accessibility text for a box into a location:
 * section, line, row, column, label.
 *
 * The text is written for a screen reader walking the form in order, so a
 * table's line number is spoken only on its first cell ("28. Row: A. Column:
 * (a) Name.") and a section title only on its first box ("Schedule L. Balance
 * Sheets per Books. Assets. Row: 1. Cash. Column: … (a)."). The XFA container
 * names carry the rest ("Table_Line28a-f", "Line6_ReadOrder"). So parsing is
 * stateful per page: a running context supplies what the current box leaves
 * unsaid, and the container name is preferred over carried context.
 *
 * Best effort by design — `desc` (the full official text) is always kept on the
 * entry, and the lines that checks depend on are pinned by tests per form year.
 */

export interface DescContext {
  section: string
  line: string
}

export interface Described {
  section: string
  line: string
  row?: string
  col?: string
  label: string
}

const ROMAN = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)$/

function normRoman(s: string): string {
  // The speak text spells "Part II" as "Part I I" and "(iv)" as "(i v)" for
  // the screen reader.
  return s
    .replace(/\b((?:I|V|X)(?: (?:I|V|X))+)\b/g, m => m.replace(/ /g, ''))
    .replace(/\(([ivx](?: [ivx])+)\)/g, (_, r: string) => `(${r.replace(/ /g, '')})`)
}

/** Blocks that are not numbered lines; boxes inside them must not inherit the
 *  last line number above them. */
const UNNUMBERED_BLOCK = /^(?:Sign Here|Paid Preparer|Third Party Designee|Under penalties of perjury|Preparer's|Firm's)/i

/** Section headers this text announces, in order (last one wins). */
function sectionsIn(s: string): string[] {
  const out: string[] = []
  const re = /(?:^|[.:]\s)(Schedule\s+(?:[A-Z]{1,2}(?:-\d)?|K-1|M-[123]))\.\s|(?:^|[.:]\s)(Part\s+[IVX]+)\.\s/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const sec = (m[1] || m[2]).replace(/\s+/g, ' ')
    const part = sec.startsWith('Part') ? sec.split(' ')[1] : ''
    if (part && !ROMAN.test(part)) continue
    out.push(sec)
  }
  return out
}

/** Line number from a container name: Table_Line28a-f → 28, Line6_ReadOrder → 6,
 *  Line1a_ReadOrder → 1a, Lines18-21 → 18. */
export function lineFromContainer(containers: string[]): string {
  for (let i = containers.length - 1; i >= 0; i--) {
    // "Table_Line28a-f" names COLUMNS a–f of line 28, not line 28a.
    const m = /(?:^|_)Lines?_?(\d{1,2})([a-z])?(-[a-z])?(?=$|[-_]|[A-Z])/i.exec(containers[i])
    if (m) return (m[3] ? m[1] : m[1] + (m[2] ?? '')).toLowerCase()
  }
  return ''
}

const LINE_AT = /(?:^|[.:;)]\s)(\d{1,2}[a-z]?)\.\s/
/** Lettered items: "A. S election effective date", "K1. Partner's share of
 *  liabilities", "H. Check if: (1). Final return" (→ H(1)). */
const LETTER_ITEM = /^([A-N]\d?)\.\s(?:[^.]*?(?:\((\d)\)|(?<=[\s:])(\d[a-z]?))\.\s)?/
const LINE_WORD = /\bLine\s+(\d{1,2}[a-z]?)\b/

export function describe(rawDesc: string, containers: string[], ctx: DescContext): Described {
  let s = normRoman(rawDesc.replace(/\s+/g, ' ').trim())
  s = s.replace(/^Page\s+\d+\.\s*/i, '')

  const secs = sectionsIn(s)
  if (secs.length) ctx.section = secs[secs.length - 1]
  if (UNNUMBERED_BLOCK.test(s)) ctx.line = ''

  let row: string | undefined
  let col: string | undefined
  let colText = ''
  let rowText = ''
  const rowM = /Row:\s*([^.]+?)\.(?:\s|$)(?:\s*([^:]*?)\.\s*(?=Column:|$))?/.exec(s)
  if (rowM) {
    row = rowM[1].trim()
    rowText = (rowM[2] || '').trim()
  }
  const colM = /Column:\s*(.*)$/.exec(s)
  if (colM) {
    colText = colM[1].replace(/\.\s*$/, '').trim()
    const letter = /\((\w{1,2})\)/.exec(colText)
    if (letter) col = letter[1].toLowerCase()
  }
  // Two-column items without letters (K-1 items D, H, I; 1065 K-1 J, K1, N):
  // "Beginning of tax year" / "End of tax year" / "Beginning" / "Ending".
  if (!col) {
    const be = /(?:^|[.:]\s|Column:\s*)(Beginning|Ending|End)\b(?: of (?:the )?tax year)?/i.exec(s)
    if (be) col = /^begin/i.test(be[1]) ? 'beginning' : 'end'
  }
  // Repeating entries (1125-E officers): "Line 1. Entry 2. (f) Amount…"
  const entry = /\bEntry (\d+)\./.exec(s)
  if (entry && !row) {
    row = entry[1]
    if (!col) {
      const c = /Entry \d+\.\s*(?:[^()]*?)\(([a-z])\)/.exec(s)
      if (c) col = c[1]
    }
  }

  // Line: an explicit "12a." beats a container name beats carried context.
  let line = ''
  const beforeRow = rowM ? s.slice(0, rowM.index) : s
  const lm = LINE_AT.exec(beforeRow) || LINE_AT.exec(' ' + beforeRow)
  const letterSrc = s.replace(/^(?:Schedule\s+\S+|Part\s+[IVX]+)\.\s.*?\.\s(?=[A-N]\d?\.\s)/, '')
  const letter = LETTER_ITEM.exec(letterSrc)
  if (letter && (!lm || letterSrc.indexOf(letter[0]) === 0)) {
    const sub = letter[2] ?? letter[3]
    line = sub ? `${letter[1]}(${sub})` : letter[1]
  } else if (lm) {
    line = lm[1]
    // "25. Federal income tax withheld from: a. Form(s) W-2" and "5. Dividends:
    // a. Ordinary dividends" are line 25a / 5a: the first sub-item is spoken
    // inside the line's own text.
    const after = beforeRow.slice(beforeRow.indexOf(lm[0]) + lm[0].length)
    if (/^\d{1,2}$/.test(line) && /^[^.]{0,70}:\s*a\.\s/.test(after)) line += 'a'
    // "2. b. Product or service" — the line number re-spoken before a sub-item
    else if (/^\d{1,2}$/.test(line) && /^([a-z])\.\s/.test(after)) line += after[0]
  }
  else {
    const lw = LINE_WORD.exec(beforeRow)
    if (lw) line = lw[1]
  }
  // Schedule L style rows ARE the line: "Row: 19. Loans from shareholders."
  if (!line && row && /^\d{1,2}[a-z]?$/.test(row) && rowText) {
    line = row
    row = undefined
  }
  if (!line) line = lineFromContainer(containers)
  // "b. Product or service" after line 2a is 2b; "c. Other" after 1b is 1c.
  if (!line) {
    const sub = /^([a-z])\.\s/.exec(s)
    const base = /^(\d{1,2})[a-z]?$/.exec(ctx.line)
    if (sub && base) line = base[1] + sub[1]
  }
  // A lettered item spoken once, then continued: "L. Row: Capital contributed…"
  // is handled above; bare "Row: …" rows inherit the item letter.
  if (!line && /^[A-N]\d?$/.test(ctx.line) && (rowM || colM)) line = ctx.line
  const short = s.split(/\s+/).length <= 3
  if (!line && (rowM || colM || short || /^\(\d\)/.test(s))) line = ctx.line
  if (line) ctx.line = line

  // Label: the text after the line marker, minus row/column scaffolding.
  let label = s
  if (rowM) label = [rowText, colText].filter(Boolean).join(' — ') || s
  else if (lm) label = s.slice(s.indexOf(lm[0]) + lm[0].length)
  else if (colM) label = colText
  label = label
    .replace(/^(?:Schedule\s+\S+|Part\s+[IVX]+)\.\s*/g, '')
    .replace(/\s*\.\s*$/, '')
    .trim()

  return { section: ctx.section, line, row, col, label: label || s }
}
