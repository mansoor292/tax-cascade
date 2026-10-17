/**
 * Read the IRS's own description of every field from a blank form's XFA
 * template.
 *
 * Every IRS fillable PDF is an XFA/AcroForm hybrid. Each field in the XFA
 * template carries an accessibility <speak> (or <toolTip>) text such as
 * "Row: 19. Loans from shareholders. Column: End of tax year. (d)." — the
 * line, row, column and official label of that box. That turns the line
 * dictionary from a guessing exercise (label text left of the box, the way the
 * old Textract field maps were built) into a lookup of what the IRS itself
 * says the box is. The AcroForm widget names are the XFA paths with sibling
 * indexes ("topmostSubform[0].Page4[0].f4_5[0]"), so the two join exactly.
 *
 * A deliberately small XML walker: the template is machine-written and regular,
 * and pulling in an XML dependency for one offline build step isn't worth it.
 */

export interface XfaField {
  /** AcroForm-style full name: topmostSubform[0].Page1[0].f1_1[0] */
  name: string
  /** 'textEdit' | 'checkButton' | 'choiceList' | 'dateTimeEdit' | 'numericEdit' | … */
  ui: string
  /** <speak> text, or <toolTip> when there is no speak; whitespace-normalised */
  desc: string
  /** Names of the enclosing named containers, outermost first (no indexes) */
  containers: string[]
  /** Export ("on") value for check buttons, from <items> */
  on?: string
}

const CONTAINERS = new Set(['subform', 'exclGroup', 'subformSet'])

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
  return m ? decodeEntities(m[1]) : undefined
}

interface Frame {
  tag: string
  name?: string
  /** sibling counters for named children of THIS element */
  counts: Map<string, number>
  /** indexed path segment contributed by this element (named containers/fields) */
  seg?: string
}

export function parseXfaTemplate(xml: string): XfaField[] {
  const out: XfaField[] = []
  const stack: Frame[] = [{ tag: '#root', counts: new Map() }]
  // Current field being read
  let field: { name: string; ui: string; speak: string; tip: string; on?: string; containers: string[] } | null = null
  let fieldDepth = -1
  // Which text-bearing element we are inside (speak/toolTip/items text)
  let capture: 'speak' | 'toolTip' | 'item' | null = null
  let itemsDepth = -1
  let itemIndex = 0
  let buf = ''

  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+="[^"]*")*)\s*(\/?)>|([^<]+)|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const [, close, rawTag, attrs = '', selfClose, text, cdata] = m
    if (text !== undefined || cdata !== undefined) {
      if (capture) buf += cdata ?? decodeEntities(text!)
      continue
    }
    if (!rawTag) continue
    const tag = rawTag.includes(':') ? rawTag.split(':').pop()! : rawTag
    if (!close) {
      const parent = stack[stack.length - 1]
      const frame: Frame = { tag, counts: new Map() }
      const name = attr(attrs, 'name')
      if ((CONTAINERS.has(tag) || tag === 'field') && name) {
        const i = parent.counts.get(name) ?? 0
        parent.counts.set(name, i + 1)
        frame.name = name
        frame.seg = `${name}[${i}]`
      }
      if (tag === 'field' && !field) {
        const path = [...stack.map(f => f.seg).filter(Boolean), frame.seg].filter(Boolean) as string[]
        field = {
          name: path.join('.'),
          ui: '',
          speak: '',
          tip: '',
          containers: stack.filter(f => f.name && f.tag !== 'field').map(f => f.name!),
        }
        fieldDepth = stack.length
      } else if (field) {
        const depth = stack.length
        if (depth === fieldDepth + 2 && stack[fieldDepth + 1]?.tag === 'ui' && !field.ui) field.ui = tag
        if (tag === 'speak' || tag === 'toolTip') { capture = tag; buf = '' }
        if (tag === 'items' && itemsDepth < 0) { itemsDepth = depth; itemIndex = 0 }
        if (itemsDepth >= 0 && depth === itemsDepth + 1) { capture = 'item'; buf = '' }
      }
      if (selfClose) {
        if (capture && (tag === 'speak' || tag === 'toolTip')) capture = null
        if (itemsDepth >= 0 && stack.length === itemsDepth + 1) itemIndex++
        continue
      }
      stack.push(frame)
    } else {
      const frame = stack.pop()
      if (!frame) continue
      if (field) {
        if (capture === 'speak' && tag === 'speak') { field.speak = buf; capture = null }
        else if (capture === 'toolTip' && tag === 'toolTip') { field.tip = buf; capture = null }
        else if (capture === 'item' && itemsDepth >= 0 && stack.length === itemsDepth + 1) {
          // First item of a check button's <items> is its "on" value.
          if (itemIndex === 0 && buf.trim()) field.on = buf.trim()
          itemIndex++
          capture = null
        }
        if (tag === 'items' && stack.length === itemsDepth) itemsDepth = -1
        if (tag === 'field' && stack.length === fieldDepth) {
          out.push({
            name: field.name,
            ui: field.ui,
            desc: (field.speak || field.tip).replace(/\s+/g, ' ').trim(),
            containers: field.containers,
            on: field.on,
          })
          field = null
          fieldDepth = -1
          capture = null
          itemsDepth = -1
        }
      }
    }
  }
  return out
}
