/**
 * Form 1120-S (2025) — the answers that are not amounts: header items G, H,
 * I, the Schedule B questionnaire (pages 2-3), the Schedule K line 14
 * checkboxes, "May the IRS discuss this return", and the paid-preparer block.
 *
 * Why this exists (2026-10-15 parity sprint): the filed 2025 EZ-Advisors
 * return was compared box by box against ours. Every Schedule B answer was
 * already stored (`input_data.schedB_answers_detail`), and not one of them
 * printed — the builder only knew the accounting-method box, and that one
 * checked "Other" as well as "Accrual". The preparer block, header G and the
 * shareholder count were blank too. A return that answers nothing on page 2
 * is not a complete filing, whatever page 1 says.
 *
 * Answers arrive as `{label, answer}` rows whose label starts with the line
 * the form prints ("3 Any shareholder a disregarded entity…", "14a Payments
 * requiring Forms 1099", "Header G …", "Sch K 14b …"). The leading token is the
 * key; the rest of the label is for people. An answer reads as Yes/No/Checked
 * by its first word, so "Yes - Form 1099-NEC issued…" is a Yes.
 *
 * Widget positions were read off the 2025 blank (rects matched against the
 * printed row labels). The ids are 2025-only: fill1120SAnswers refuses any
 * other year rather than writing them into another year's layout.
 */
import { PDFCheckBox, type PDFForm } from 'pdf-lib'

export type AnswerMap = Map<string, string>

/** Yes/No pairs: [0] = Yes, [1] = No. */
export const YES_NO_1120S_2025: Record<string, string> = {
  G: 'c1_2',
  DISCUSS: 'c1_11',
  '3': 'c2_2',
  '4a': 'c2_3',
  '4b': 'c2_4',
  '5a': 'c2_5',
  '5b': 'c2_6',
  '6': 'c2_7',
  '9': 'c2_9',
  '10': 'c2_10',
  '11': 'c2_11',
  '12': 'c3_1',
  '13': 'c3_2',
  '14a': 'c3_3',
  '14b': 'c3_4',
  '15': 'c3_5',
  '16': 'c3_6',
}

/** Single checkboxes: checked when the answer is Checked / Yes. */
export const SINGLE_CHECKS_1120S_2025: Record<string, string> = {
  H1: 'c1_3[0]', H2: 'c1_4[0]', H3: 'c1_5[0]', H4: 'c1_6[0]', H5: 'c1_7[0]',
  J1: 'c1_8[0]', J2: 'c1_8[1]',
  '7': 'c2_8[0]',
  K14a: 'c3_7[2]',
  K14b: 'c3_8[0]',
  SELF_EMPLOYED: 'c1_12[0]',
}

/**
 * Turn the stored answer rows into a map keyed by the form's own line ids.
 * Recognised label shapes: "3 …", "14a …", "Header G …", "Header H(4) …",
 * "Sch K 14b …", "May the IRS discuss …". Structured rows ({line, answer})
 * are accepted as-is.
 */
export function parseAnswers(detail: unknown): AnswerMap {
  const out: AnswerMap = new Map()
  if (!Array.isArray(detail)) return out
  for (const row of detail) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const answer = String(r.answer ?? r.value ?? '').trim()
    let key = typeof r.line === 'string' ? r.line : ''
    if (!key) {
      const label = String(r.label ?? '').trim()
      let m: RegExpMatchArray | null
      if ((m = label.match(/^Header\s+H\s*\(?(\d)\)?/i))) key = `H${m[1]}`
      else if ((m = label.match(/^Header\s+J\s*\(?(\d)\)?/i))) key = `J${m[1]}`
      else if ((m = label.match(/^Header\s+([A-Z])\b/i))) key = m[1].toUpperCase()
      else if ((m = label.match(/^Sch(?:edule)?\.?\s*K\s+(\d+[a-z]?)\b/i))) key = `K${m[1]}`
      else if (/^May the IRS discuss/i.test(label)) key = 'DISCUSS'
      else if (/^Paid preparer self-employed/i.test(label)) key = 'SELF_EMPLOYED'
      else if ((m = label.match(/^(\d+[a-z]?)\b/))) key = m[1]
    }
    if (key) out.set(key, answer)
  }
  return out
}

export function answerIs(answer: string | undefined, word: 'yes' | 'no' | 'checked'): boolean {
  if (!answer) return false
  const a = answer.trim().toLowerCase()
  if (word === 'checked') return a === 'checked' || a === 'x' || a.startsWith('yes')
  return a === word || a.startsWith(word + ' ') || a.startsWith(word + '-') || a.startsWith(word + ',')
}

function checkExact(form: PDFForm, id: string): boolean {
  for (const f of form.getFields()) {
    const n = f.getName()
    if (f instanceof PDFCheckBox && (n.endsWith('.' + id) || n === id)) { f.check(); return true }
  }
  return false
}

function textField(form: PDFForm, shortId: string) {
  for (const f of form.getFields()) {
    const n = f.getName()
    if (n.endsWith('.' + shortId + '[0]') || n === shortId + '[0]') {
      try { return form.getTextField(n) } catch { return null }
    }
  }
  return null
}

function setText(form: PDFForm, shortId: string, value: string | number | undefined | null): boolean {
  if (value === undefined || value === null || value === '') return false
  const f = textField(form, shortId)
  if (!f) return false
  const s = String(value)
  const max = f.getMaxLength()
  if (max !== undefined && s.length > max) f.setMaxLength(s.length)
  f.setText(s)
  return true
}

function clearText(form: PDFForm, shortId: string): void {
  const f = textField(form, shortId)
  if (f) f.setText('')
}

export interface Preparer {
  name?: string
  ptin?: string
  firm_name?: string
  firm_ein?: string
  firm_address?: string
  phone?: string
  self_employed?: boolean
}

/** A US address prints no country — the form's Country box is for foreign addresses. */
export function isUnitedStates(country: unknown): boolean {
  return /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(String(country ?? '').trim())
}

/**
 * Fill header G/H/I/J, Schedule B, Schedule K 14a/14b, the IRS-discuss box
 * and the preparer block on a filled 2025 Form 1120-S. Returns the number of
 * boxes written. Does nothing (returns 0) for any other year.
 */
export function fill1120SAnswers(
  form: PDFForm,
  year: number,
  opts: {
    answers: AnswerMap
    accountingMethod?: string
    businessActivity?: string
    productService?: string
    shareholderCount?: number
    preparer?: Preparer | null
    country?: unknown
  },
): number {
  if (year !== 2025) return 0
  let n = 0
  const { answers } = opts

  for (const [key, group] of Object.entries(YES_NO_1120S_2025)) {
    const a = answers.get(key)
    if (answerIs(a, 'yes')) n += checkExact(form, `${group}[0]`) ? 1 : 0
    else if (answerIs(a, 'no')) n += checkExact(form, `${group}[1]`) ? 1 : 0
  }
  for (const [key, id] of Object.entries(SINGLE_CHECKS_1120S_2025)) {
    if (answerIs(answers.get(key), 'checked')) n += checkExact(form, id) ? 1 : 0
  }

  // Schedule B line 1: [0] cash, [1] accrual, [2] other (+ f2_1 "specify").
  const method = String(answers.get('1') || opts.accountingMethod || '').trim().toLowerCase()
  if (method.startsWith('cash')) n += checkExact(form, 'c2_1[0]') ? 1 : 0
  else if (method.startsWith('accrual')) n += checkExact(form, 'c2_1[1]') ? 1 : 0
  else if (method) {
    n += checkExact(form, 'c2_1[2]') ? 1 : 0
    n += setText(form, 'f2_1', method.replace(/^other[:\s-]*/, '')) ? 1 : 0
  }

  // Schedule B line 2a / 2b — the stored answer is what was filed.
  n += setText(form, 'f2_2', answers.get('2a') || opts.businessActivity) ? 1 : 0
  n += setText(form, 'f2_3', answers.get('2b') || opts.productService) ? 1 : 0

  // Header I — number of shareholders.
  const count = answers.get('I') || (opts.shareholderCount ? String(opts.shareholderCount) : '')
  if (count) n += setText(form, 'f1_16', count) ? 1 : 0

  // Country box only for a foreign address.
  if (isUnitedStates(opts.country)) clearText(form, 'f1_9')

  // Paid preparer block (2025 ids). The PTIN is an identifier: written, never logged.
  const p = opts.preparer
  if (p) {
    n += setText(form, 'f1_57', p.name) ? 1 : 0
    n += setText(form, 'f1_58', p.ptin) ? 1 : 0
    n += setText(form, 'f1_59', p.firm_name) ? 1 : 0
    n += setText(form, 'f1_60', p.firm_ein) ? 1 : 0
    n += setText(form, 'f1_61', p.firm_address) ? 1 : 0
    n += setText(form, 'f1_62', p.phone) ? 1 : 0
    if (p.self_employed) n += checkExact(form, 'c1_12[0]') ? 1 : 0
  }
  return n
}
