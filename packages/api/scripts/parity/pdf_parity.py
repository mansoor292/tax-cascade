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
        for wd in self.widgets:
            self.labels[wd['name']] = self._label_for(wd['rect'])

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
            for i, p in enumerate(doc):
                bp = BlankPage(form, i, p)
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
        if not b.widgets:
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
        ws.sort(key=lambda w: (round(w[1]), w[0]))
        raw = ' '.join(w[4] for w in ws)
        vals[name] = (raw, norm_value(raw, types.get(name) == 'CheckBox'))
    marks = drawn_marks(drawings)
    if marks:
        for wd in blank.widgets:
            if wd['type'] not in ('CheckBox', 'RadioButton') or vals.get(wd['name'], ('', ''))[1]:
                continue
            x0, y0, x1, y1 = wd['rect']
            if any(x0 - 1 <= mx <= x1 + 1 and y0 - 1 <= my <= y1 + 1 for mx, my in marks):
                vals[wd['name']] = ('X', 'X')
    loose_text = ' '.join(w[4] for w in sorted(loose, key=lambda w: (round(w[1]), w[0])))
    return vals, loose_text


ROW_AMT = re.compile(r'^(.*?)[\s.]*\(?-?\$?\s*([\d]{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?\s*$')


def statement_rows(page):
    rows = []
    for line in page.get_text('text').splitlines():
        line = ' '.join(line.split())
        m = ROW_AMT.match(line)
        if m and len(m.group(1)) > 2:
            amt = norm_value(line[len(m.group(1)):].strip(), False)
            rows.append((m.group(1).strip().lower()[:60], amt))
    return rows


def page_title(page):
    t = ' '.join(page.get_text('text').split())
    return mask(t[:90])


def analyse(path, blanks, bake):
    doc = fitz.open(path)
    if bake:
        try:
            doc.bake(annots=True, widgets=True)
        except Exception:
            pass
    out = []
    for i, p in enumerate(doc):
        words = p.get_text('words')
        blank, score = classify(words, blanks)
        if blank:
            vals, loose = filled_values(words, blank, p.get_drawings())
            out.append({'page': i + 1, 'key': blank.key, 'blank': blank, 'vals': vals, 'loose': loose, 'score': round(score, 2)})
        else:
            out.append({'page': i + 1, 'key': None, 'title': page_title(p), 'rows': statement_rows(p), 'score': round(score, 2)})
    return out


def is_identifier(s):
    return any(r.search(s) for r in ID_PATTERNS)


def compare(filed, api):
    by_key_api = defaultdict(list)
    for pg in api:
        if pg['key']:
            by_key_api[pg['key']].append(pg)
    used = defaultdict(int)
    results = []
    for pg in filed:
        if not pg['key']:
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
            if not twin:
                status = 'FORM NOT GENERATED'
            elif f_norm == a_norm:
                status = 'MATCH'
            elif {f_norm, a_norm} <= {'0', ''}:
                status = 'ZERO/BLANK'
            elif not a_norm:
                status = 'MISSING'
            elif not f_norm:
                status = 'EXTRA'
            else:
                status = 'DIFF'
            ident = is_identifier(f_raw) or is_identifier(a_raw)
            res['items'].append({
                'field': name.split('.')[-1], 'label': mask(blank.labels.get(name, '')),
                'filed': '[ID]' if ident and f_raw else mask(f_raw),
                'api': '[ID]' if ident and a_raw else mask(a_raw),
                'status': ('MATCH' if status == 'MATCH' else status) + (' (identifier)' if ident and status != 'MATCH' else ''),
            })
        if twin is None:
            res['note'] = 'no page of this form in the generated package'
        results.append(res)
    extra_api = [pg for pg in api if pg['key'] and used[pg['key']] <= by_key_api[pg['key']].index(pg)]
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
                   'statements': stmt, 'unclassified': unclassified,
                   'extra_api': [{'page': p['page'], 'key': p['key']} for p in extra_api]},
                  open(a.json, 'w'), indent=1, default=str)
    if not a.quiet:
        print('\n'.join(lines[:6]))
    ok = matched == total_filed and not miss and not unclassified
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
