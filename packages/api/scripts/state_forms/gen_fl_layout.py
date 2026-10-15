"""
gen_fl_layout.py — measure the digit-cell rows of Florida F-1120 (R. 01/26) for
src/builders/forms/state_fl_layout_2025.ts.

Why measured, not fillable: Florida publishes F-1120 only as a flat hand-print
form (no form fields), so values are drawn at coordinates. Lines 1-19 and the
payment coupon are rows of one-digit boxes: an optional "negative" box, the
dollar cells, then two cents cells after the printed decimal point. Reading
the boxes from the blank's own drawings keeps every digit inside its cell; a
hand-typed table of 250 x-coordinates would drift. Prints the comb rows as TS
object literals; the text positions (names, questions, schedules) are typed by
hand in the layout file from the same blank.

  python3 scripts/state_forms/gen_fl_layout.py data/state_forms/fl_f1120_2025.pdf
"""
import re
import sys
from collections import defaultdict

import pymupdf as fitz

DECIMAL_X = 549.3  # the printed "." between dollars and cents on every amount row


def cells(page):
    out = []
    for d in page.get_drawings():
        for it in d['items']:
            r = it[1] if it[0] == 're' else (it[1].rect if it[0] == 'qu' else None)
            if r is not None and 12 <= r.width <= 14.5 and 15 <= r.height <= 19:
                out.append(r)
    # dedupe (some cells are drawn twice: fill + stroke)
    uniq = {}
    for r in out:
        uniq[(round(r.x0), round(r.y0))] = r
    return list(uniq.values())


def rows_by_y(rs):
    rows = defaultdict(list)
    for r in sorted(rs, key=lambda r: r.y0):
        for y in list(rows):
            if abs(y - r.y0) <= 2.5:
                rows[y].append(r)
                break
        else:
            rows[r.y0].append(r)
    return {y: sorted(v, key=lambda r: r.x0) for y, v in rows.items()}


def split(row):
    """-> (neg x or None, dollar xs, cents xs)."""
    cents = [r for r in row if r.x0 > DECIMAL_X]
    rest = [r for r in row if r.x0 <= DECIMAL_X]
    neg = None
    if len(rest) > 1 and rest[1].x0 - rest[0].x0 > 25:
        neg, rest = rest[0], rest[1:]
    return neg, rest, cents


def label_for(page, y):
    """The line number printed just left of the cells on this row ("1.", "14.")."""
    best = None
    for w in page.get_text('words'):
        if re.fullmatch(r'\d{1,2}\.', w[4]) and abs((w[1] + w[3]) / 2 - (y + 9)) < 8 and w[0] > 300:
            best = w[4].rstrip('.')
    return best


def main(path):
    doc = fitz.open(path)
    for pno in (0, 1):
        page = doc[pno]
        for y, row in sorted(rows_by_y(cells(page)).items()):
            neg, dollars, cents = split(row)
            lab = label_for(page, y)
            f = lambda xs: '[' + ', '.join(f'{r.x0:.1f}' for r in xs) + ']'
            print(f"  // page {pno + 1} y={y:.1f} label={lab} n={len(row)}")
            print(f"  {{ page: {pno + 1}, y: {y:.1f}, neg: {f'{neg.x0:.1f}' if neg else 'null'}, "
                  f"dollars: {f(dollars)}, cents: {f(cents)} }},")


if __name__ == '__main__':
    main(sys.argv[1])
