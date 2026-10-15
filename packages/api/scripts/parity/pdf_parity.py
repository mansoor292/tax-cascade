"""
pdf_parity.py — compare a generated return package against a filed one, box by box.

Why this exists (2026-10-15): the three 2025 returns were filed from outside
software, and a line-by-line read of the filed PDFs against ours found values
on the wrong line (Form 4562 field IDs from another year, cost of goods sold
fuzzy-matched into Schedule J "Total credits"), whole forms we never generate
(K-1, 1125-E, Schedule O, 2220, every 1040 schedule) and data we never stored.
None of it was visible from inside: the builder reports `filled: N` and the
page looks healthy. Reading two PDFs side by side by hand does not scale and
does not repeat, so the filed return becomes the test.

How it compares. The filer's software and our builder both print onto the
official IRS PDFs, and the template geometry is identical (verified: every
label sits at the same coordinates in the blank, the filed page and ours).
So each page is matched to a blank IRS page by its template words, the
template words are subtracted, and what is left is the filled-in text. That
text is assigned to the blank form's widget whose rectangle contains it, on
BOTH sides, and the comparison is per widget: same box, same value. A value
that lands in the wrong box shows up as a mismatch in two boxes, which is
exactly the class of bug this is for. Pages that match no blank (statements,
worksheets, state forms we have no blank for) are compared as
(description, amount) rows.

Identifiers are never printed: values shaped like an SSN/EIN/PTIN/account
number are compared but reported as [ID].

Usage:
  python3 scripts/parity/pdf_parity.py --filed FILED.pdf --api OURS.pdf \
      [--blanks data/irs_forms] [--year 2025] [--json out.json] [--report out.md]
Exit status 0 when every filed value is matched, 1 otherwise.
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict

import pymupdf as fitz

ID_PATTERNS = [
    re.compile(r'(?<![\d,.])\d(?:(?: {0,3}| *- *)\d){8,}(?![\d,.])'),
    re.compile(r'\b\d{3}[- ]?\d{2}[- ]?\d{4}\b'),
    re.compile(r'\b\d{2}[- ]\d{7}\b'),
    re.compile(r'\bP(?: {0,3}\d){8}\b'),
    re.compile(r'\b\d{8,17}\b'),
]


def mask(s: str) -> str:
    for r in ID_PATTERNS:
        s = r.sub('[ID]', s)
    return s


CHECK_GLYPHS = {'x', 'X', '4', '8', '✔', '✓', '✗', '✘', '■', '●', 'l', 'n', '3'}
AMOUNT = re.compile(r'^\(?-?\$?\s*[\d,]+(\.\d+)?\s*\)?\.?$')


def norm_value(s: str, is_check: bool) -> str:
    s = ' '.join(s.split())
    if is_check:
        return 'X' if s else ''
    t = s.replace('$', '').replace(' ', '')
    if AMOUNT.match(t) and re.search(r'\d', t):
        neg = t.startswith('(') or t.startswith('-')
        digits = re.sub(r'[^\d.]', '', t).rstrip('.')
        try:
            v = float(digits)
        except ValueError:
            return s.lower()
        v = -v if neg else v
        if v == int(v):
            return str(int(v))
        return f'{v:.2f}'
    return s.lower()


# ─── Blank forms ───

class BlankPage:
    def __init__(self, form, pno, page):
        self.form = form
        self.pno = pno
        self.key = f'{form}#p{pno + 1}'
        self.words = [(w[0], w[1], w[2], w[3], w[4]) for w in page.get_text('words')]
        self.vocab = set(w[4].lower() for w in self.words if len(w[4]) > 2)
        self.header = header_forms(self.words)
        self.widgets = []
        raw = list(page.widgets() or [])
        counts = defaultdict(int)
        for wd in raw:
            counts[wd.field_name] += 1
        seen = defaultdict(int)
        for wd in raw:
            r = wd.rect
            name = wd.field_name
            # IRS fields have unique names ("c2_1[0]", "c2_1[1]"). State fill-ins
            # reuse ONE name for a Yes/No pair or a filing-status set and tell
            # the boxes apart by export value; keyed by name alone, a "No"
            # filed against a "Yes" generated merged into one box and matched.
            if counts[name] > 1:
                if wd.field_type_string in ('CheckBox', 'RadioButton'):
                    on = [st for st in (wd.button_states() or {}).get('normal', []) if st != 'Off']
                    name = f'{name}#{on[0] if on else seen[name]}'
                else:
                    name = f'{name}#{seen[wd.field_name]}'
                seen[wd.field_name] += 1
            self.widgets.append({
                'name': name, 'type': wd.field_type_string,
                'rect': (r.x0, r.y0, r.x1, r.y1),
            })
        self.labels = {}
        self.context = {}
        for wd in self.widgets:
            self.labels[wd['name']] = self._label_for(wd['rect'])
            self.context[wd['name']] = self.labels[wd['name']] + ' ' + self._caption_for(wd['rect'])

    def _caption_for(self, rect):
        """Template text printed just ABOVE a box over its width — where many
        forms caption a box ("Spouse's Identity Protection PIN")."""
        x0, y0, x1, y1 = rect
        cap = [w for w in self.words if y0 - 16 <= w[3] <= y0 + 1 and w[2] > x0 - 2 and w[0] < x1 + 2]
        cap.sort(key=lambda w: (w[1], w[0]))
        return ' '.join(w[4] for w in cap)[:120]

    def _label_for(self, rect):
        """The template text to the left of a box on the same row: line number + words."""
        x0, y0, x1, y1 = rect
        cy = (y0 + y1) / 2
        row = [w for w in self.words if w[1] - 2 <= cy <= w[3] + 2 and w[2] <= x0 + 1]
        row.sort(key=lambda w: w[0])
        text = ' '.join(w[4] for w in row if not re.fullmatch(r'[.\s]+', w[4]))
        text = re.sub(r'(\s*\.){2,}', ' ', text)
        return text[-70:].strip()


def load_blanks(dirs, year):
    pages = []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, f'*_{year}.pdf'))):
            form = os.path.basename(path)[: -len(f'_{year}.pdf')]
            doc = fitz.open(path)
            form_pages = [BlankPage(form, i, p) for i, p in enumerate(doc)]
            # A FLAT form has no fields on any page (Florida publishes F-1120
            # only as a hand-print form): values are drawn at coordinates, so
            # there are no boxes to compare. Its pages still classify, and are
            # compared by value instead (see flat_tokens).
            flat = not any(bp.widgets for bp in form_pages)
            form_text = set(w[4] for bp in form_pages for w in bp.words)
            for bp in form_pages:
                bp.flat = flat
                bp.form_text = form_text
                if len(bp.vocab) > 30:  # skip near-empty / instruction-only pages without fields
                    pages.append(bp)
    return pages


FORM_NO = re.compile(r'^(?:\d{3,4}[A-Z]?(?:-[A-Z0-9]+)?|[A-Z]{1,3}-\d{2,4}(?:-[A-Z])?)$')


def header_forms(words, n=40):
    """Form numbers printed in a page's header ("1120-S", "1040", "8995-A", "IT-203")."""
    top = sorted(words, key=lambda w: (round(w[1]), w[0]))[:n]
    return {w[4].strip('(),') for w in top if FORM_NO.match(w[4].strip('(),'))}


def classify(page_words, blanks):
    vocab = set(w[4].lower() for w in page_words if len(w[4]) > 2)
    hdr = header_forms(page_words)
    best, score = None, 0.0
    for b in blanks:
        if not b.widgets and not b.flat:
            continue
        if hdr and b.header and not (hdr & b.header):
            continue
        inter = len(vocab & b.vocab)
        s = inter / max(1, len(b.vocab))
        # penalise a page carrying lots of words the blank lacks (a different form)
        s -= 0.25 * len(vocab - b.vocab) / max(1, len(vocab))
        if s > score:
            best, score = b, s
    return (best, score) if score >= 0.55 else (None, score)


# ─── Filled values ───

def reading_order(ws, tol=2.0):
    """Words in reading order: rows clustered by vertical centre, then left to right.

    Sorting on round(y) split one printed line whenever two words' tops sat
    either side of a rounding boundary (0.7pt of baseline jitter between a
    digit and a letter is enough), which reordered a box's string. Rows are
    clustered with a 2pt tolerance instead.
    """
    ws = sorted(ws, key=lambda w: (w[1] + w[3]) / 2)
    rows, cur, last = [], [], None
    for w in ws:
        c = (w[1] + w[3]) / 2
        if last is not None and abs(c - last) > tol:
            rows.append(cur)
            cur = []
        cur.append(w)
        last = c
    if cur:
        rows.append(cur)
    return [sorted(r, key=lambda w: w[0]) for r in rows]


def drawn_marks(drawings):
    """Midpoints of diagonal strokes — a check mark DRAWN rather than typed.

    The filer's software ticks a box with a glyph ("8" in ZapfDingbats), which
    text extraction sees. The NY fill-in forms (and any form whose on-state
    appearance is vector art) draw an X as two crossing lines, which it does
    not: every box we ticked read as empty. Box borders are axis-aligned, so
    only strokes moving in both x and y count.
    """
    marks = []
    for d in drawings or []:
        for it in d.get('items', []):
            if it[0] == 'l':
                p1, p2 = it[1], it[2]
                if abs(p1.x - p2.x) > 0.8 and abs(p1.y - p2.y) > 0.8:
                    marks.append(((p1.x + p2.x) / 2, (p1.y + p2.y) / 2))
            elif it[0] == 'c':
                p1, p4 = it[1], it[4]
                if abs(p1.x - p4.x) > 0.8 and abs(p1.y - p4.y) > 0.8:
                    marks.append(((p1.x + p4.x) / 2, (p1.y + p4.y) / 2))
    return marks


def filled_values(page_words, blank, drawings=None):
    """Subtract template words, assign the rest to the blank's widgets."""
    tmpl = defaultdict(list)
    for w in blank.words:
        tmpl[w[4]].append(w)

    def is_template(w):
        for t in tmpl.get(w[4], ()):
            if abs(t[0] - w[0]) < 2 and abs(t[1] - w[1]) < 2:
                return True
        return False

    extra = [w for w in page_words if not is_template(w)]
    per_widget = defaultdict(list)
    loose = []
    for w in extra:
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        hit = None
        for wd in blank.widgets:
            x0, y0, x1, y1 = wd['rect']
            if x0 - 2 <= cx <= x1 + 2 and y0 - 1.5 <= cy <= y1 + 1.5:
                # smallest containing box wins (checkbox inside a row box, etc.)
                if hit is None or (x1 - x0) * (y1 - y0) < (hit['rect'][2] - hit['rect'][0]) * (hit['rect'][3] - hit['rect'][1]):
                    hit = wd
        if hit:
            per_widget[hit['name']].append(w)
        else:
            loose.append(w)
    vals = {}
    types = {wd['name']: wd['type'] for wd in blank.widgets}
    for name, ws in per_widget.items():
        raw = ' '.join(w[4] for row in reading_order(ws) for w in row)
        vals[name] = (raw, norm_value(raw, types.get(name) == 'CheckBox'))
    marks = drawn_marks(drawings)
    if marks:
        for wd in blank.widgets:
            if wd['type'] not in ('CheckBox', 'RadioButton') or vals.get(wd['name'], ('', ''))[1]:
                continue
            x0, y0, x1, y1 = wd['rect']
            if any(x0 - 1 <= mx <= x1 + 1 and y0 - 1 <= my <= y1 + 1 for mx, my in marks):
                vals[wd['name']] = ('X', 'X')
    loose_text = ' '.join(w[4] for row in reading_order(loose) for w in row)
    return vals, loose_text


ROW_AMT = re.compile(r'^(.*?)[\s.]*\(?-?\$?\s*([\d]{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?\s*$')


def statement_rows(page):
    """(description, amount) rows of a statement page.

    Built from words grouped by row, not get_text('text') lines: software
    statements draw each table cell as its own text object, so the text
    extractor emits a description and its amount as separate lines and
    only a few rows ever parsed.
    """
    rows = []
    for row in reading_order(page.get_text('words')):
        line = ' '.join(w[4] for w in row)
        m = ROW_AMT.match(line)
        if m and len(m.group(1)) > 2:
            # A header line ending in an SSN/EIN — spaced digit by digit, or
            # dashed — parses as "description, amount" with the identifier's
            # tail as the amount. Never emit a row whose amount came from an
            # identifier-shaped run.
            tail = line[max(0, len(m.group(1)) - 14):]
            amt_text = line[len(m.group(1)):].strip()
            if is_identifier(tail) or len(re.sub(r'\D', '', amt_text)) >= 9:
                continue
            amt = norm_value(amt_text, False)
            rows.append((m.group(1).strip().lower()[:60], amt))
    return rows


LINE_LABEL = re.compile(r'^(\d{1,2}[a-z]?\.|\d{1,2}[a-z]|[A-L]\.|G-\d\.|\(?[a-e]\)\.?)$')


def flat_tokens(page_words, blank):
    """Filled-in values on a page of a FLAT form, in reading order.

    A flat form has no boxes, and the filer's software may not even use the
    official layout: the 2025 FL F-1120 was filed on a vendor's substitute
    form whose line order, page breaks and coordinates all differ from the
    Department's form we print on. So nothing positional can be compared.
    What can: every value the filer entered must appear in ours.

    A word is template when it sits where the blank prints the same word
    (our pages), or — for a substitute layout — when it is wording or a
    multi-character figure the blank prints anywhere ("01/26", "50,000"), or
    a line label. Digits the hand-print boxes split one per cell are joined
    back into one value; zeros and bare cents carry no information and are
    dropped (the same reason ZERO/BLANK never fails a box).
    """
    tmpl = defaultdict(list)
    for w in blank.words:
        tmpl[w[4]].append(w)

    def positional(w):
        return any(abs(t[0] - w[0]) < 2 and abs(t[1] - w[1]) < 2 for t in tmpl.get(w[4], ()))

    def nt(t):
        return re.sub(r'[^0-9a-z]', '', t.lower())

    wording = {nt(t) for t in blank.form_text if re.search(r'[A-Za-z]', t)}
    keep = []
    for w in page_words:
        t = w[4]
        n = nt(t)
        if t == '-' and not positional(w):
            keep.append(w)  # a minus drawn in its own box, joined to the digits below
            continue
        if positional(w) or not n or LINE_LABEL.match(t) or re.fullmatch(r'(?i)line\d+\)?\.?', t):
            continue
        # wording, compared without punctuation or underscore leaders ("negative______")
        if re.search(r'[a-z]', n) and n in wording:
            continue
        # a figure the blank prints ("01/26", "2026"); short digits wait for joining
        if not re.search(r'[A-Za-z]', t) and len(t) > 2 and t in blank.form_text:
            continue
        # label fragments ("1,", "2)", "(3", "14......") and lone letters (box
        # glyphs drawn as "o" or "q", arrows) — a tick is the only one-letter entry
        if re.fullmatch(r'\(?\d{1,2}(?:[),;:]+|\.{2,}.*)', t) or re.fullmatch(r'\(\d{1,2}', t):
            continue
        if len(t) == 1 and t.isalpha() and t not in ('X', 'x'):
            continue
        keep.append(w)
    rows = []
    for row in reading_order(keep):
        # A machine scan line (the filer's OCR/barcode data row) is digits only,
        # in long groups, with no wording: not a value anyone entered.
        nums = [w for w in row if re.fullmatch(r'[\d.\-]+', w[4])]
        if len(row) >= 5 and len(nums) == len(row) and sum(len(w[4]) >= 3 for w in row) >= 4:
            continue
        # Mixed-case words the official blank does not print are a substitute
        # form's own wording ("Administrative", a misspelt "Begining") unless
        # they sit with an entry (a city beside its ZIP code).
        entries = [w for w in row if re.search(r'\d', w[4]) or (w[4].isupper() and len(w[4]) > 1) or '@' in w[4]]

        def anchored(w):
            return any(e is not w and min(abs(e[0] - w[2]), abs(w[0] - e[2])) < 80 for e in entries)
        rows.extend(w for w in row if not re.fullmatch(r'[A-Za-z]*[a-z][A-Za-z]*', w[4]) or anchored(w))
    keep = rows
    kept_ids = {id(w) for w in keep}
    dropped = [w for w in page_words if id(w) not in kept_ids]

    def between(a, b):
        # A template word between two digits means they are not one boxed
        # number ("Page 1 of 6" is not 16). Printed thousands commas and date
        # slashes between digit boxes do not split a number; the decimal point
        # does (dollars and cents are separate values on both sides).
        return any(abs((d[1] + d[3]) / 2 - (b[1] + b[3]) / 2) < 2.5 and a[2] - 1 <= d[0] and d[2] <= b[0] + 1
                   and (re.search(r'[0-9A-Za-z]', d[4]) or d[4] == '.')
                   for d in dropped)

    merged = []
    for w in keep:
        if merged:
            p = merged[-1]
            short = lambda s: re.fullmatch(r'-?\d{1,2}', s)
            if (abs(p[3] - w[3]) < 2.5 and -1 <= w[0] - p[2] < 14 and short(w[4])
                    and re.fullmatch(r'-?\d*', p[4]) and (short(p[4]) or p[4] == '-' or p[5]) and not between(p, w)):
                merged[-1] = (p[0], p[1], w[2], w[3], p[4] + w[4], True)
                continue
        merged.append((w[0], w[1], w[2], w[3], w[4], False))
    out = []
    for m in merged:
        if m[4] == '-':
            continue
        n = norm_value(m[4], False)
        if n in ('0', '', '00') or re.fullmatch(r'0+', n):
            continue
        # an unjoined one- or two-digit number the blank also prints is a line
        # reference in label text ("Lines 1, 2, and 3"), not an entry
        if not m[5] and re.fullmatch(r'\d{1,2}', m[4]) and m[4] in {nt(t) for t in blank.form_text}:
            continue
        # identifiers compare on digits only (a PTIN's "P" may print apart)
        if is_identifier(m[4]):
            n = re.sub(r'\D', '', m[4])
        out.append((m[4], n))
    return out


def page_title(page):
    t = ' '.join(page.get_text('text').split())
    return mask(t[:90])


def page_words(page):
    """get_text('words') plus check marks typed in a Dingbats font.

    pdf-lib ticks a box by drawing a ZapfDingbats glyph with no Unicode
    mapping; it extracts as a control character (\\x14) that 'words' drops,
    so every box we ticked read as empty. Any such Dingbats glyph counts as
    an "X" at its position.
    """
    words = list(page.get_text('words'))
    for b in page.get_text('rawdict')['blocks']:
        for ln in b.get('lines', []):
            for sp in ln['spans']:
                if 'dingbat' not in sp['font'].lower():
                    continue
                for c in sp['chars']:
                    if c['c'] and (ord(c['c'][0]) < 32 or not c['c'].strip()):
                        x0, y0, x1, y1 = c['bbox']
                        words.append((x0, y0, x1, y1, 'X', 0, 0, 0))
    return words


def analyse(path, blanks, bake):
    doc = fitz.open(path)
    if bake:
        try:
            doc.bake(annots=True, widgets=True)
        except Exception:
            pass
    out = []
    for i, p in enumerate(doc):
        words = page_words(p)
        blank, score = classify(words, blanks)
        if blank and blank.flat:
            out.append({'page': i + 1, 'key': blank.key, 'flat': blank.form, 'blank': blank,
                        'tokens': flat_tokens(words, blank), 'score': round(score, 2)})
        elif blank:
            vals, loose = filled_values(words, blank, p.get_drawings())
            out.append({'page': i + 1, 'key': blank.key, 'blank': blank, 'vals': vals, 'loose': loose, 'score': round(score, 2)})
        else:
            out.append({'page': i + 1, 'key': None, 'title': page_title(p), 'rows': statement_rows(p), 'score': round(score, 2)})
    return out


def is_identifier(s):
    return any(r.search(s) for r in ID_PATTERNS)


# Boxes that hold an identifier whatever the value looks like: a 6-digit IP PIN
# or a date of birth matches no ID_PATTERNS shape, and a spouse's IP PIN once
# printed in a parity report. Matched on the field name or the printed label;
# the IT-2 W-2 boxes a/b (employee SSN, employer EIN) carry neither.
ID_BOX = re.compile(r'(?i)(\bssn\b|social security|identity protection pin|\bip pin\b|\bpin\b|\bf?ein\b|'
                    r'employer identification|taxpayer identification|routing|account number|\bdob\b|'
                    r'date of birth|\bptin\b|preparersssno)')


def identity_box(name, label):
    short = name.split('.')[-1] if not re.search(r'\.\d$', name) else name
    return bool(ID_BOX.search(name) or ID_BOX.search(label or '') or re.fullmatch(r'(?:2[_ ])?Box_[ab](?:#\d+)?', short))


def same_identifier(a, b):
    """An SSN/EIN printed digit-by-digit in comb cells and the same number
    printed dashed are one identifier: compare digits only (still shown as [ID])."""
    if not (is_identifier(a) or is_identifier(b)):
        return False
    da, db = re.sub(r'\D', '', a), re.sub(r'\D', '', b)
    return bool(da) and da == db


def compare_flat(filed, api):
    """Flat forms: every distinct value the filer entered must appear in ours (see flat_tokens)."""
    out = []
    for form in sorted({pg['flat'] for pg in filed if pg.get('flat')}):
        f_pages = [pg for pg in filed if pg.get('flat') == form]
        a_pages = [pg for pg in api if pg.get('flat') == form]
        f_vals, a_vals = {}, {}
        for pg in f_pages:
            for raw, n in pg['tokens']:
                f_vals.setdefault(n, raw)
        for pg in a_pages:
            for raw, n in pg['tokens']:
                a_vals.setdefault(n, raw)
        items = []
        for n, raw in f_vals.items():
            status = 'FORM NOT GENERATED' if not a_pages else ('MATCH' if n in a_vals else 'MISSING')
            items.append({'value': '[ID]' if is_identifier(raw) else mask(raw), 'status': status})
        for n, raw in a_vals.items():
            if n not in f_vals:
                items.append({'value': '[ID]' if is_identifier(raw) else mask(raw), 'status': 'EXTRA'})
        out.append({'form': form, 'filed_pages': [pg['page'] for pg in f_pages],
                    'api_pages': [pg['page'] for pg in a_pages], 'items': items})
    return out


def compare(filed, api):
    by_key_api = defaultdict(list)
    for pg in api:
        if pg['key'] and not pg.get('flat'):
            by_key_api[pg['key']].append(pg)
    used = defaultdict(int)
    results = []
    for pg in filed:
        if not pg['key'] or pg.get('flat'):
            continue
        k = pg['key']
        idx = used[k]
        used[k] += 1
        twin = by_key_api[k][idx] if idx < len(by_key_api[k]) else None
        blank = pg['blank']
        res = {'filed_page': pg['page'], 'api_page': twin['page'] if twin else None, 'key': k, 'items': []}
        names = list(pg['vals'].keys()) + ([n for n in twin['vals'] if n not in pg['vals']] if twin else [])
        order = {wd['name']: j for j, wd in enumerate(blank.widgets)}
        for name in sorted(set(names), key=lambda n: order.get(n, 9999)):
            f_raw, f_norm = pg['vals'].get(name, ('', ''))
            a_raw, a_norm = twin['vals'].get(name, ('', '')) if twin else ('', '')
            if not f_norm and not a_norm:
                continue
            id_box = identity_box(name, blank.context.get(name, ''))
            if not twin:
                status = 'FORM NOT GENERATED'
            elif f_norm == a_norm or same_identifier(f_raw, a_raw) or (
                    id_box and re.sub(r'\D', '', f_raw) == re.sub(r'\D', '', a_raw) and re.sub(r'\D', '', f_raw)):
                status = 'MATCH'
            elif {f_norm, a_norm} <= {'0', ''}:
                status = 'ZERO/BLANK'
            elif not a_norm:
                status = 'MISSING'
            elif not f_norm:
                status = 'EXTRA'
            else:
                status = 'DIFF'
            ident = id_box or is_identifier(f_raw) or is_identifier(a_raw)
            res['items'].append({
                'field': name.split('.')[-1], 'label': mask(blank.labels.get(name, '')),
                'filed': '[ID]' if ident and f_raw else mask(f_raw),
                'api': '[ID]' if ident and a_raw else mask(a_raw),
                'status': ('MATCH' if status == 'MATCH' else status) + (' (identifier)' if ident and status != 'MATCH' else ''),
            })
        if twin is None:
            res['note'] = 'no page of this form in the generated package'
        results.append(res)
    extra_api = [pg for pg in api if pg['key'] and not pg.get('flat') and used[pg['key']] <= by_key_api[pg['key']].index(pg)]
    # statements / unrecognised pages
    f_rows = [r for pg in filed if not pg['key'] for r in pg['rows']]
    a_rows = [r for pg in api if not pg['key'] for r in pg['rows']]
    a_pool = defaultdict(int)
    for _, amt in a_rows:
        a_pool[amt] += 1
    stmt = []
    for desc, amt in f_rows:
        if a_pool[amt] > 0:
            a_pool[amt] -= 1
            stmt.append({'desc': mask(desc), 'amount': mask(amt), 'status': 'MATCH'})
        else:
            stmt.append({'desc': mask(desc), 'amount': mask(amt), 'status': 'MISSING'})
    unclassified = [{'page': pg['page'], 'title': pg['title']} for pg in filed if not pg['key']]
    return results, extra_api, stmt, unclassified


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--filed', required=True)
    ap.add_argument('--api', required=True)
    ap.add_argument('--blanks', action='append', default=None)
    ap.add_argument('--year', default='2025')
    ap.add_argument('--json')
    ap.add_argument('--report')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--ignore-pages', default='',
                    help='filed pages to leave out of the test, e.g. "10,16-26" (software worksheets, not IRS forms)')
    a = ap.parse_args()
    here = os.path.join(os.path.dirname(__file__), '..', '..', 'data')
    blank_dirs = a.blanks or [os.path.join(here, 'irs_forms'), os.path.join(here, 'state_forms')]
    blanks = load_blanks(blank_dirs, a.year)
    filed = analyse(a.filed, blanks, bake=True)
    ignore = set()
    for part in filter(None, a.ignore_pages.split(',')):
        lo, _, hi = part.partition('-')
        ignore.update(range(int(lo), int(hi or lo) + 1))
    filed = [pg for pg in filed if pg['page'] not in ignore]
    api = analyse(a.api, blanks, bake=True)
    results, extra_api, stmt, unclassified = compare(filed, api)
    flat = compare_flat(filed, api)

    counts = defaultdict(int)
    for r in results:
        for it in r['items']:
            counts[it['status'].split(' (')[0]] += 1
    s_counts = defaultdict(int)
    for s in stmt:
        s_counts[s['status']] += 1
    total_filed = sum(1 for r in results for it in r['items'] if it['filed'] and it['status'] != 'ZERO/BLANK')
    matched = counts['MATCH']

    lines = [f'# Parity: {os.path.basename(a.filed)} vs {os.path.basename(a.api)}', '']
    lines.append(f'Form boxes: {matched}/{total_filed} filed values matched; ' +
                 ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
    lines.append(f'Statement rows: ' + ', '.join(f'{k} {v}' for k, v in sorted(s_counts.items())))
    lines.append(f'Filed pages with no IRS blank on file: ' + (', '.join(str(u["page"]) for u in unclassified) or 'none'))
    lines.append(f'Generated pages with no filed counterpart: ' + (', '.join(f'{p["page"]}:{p["key"]}' for p in extra_api) or 'none'))
    for fl in flat:
        fc = defaultdict(int)
        for it in fl['items']:
            fc[it['status']] += 1
        lines.append(f'Flat form {fl["form"]} (compared by value): ' + ', '.join(f'{k} {v}' for k, v in sorted(fc.items())))
    lines.append('')
    for r in results:
        bad = [it for it in r['items'] if it['status'] not in ('MATCH', 'ZERO/BLANK')]
        lines.append(f'## {r["key"]} (filed p{r["filed_page"]}, ours p{r["api_page"]}) — {len(r["items"]) - len(bad)}/{len(r["items"])} match' + (f' — {r["note"]}' if r.get('note') else ''))
        if bad:
            lines.append('| Box | Line | Filed | Ours | Status |')
            lines.append('|---|---|---|---|---|')
            for it in bad:
                lines.append(f'| {it["field"]} | {it["label"][-45:]} | {it["filed"][:40]} | {it["api"][:40]} | {it["status"]} |')
        lines.append('')
    for fl in flat:
        bad = [it for it in fl['items'] if it['status'] != 'MATCH']
        lines.append(f'## {fl["form"]} — flat form, compared by value (filed pages {fl["filed_pages"]}, ours {fl["api_pages"]}) — '
                     f'{len([it for it in fl["items"] if it["status"] == "MATCH"])}/{len([it for it in fl["items"] if it["status"] != "EXTRA"])} filed values found')
        for it in bad:
            lines.append(f'- {it["status"]}: {it["value"][:60]}')
        lines.append('')
    if unclassified:
        lines.append('## Filed pages with no IRS blank on file')
        for u in unclassified:
            lines.append(f'- p{u["page"]}: {u["title"]}')
        lines.append('')
    miss = [s for s in stmt if s['status'] != 'MATCH']
    if miss:
        lines.append('## Statement rows not found in the generated package')
        for s in miss:
            lines.append(f'- {s["desc"]} — {s["amount"]}')
    report = '\n'.join(lines)
    if a.report:
        open(a.report, 'w').write(report)
    if a.json:
        json.dump({'counts': counts, 'statement_counts': s_counts, 'results': results,
                   'statements': stmt, 'unclassified': unclassified, 'flat': flat,
                   'extra_api': [{'page': p['page'], 'key': p['key']} for p in extra_api]},
                  open(a.json, 'w'), indent=1, default=str)
    if not a.quiet:
        print('\n'.join(lines[:6]))
    flat_missing = any(it['status'] in ('MISSING', 'FORM NOT GENERATED') for fl in flat for it in fl['items'])
    ok = matched == total_filed and not miss and not unclassified and not flat_missing
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
