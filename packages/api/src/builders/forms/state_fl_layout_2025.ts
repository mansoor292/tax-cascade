/**
 * Florida F-1120 (R. 01/26, used for tax years ending in 2025) — where each
 * value is drawn on the Department's flat hand-print form.
 *
 * Coordinates are PDF points from the TOP-LEFT of the page (the blank's own
 * text-extraction coordinates), converted at draw time. The digit-box rows
 * come from scripts/state_forms/gen_fl_layout.py, which reads the boxes from
 * the blank's drawings; everything else was measured from the label it sits
 * beside on the same blank. Verified for this revision only — see state_fl.ts.
 */

export interface FlComb { page: number; y: number; neg: number | null; dollars: number[]; cents: number[] }
export interface FlCells { page: number; y: number; xs: number[] }
export interface FlText { page: number; x: number; base: number; align?: 'left' | 'right'; size?: number }
export interface FlTick { page: number; x: number; base: number }

export const FL_CELL_W = 13.5
export const FL_CELL_H = 17.8

const C9 = [391.1, 408.3, 425.5, 442.7, 459.9, 477.1, 494.3, 511.5, 528.7]
const C11 = [356.8, 373.9, 391.1, 408.3, 425.5, 442.7, 459.9, 477.1, 494.3, 511.5, 528.7]
const CENTS = [563.1, 580.3]

/** Amount rows of one-digit boxes: lines 1-19 and the coupon. Generated. */
export const FL_COMB: Record<string, FlComb> = {
  L1: { page: 1, y: 188.7, neg: 329.1, dollars: C11, cents: CENTS },
  L2: { page: 1, y: 212.5, neg: 329.1, dollars: C11, cents: CENTS },
  L3: { page: 1, y: 236.5, neg: 329.1, dollars: C11, cents: CENTS },
  L4: { page: 1, y: 260.4, neg: 329.1, dollars: C11, cents: CENTS },
  L5: { page: 1, y: 284.6, neg: 329.1, dollars: C11, cents: CENTS },
  L6: { page: 1, y: 308.5, neg: 329.1, dollars: C11, cents: CENTS },
  L7: { page: 1, y: 332.4, neg: 356.4, dollars: C9, cents: CENTS },
  L8: { page: 1, y: 356.3, neg: 356.4, dollars: C9, cents: CENTS },
  L9: { page: 1, y: 380.7, neg: null, dollars: [459.9, 477.1, 494.3, 511.5, 528.7], cents: CENTS },
  L10: { page: 1, y: 404.4, neg: null, dollars: C9, cents: CENTS },
  L11: { page: 1, y: 428.3, neg: null, dollars: C9, cents: CENTS },
  L12: { page: 1, y: 452.2, neg: null, dollars: C9, cents: [562.5, 579.7] },
  L13: { page: 1, y: 476.7, neg: null, dollars: C9, cents: CENTS },
  coupon_amount_due: { page: 1, y: 607.2, neg: null, dollars: [390.5, ...C9.slice(1)], cents: CENTS },
  coupon_credit: { page: 1, y: 631.2, neg: null, dollars: [390.5, ...C9.slice(1)], cents: CENTS },
  coupon_refund: { page: 1, y: 655.2, neg: null, dollars: [390.5, ...C9.slice(1)], cents: CENTS },
  L14: { page: 2, y: 75.5, neg: null, dollars: C9, cents: CENTS },
  L15: { page: 2, y: 99.4, neg: null, dollars: C9, cents: CENTS },
  L16: { page: 2, y: 123.4, neg: null, dollars: C9, cents: CENTS },
  L17: { page: 2, y: 153.8, neg: null, dollars: C9, cents: CENTS },
  L18: { page: 2, y: 177.8, neg: null, dollars: C9, cents: CENTS },
  L19: { page: 2, y: 201.8, neg: null, dollars: C9, cents: CENTS },
}

/** One character per box, left to right: identifiers, dates, the activity code. Generated. */
export const FL_CELLS: Record<string, FlCells> = {
  fein: { page: 1, y: 140.8, xs: [63.2, 79.4, 95.7, 111.8, 128.1, 144.2, 160.4, 176.6, 192.9] },
  year_end_date: { page: 1, y: 151.9, xs: [451.7, 468.9, 499.7, 516.9, 547.7, 564.9] },
  coupon_fein: { page: 1, y: 679.2, xs: [390.5, 408.3, 425.5, 442.7, 459.9, 477.1, 494.3, 511.5, 528.7] },
  E_activity_code: { page: 2, y: 434.8, xs: [48.2, 63.7, 79.2, 94.6, 110.1, 125.5] },
}

const T = (page: number, x: number, base: number, align?: 'left' | 'right'): FlText => ({ page, x, base, align })

/** Free text, measured from the label each value sits beside. */
export const FL_TEXT: Record<string, FlText> = {
  name: T(1, 395, 77), address: T(1, 405, 89), city_state_zip: T(1, 425, 101),
  tax_year_begin: T(1, 285, 133), tax_year_end: T(1, 274, 144),
  // coupon: "YEAR ENDING" boxes are printed letters M M D D Y Y, one digit under each
  coupon_name: T(1, 112, 662), coupon_address: T(1, 112, 674), coupon_city_state: T(1, 112, 686), coupon_zip: T(1, 112, 698),
  L14a: T(2, 126, 80), L14b: T(2, 232, 80), L14c: T(2, 126, 92), L14d: T(2, 232, 92),
  L16a: T(2, 240, 128), L16b: T(2, 240, 141),
  title: T(2, 372, 289), sign_date: T(2, 302, 297),
  preparer_date: T(2, 302, 324), preparer_ptin: T(2, 430, 324),
  firm_name: T(2, 115, 345), firm_fein: T(2, 374, 341), firm_address: T(2, 104, 355), firm_zip: T(2, 368, 355),
  A_state_of_incorporation: T(2, 140, 384), B_document_number: T(2, 150, 396),
  G2_fein: T(2, 440, 399), G2_name: T(2, 394, 411),
  H_books_address: T(2, 414, 435), H_city: T(2, 348, 447), H_state: T(2, 492, 447), H_zip: T(2, 547, 447),
  J_audit_date: T(2, 414, 471), J_years_examined: T(2, 398, 483),
  K_contact: T(2, 438, 495), K_phone_area: T(2, 436, 507), K_phone: T(2, 458, 507), K_email: T(2, 426, 519),
  L_other_return: T(2, 470, 531),
}

/** Coupon YEAR ENDING: one character centred under each printed M M D D Y Y. */
export const FL_COUPON_YEAR_ENDING = { page: 1, base: 601, xs: [128.5, 144.5, 160.5, 176.5, 193.5, 209] }

/** Pages 3-6 repeat NAME / FEIN / TAXABLE YEAR ENDING. */
export const FL_PAGE_HEADERS: Array<{ page: number; base: number; name: number; fein: number; year: number }> = [
  { page: 3, base: 71, name: 46, fein: 364, year: 547 },
  { page: 4, base: 77, name: 45, fein: 363, year: 547 },
  { page: 5, base: 77, name: 45, fein: 363, year: 547 },
  { page: 6, base: 72, name: 61, fein: 363, year: 543 },
]

/** Yes/No and one-of boxes: the centre of the printed box glyph. Key is `${question}:${option}`. */
export const FL_TICKS: Record<string, FlTick> = {
  'name_address_changed:yes': { page: 1, x: 397.5, base: 120 },
  'preparer_self_employed:yes': { page: 2, x: 397.8, base: 320 },
  'C_consolidated:yes': { page: 2, x: 163, base: 410 }, 'C_consolidated:no': { page: 2, x: 185.5, base: 410 },
  'D_initial:yes': { page: 2, x: 52.5, base: 422 }, 'D_final:yes': { page: 2, x: 100.5, base: 422 },
  'F_extension:yes': { page: 2, x: 187.5, base: 466 }, 'F_extension:no': { page: 2, x: 212.5, base: 466 },
  'G1_controlled_group:yes': { page: 2, x: 196.5, base: 478 }, 'G1_controlled_group:no': { page: 2, x: 221.5, base: 478 },
  'G2_federal_consolidated:yes': { page: 2, x: 454.5, base: 389 }, 'G2_federal_consolidated:no': { page: 2, x: 478.5, base: 389 },
  'G3_parent_in_florida:yes': { page: 2, x: 535.5, base: 425 }, 'G3_parent_in_florida:no': { page: 2, x: 559.5, base: 425 },
  'I_partnership:yes': { page: 2, x: 522.5, base: 461 }, 'I_partnership:no': { page: 2, x: 547, base: 461 },
  'L_federal_return:1120': { page: 2, x: 408.5, base: 533 }, 'L_federal_return:1120S': { page: 2, x: 434.5, base: 533 },
}

/** Schedule amounts, right-aligned at the end of each line's answer space. */
export const FL_AMOUNTS: Record<string, FlText> = (() => {
  const out: Record<string, FlText> = {}
  const right = (page: number, x: number, base: number): FlText => ({ page, x, base, align: 'right' })
  // Schedule I (page 3): lines 1-26 every 14pt from 90.7
  for (let n = 1; n <= 26; n++) out[`schedI_L${n}`] = right(3, 588, 90.7 + 14 * (n - 1) + 7.5)
  // Schedule II (page 3)
  const s2: Record<number, number> = { 1: 535, 2: 592, 3: 621, 4: 640, 5: 654, 6: 668, 7: 682, 8: 696, 9: 710, 10: 724, 11: 738, 12: 752, 13: 766 }
  for (const [n, base] of Object.entries(s2)) out[`schedII_L${n}`] = right(3, 588, base)
  Object.assign(out, {
    schedII_L1a: right(3, 262, 513), schedII_L1b: right(3, 262, 525), schedII_L1c: right(3, 262, 536), schedII_L1d: right(3, 262, 564),
    schedII_L2a: right(3, 262, 593), schedII_L2b: right(3, 259, 602),
  })
  // Schedule III-A (page 4): lines 1-4, columns (a)-(e)
  const a3 = { a: 195, b: 284, c: 368, d: 468, e: 581 }
  ;[163, 175, 187, 199].forEach((base, i) => {
    for (const [col, x] of Object.entries(a3)) out[`schedIIIA_L${i + 1}_${col}`] = right(4, x, base)
  })
  // Schedule III-B (page 4): lines 1-5 columns (a)-(d), then 6-8 a/b
  const b3 = { a: 348, b: 426, c: 522, d: 588 }
  ;[234, 246, 258, 270, 282].forEach((base, i) => {
    for (const [col, x] of Object.entries(b3)) out[`schedIIIB_L${i + 1}_${col}`] = right(4, x, base)
  })
  Object.assign(out, {
    schedIIIB_L6a: right(4, 488, 302), schedIIIB_L6b: right(4, 590, 312),
    schedIIIB_L7a: right(4, 488, 331), schedIIIB_L7b: right(4, 590, 341),
    schedIIIB_L8a: right(4, 488, 368), schedIIIB_L8b: right(4, 590, 387),
  })
  // Schedule III-C (page 4): lines 1-4, columns (a)(b); III-D lines 1-2, columns (a)-(c)
  ;[428, 440, 452, 464].forEach((base, i) => {
    out[`schedIIIC_L${i + 1}_a`] = right(4, 470, base)
    out[`schedIIIC_L${i + 1}_b`] = right(4, 585, base)
  })
  ;[500, 512].forEach((base, i) => {
    out[`schedIIID_L${i + 1}_a`] = right(4, 360, base)
    out[`schedIIID_L${i + 1}_b`] = right(4, 476, base)
    out[`schedIIID_L${i + 1}_c`] = right(4, 590, base)
  })
  // Schedule IV (page 4): lines 1-9 every 15pt from 552.9
  for (let n = 1; n <= 9; n++) out[`schedIV_L${n}`] = right(4, 588, 552.9 + 15 * (n - 1) + 7.5)
  // Schedule V (page 5): lines 1-24 every 14pt from 99.1, line 25 at 439.5
  for (let n = 1; n <= 24; n++) out[`schedV_L${n}`] = right(5, 588, 99.1 + 14 * (n - 1) + 7.5)
  out.schedV_L25 = right(5, 588, 448)
  // Schedule R (page 5)
  Object.assign(out, { schedR_L1: right(5, 560, 557), schedR_L2: right(5, 560, 659), schedR_L3: right(5, 560, 695) })
  // Page 6 worksheets
  Object.assign(out, {
    est_L1: right(6, 560, 99), est_L2: right(6, 560, 123), est_L3: right(6, 560, 135),
    est_L4_tax: right(6, 360, 147), est_L4: right(6, 560, 159),
    est_L5a: right(6, 560, 224), est_L5b: right(6, 560, 238), est_L5c: right(6, 560, 251), est_L5d: right(6, 560, 266),
    amended_L1: right(6, 560, 326), amended_L2a: right(6, 430, 362), amended_L2b: right(6, 430, 374),
    amended_L2c: right(6, 560, 386), amended_L3: right(6, 560, 398), amended_L4: right(6, 560, 410),
  })
  return out
})()
