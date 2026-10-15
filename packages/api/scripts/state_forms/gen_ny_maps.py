"""
gen_ny_maps.py — generate src/builders/forms/state_ny_maps_2025.ts from the NY fill-in blanks.

Why generated: the NY fill-in PDFs (IT-203, IT-203-B, IT-2) carry ~450 fields,
and their field NAMES are not reliable line labels — "53d dollars" is printed
line 52d, "2m2" is 2n, "2n dollars" is 2o. Keying stored data by those names
would bake the form designer's typos into our data model. So each field's key
comes from the line number PRINTED beside its box on the 2025 blank (the same
template-text reading scripts/parity/pdf_parity.py uses), with a hand-written
table for the boxes that have no line number (header, checkboxes, signature
block). Rerun for a new year's blanks and diff the output; never hand-edit the
generated file.

  python3 scripts/state_forms/gen_ny_maps.py > src/builders/forms/state_ny_maps_2025.ts
"""
import re
import sys

import pymupdf as fitz

YEAR = 2025
LINE_TOKEN = re.compile(r'^(\d{1,2}[a-z]?)$')

# Boxes without a printed line number: field name -> key. Choice groups (one
# field name, several widgets with different export values) map to one key.
MANUAL = {
    'it203': {
        'beginning date': 'fiscal_begin', 'ending date': 'fiscal_end',
        'Your first name': 'first_name', 'Your last name': 'last_name', 'Your DOB': 'dob', 'Your SSN': 'ssn',
        "Spouse's first name": 'spouse_first_name', "Spouse's last name": 'spouse_last_name',
        'Spouse DOB': 'spouse_dob', "Spouse's SSN": 'spouse_ssn',
        'Mailing address': 'mailing_address', 'Apartment number 1': 'apartment', 'NY State county of residence': 'county',
        'City, village or post office 1': 'city', 'State 1': 'state', 'ZIP code 1': 'zip', 'Country': 'country',
        'nys school district name': 'school_district_name',
        'permanent home address': 'home_address', 'apartment number 2': 'home_apartment',
        'city, village or post office 2': 'home_city', 'school district code number': 'school_district_code',
        'State 2': 'home_state', 'zip code 2': 'home_zip', 'Country 2': 'home_country',
        'if taxpayer is deceased': 'taxpayer_date_of_death', 'date of death': 'spouse_date_of_death',
        'Filing Status': 'filing_status', 'BoxB': 'B_itemized', 'BoxC': 'C_dependent', 'BoxD1': 'D1_foreign_account',
        'BoxD2': 'D2_1_yonkers_quarters', 'D2_amount': 'D2_2_months', 'D2_amount_spouse': 'D2_3_months_spouse',
        'BoxD4': 'D2_4_yonkers_work', 'E2.0': 'E1_nyc_months', 'E2.1': 'E2_nyc_months_spouse',
        'F1': 'F_special_condition_1', 'F2': 'F_special_condition_2', 'G date': 'G_move_date',
        'lived in': 'G_last_day', 'In NYC': 'H_ny_living_quarters', 'more than 9': 'I_more_than_6_dependents',
        'line 9 box': 'L9_beneficiary', 'line 10 box': 'L10_beneficiary',
        '16 identify': 'L16_identify', '18 identify': 'L18_identify',
        'Name as shown on page 1': 'name', 'deduction': 'L33_deduction_type', 'EIC': 'L43_eic_code',
        'percent': 'L45_percent', '45nys dollars': 'L45_ny', '45 federal dollars': 'L45_federal', '45 dollars': 'L45',
        'line 68': 'L68_refund_choice', 'line 70': 'L70_efw', 'Foreign accounts': 'L73_foreign_account',
        'line 73a': 'L73a_account_type', 'routing number': 'L73b_routing', 'account number': 'L73c_account',
        'electronic funds withdrawal': 'L74_date', 'line 74': 'L74_amount',
        '3rd Party Discuss': 'designee', 'designee name': 'designee_name', 'designee phone number': 'designee_phone_area',
        'designees phone number': 'designee_phone', 'email1': 'designee_email', 'designee pin': 'designee_pin',
        'NYTPRIN': 'preparer_nytprin', 'NYTPRIN excl code': 'preparer_nytprin_excl_code',
        "preparer's printed name": 'preparer_name', 'preparersssno': 'preparer_ptin', 'firmsname': 'preparer_firm',
        'address': 'preparer_address', 'City': 'preparer_city', 'email2': 'preparer_email',
        'employidnumber': 'preparer_ein', 'date': 'preparer_date', 'Occupation': 'occupation',
        'Occupation - Spouse': 'spouse_occupation', 'date2': 'sign_date', 'day phone area code': 'phone_area',
        'daytimephoneno': 'phone', 'email3': 'email',
    },
    'it203b': {
        'name(s)': 'name', 'occupation': 'occupation', 'your ssn': 'ssn',
        'quarters maintained': 'B_quarters_maintained', 'days': 'B_days_in_ny',
        'Check line 1': 'C1_claimed_elsewhere', 'Line2_amount': 'C2',
    },
    'it2': {},
}
# Repeating rows: field-name regex -> (array key, field key). Index is group 1.
ROWS = {
    'it203': [
        (r'^first and middle I\.(\d)$', 'dependents', 'first_name'),
        (r'^last name chart\.(\d)$', 'dependents', 'last_name'),
        (r'^relationship\.(\d)$', 'dependents', 'relationship'),
        (r'^dependent ssn\.(\d)$', 'dependents', 'ssn'),
        (r'^dependent dob\.(\d)$', 'dependents', 'dob'),
    ],
    'it203b': [
        (r'^Col A(\d) - address$', 'residences', 'address'),
        (r'^Col B(\d) - City$', 'residences', 'city'),
        (r'^ZIP(\d)$', 'residences', 'zip'),
        (r'^Col E(\d) - box(?:\.0)?$', 'residences', 'still_maintained'),
        (r'^S(\d)_first_name$', 'students', 'first_name'), (r'^S(\d)_MI$', 'students', 'mi'),
        (r'^S(\d)_last_name$', 'students', 'last_name'), (r'^S(\d)_suffix$', 'students', 'suffix'),
        (r'^S(\d)_SSN$', 'students', 'ssn'), (r'^S(\d)_DOB$', 'students', 'dob'),
        (r'^S(\d)_dependent$', 'students', 'dependent'), (r'^S(\d)_EIN$', 'students', 'ein'),
        (r'^S(\d)_Uni name$', 'students', 'institution'), (r'^S(\d)_undergrad$', 'students', 'undergrad'),
        (r'^S(\d)_expenses$', 'students', 'expenses'), (r'^S(\d)_lesser$', 'students', 'lesser'),
    ],
    # IT-2 holds two W-2s per page: slot 0 unprefixed, slot 1 prefixed "2_" or "2 ".
    'it2': [
        (r'^(?:(2)[_ ])?Box_(\w+)$', 'w2', None),
        (r'^(?:(2)[_ ])?(1[24][a-d]_(?:code|description))$', 'w2', None),
        (r'^(?:(2)[_ ])?(Corrected_box)$', 'w2', None),
    ],
}
CHECK_TYPES = ('CheckBox', 'RadioButton')


def left_label(words, rect):
    cy = (rect.y0 + rect.y1) / 2
    row = [w for w in words if w[1] - 2 <= cy <= w[3] + 2 and w[2] <= rect.x0 + 1]
    row.sort(key=lambda w: w[0])
    toks = [w[4].strip('.') for w in row if not re.fullmatch(r'[.\s]+', w[4])]
    return [t for t in toks if t]


def entries_for(form):
    doc = fitz.open(f'data/state_forms/{form}_{YEAR}.pdf')
    out = {}      # key -> entry
    rows = {}     # array key -> {field key -> {index: field name}}
    for pno, page in enumerate(doc):
        words = page.get_text('words')
        for w in page.widgets() or []:
            name, kind = w.field_name, ('check' if w.field_type_string in CHECK_TYPES else 'text')
            on = None
            if kind == 'check':
                on = [s for s in (w.button_states() or {}).get('normal', []) if s != 'Off']
                on = on[0] if on else 'Yes'
            matched = False
            for rx, arr, fkey in ROWS.get(form, []):
                m = re.match(rx, name)
                if m:
                    if form == 'it2':
                        idx = 1 if m.group(1) else 0
                        fkey = 'corrected' if m.group(2) == 'Corrected_box' else 'box_' + m.group(2).lower()
                    else:
                        idx = int(m.group(1)) - (0 if form == 'it203' else 1)
                    rows.setdefault(arr, {}).setdefault(fkey, {'kind': kind, 'on': on, 'fields': {}})['fields'][idx] = name
                    matched = True
                    break
            if matched:
                continue
            key = MANUAL[form].get(name)
            if key is None:
                toks = left_label(words, w.rect)
                line = next((t for t in reversed(toks) if LINE_TOKEN.match(t)), None)
                if line is None:
                    raise SystemExit(f'{form} p{pno + 1}: no key for field {name!r} — add it to MANUAL')
                key = 'L' + line
                if form == 'it203' and pno == 1 and line not in ('32',) and line != '12':
                    key += '_federal' if w.rect.x0 < 430 else '_ny'
                if form == 'it203' and pno == 1 and line == '12':
                    key = 'L12_federal'
            e = out.setdefault(key, {'field': name, 'kind': kind, 'page': pno + 1, 'options': {}})
            if e['field'] != name:
                raise SystemExit(f'{form}: key {key} maps to two fields: {e["field"]!r} and {name!r}')
            if kind == 'check':
                e['options'][on] = on
    return out, rows


def ts_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def main():
    print('/**')
    print(' * NY fill-in field maps, tax year 2025 — GENERATED by scripts/state_forms/gen_ny_maps.py.')
    print(' * Do not hand-edit: rerun the generator against the year\'s blanks and diff.')
    print(' * Keys are the line numbers printed beside each box (see the generator for why');
    print(' * the field names themselves cannot be trusted). Check boxes list their export');
    print(' * value(s); a key with several options is a one-of choice.')
    print(' */')
    print("import type { NyFieldMap } from './state_ny.js'")
    print()
    for form in ('it203', 'it203b', 'it2'):
        out, rows = entries_for(form)
        print(f'export const NY_{form.upper()}_2025: NyFieldMap = {{')
        print('  fields: {')
        for key in sorted(out, key=lambda k: (out[k]['page'], k)):
            e = out[key]
            opts = ', options: [' + ', '.join(ts_str(o) for o in e['options']) + ']' if e['kind'] == 'check' else ''
            print(f"    {ts_str(key)}: {{ field: {ts_str(e['field'])}, kind: '{e['kind']}', page: {e['page']}{opts} }},")
        print('  },')
        print('  rows: {')
        for arr, cols in rows.items():
            print(f'    {arr}: {{')
            for fkey, spec in cols.items():
                fields = ', '.join(ts_str(spec['fields'][i]) for i in sorted(spec['fields']))
                opt = f", on: {ts_str(spec['on'])}" if spec['kind'] == 'check' else ''
                print(f"      {ts_str(fkey)}: {{ kind: '{spec['kind']}'{opt}, fields: [{fields}] }},")
            print('    },')
        print('  },')
        print('}')
        print()


if __name__ == '__main__':
    sys.exit(main())
