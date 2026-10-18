# Return catalog, fact registry and review framework

Written 2026-10-17, after six months of the same failure. Each conversation
about the Edgewater returns turned up a new deduction, loss or error: the 2023/2024
NIIT charged on nonpassive S-corp income, distributions above stock basis that were
never reported, a 2021 suspended loss, a misread loan. Every one of them was sitting
in documents already on file. They surfaced only when someone happened to ask a nearby
question, because:

1. **No return was ever fully read.** The filed-import path keeps 10–40% of a
   return. Checkboxes, Schedule E's passive/nonpassive columns, K-1 Part II, M-2 and
   every statement are dropped. So every question went back to the PDF, and a
   different slice of it was read each time.
2. **Facts had no shape.** Ownership, lenders, material participation, election dates
   and IRS events lived in free-text notes, in "fact" documents, or in nobody's notes
   at all. Nothing said which facts a return of a given type needs, so a missing fact
   stayed invisible until it mattered.
3. **Nothing checked the return as a whole, across years, or across entities.** The
   checks that exist are scattered arithmetic ties. Basis, NIIT, loans, the S
   election history, K-1 to 1040 ties, prior-year close vs current-year open, and
   carryovers had no check at all.

## Requirements (set by the owner, not negotiable)

- **R1. Every return is fully catalogued.** Every box, checkbox, statement row and
  worksheet line of every page is stored as structured data, and every question is
  answered from the catalog. Nobody goes back to the PDF. If the catalog can't answer
  a question, that is a catalog defect to fix, never a reason to open the PDF.
- **R2. One information standard per return type.** The facts a return needs are
  defined once per return type. Every return of that type, every year, is held to
  the same list. Something learned for one return becomes a required question for all
  of them.
- **R3. A systematic review.** Each return type is put through a fixed framework of
  checks: corporate actions, NIIT, basis, loans, carryovers, intercompany, IRS account
  and the rest. Code runs the arithmetic checks and AI runs the judgement checks. The
  results are stored, so a later run reports what changed and why.

## Components

### 1. Line dictionaries (from the IRS's own forms)

Every IRS fillable PDF is an XFA hybrid, and each field carries an accessibility
description, for example: `Row: 19. Loans from shareholders. Column: End of tax year.
(d).` and `J. (2). Grouped activities for section 469 passive activity purposes.`
`scripts/catalog/build_line_dicts.ts` reads each blank's XFA template and AcroForm
widgets and writes `data/line_dicts/<form>_<rev>.json`, mapping each widget to:
page, rectangle, kind (amount, text, check, date), line id, row, column, official
label, section, and the canonical `field_values` key where one exists.

This needs no hand-made maps and no guessing. Blanks are fetched for every
(form, revision) that appears in a filed return, including old revisions still in
use: 1125-A (2018), 1125-E (2016), Schedule G (2011), 7203 (2022).

### 2. The catalog

`src/catalog/` takes a filed (or generated) return PDF and produces a catalog:

- **Pages.** Each page is classified against the blanks (header form number plus word
  overlap) as an IRS form page, a statement, a worksheet, a state form, a cover or
  transmittal page, or a duplicate copy.
- **Entries.** On form pages, the blank's printed text is subtracted and each
  remaining word is assigned to the widget that contains it. Checks are read from text
  glyphs and from drawn marks. Each value becomes one entry:
  `{form, rev, instance, page, line, column, label, kind, value, raw, canonical_key,
  method, bbox}`. Repeated forms (K-1s, 8949 pages, continuation pages) get an
  instance key. Duplicate printed copies are catalogued once and compared, and any
  disagreement is itself a finding.
- **Statements and worksheets.** These are parsed into titled tables of
  (description, amounts, reference line). AI is used only to label structure, and every
  value must appear verbatim in the page text.
- **Completeness is measured, not asserted.** After assignment, any non-template
  word left on a page is *residue*. A catalog is `complete` only when every page is
  classified and the residue is empty, or each residual token carries a written waiver.
  The coverage report lists exactly what is missing.
- **Storage.** In table `return_catalog`, one row per source document holds the
  entries as encrypted JSON (`entries_enc`), plus an unencrypted index (forms,
  pages, coverage, status). The row links to `tax_return` and `document`. Filed
  catalogs are immutable, and a re-run writes a new version.
- **Questions are answered from the catalog.** `query_catalog` (REST and MCP) takes
  an entity, years, forms, lines, a canonical key or a label search, and returns the
  value with its provenance (form, line, page). The MCP instructions tell the model to
  answer only from it.

### 3. Fact registry (R2)

`@taxengine/shared/facts` defines facts per return type. Each fact has a key, scope
(entity, entity-year, owner×entity, owner×entity-year, return), type, the question,
why it matters (the checks that need it), acceptable evidence, and the catalog lines
that answer or must agree with it. Answers are stored in table `tax_fact`, encrypted,
with source, evidence document, and who recorded it and when. Answers are superseded,
never overwritten.

`fact_gaps(entity, year)` returns the same list for every return of that type: what
is answered, what is unknown, and what is answered but contradicted by the catalog.
Existing free-text knowledge (`entity.meta.open_items_*`, "fact" documents,
`s_election_date`, `owners`) is migrated into it.

### 4. Multi-year ledger

`src/ledger/` derives every amount that carries between years from catalogs and
facts. Each figure carries its source line:
- stock basis, debt basis, and suspended §1366(d) losses, per shareholder
- AAA and E&P, and Schedule L equity
- capital loss carryovers (short- and long-term), NOL, charitable, §179 and passive
  carryovers
- state income tax accrued vs paid, by year
- intercompany balances on each side
- estimated payments and overpayments applied
- IRS balances and penalties (from transcripts)

The rule enforced: year N's opening equals year N−1's closing, and the figures a
return reports must equal the figures the ledger derives.

### 5. Review framework (R3)

`src/review/` holds a versioned registry of checks. Each check has an id, an area, the
form types it applies to, a kind (`rule`, `ai` or `fact`), and the facts and catalog
lines it needs. Its result is one of:
- `pass`
- `finding`, with severity, a dollar estimate where computable, a deadline (the
  §6501/§6511 statute where relevant), the evidence entries, and an explanation
- `gap` (missing fact or catalog data)
- `n/a`

AI checks send an evidence pack (cited catalog entries and facts) to the model and
must answer in JSON that cites entry ids. A result that cites anything outside the
pack is rejected.

Runs are stored in tables `review_run` and `review_finding`. Each run is diffed
against the previous one, and every new or changed finding is attributed to its
cause: a new document, a new fact, a framework change, or none. "None" means a
genuine miss, and it is reported as one.

### 6. Return notes (added 2026-10-18)

The catalog, facts and review cover what the documents say, what every return must
answer, and what the checks find. An audit on 2026-10-18 found a fourth kind of
knowledge that had no home:
- a payroll refund check whose receipt nobody had confirmed
- refund interest the IRS might owe
- the call a representative still had to make about a misposted return
- whether a related company had filed at all

All of it lived in conversation and was lost when a session ended.

Table `return_note` (`services/notes.ts`, `/api/notes`, MCP `add_note` / `update_note` /
`list_notes`) holds these threads.
- **Scope.** Each note belongs to a return (entity + tax year), or to the entity when it
  spans years.
- **Status.** A note is `open`, `closed` or `info` (standing context). An open note must
  say who it is waiting on: owner, IRS, preparer, agent or a third party.
- **Links.** A note may point at the registry fact or review finding it concerns.
- **Versions.** An edit writes a new version under the same `note_key`; nothing is
  overwritten.
- **Encryption.** Title and body are stored as ciphertext only.

Open notes appear in `review_summary` beside the findings. That is what keeps it "one
list of everything to act on". `get_review` returns a year's open and info notes with its
findings.

The boundaries:
- A question every return of a type should answer belongs in the registry.
- A decision about a finding is a resolution.
- A note is everything else.

## Check catalogue (initial)

**Corporate and entity**
- formation date
- S election effective date vs CP261 vs return item A
- C-corp history (E&P, §1374, Schedule D Part III)
- election accepted before filing
- business code and description consistency
- disregarded entities and whose EIN issues the W-2s
- ownership and shares (K-1 D/H)
- controlled groups (Schedule O on both returns)
- amended, duplicate and H(4) flags vs IRS posting
- preparer block
- signature

**Income and deductions**
- 1099 income complete
- COGS classification
- payroll taxes deducted once
- officer pay vs distributions
- meals 50%
- AMD/OID/bond premium
- state tax deducted in the year paid
- intercompany fee = counterpart's revenue, same year

**Schedule K / K-1**
- K = sum of K-1s
- K-1 17V QBI items listed separately, SSTB flag consistent
- item I loans = Schedule L line 19 genuine shareholder loans
- items C/F3/D/H complete
- Schedule B answers (14a/14b, QOF, K-2/K-3 exception)
- K line 18 = M-1 line 8

**Balance sheet, M-1 and M-2**
- Schedule L opening = prior-year closing, line by line
- L balances
- retained earnings vs AAA explained
- M-2 opening = prior-year closing
- distributions vs AAA
- loans to shareholders documented (recharacterization risk)
- liability classification (related company vs shareholder)

**Shareholder basis**
- stock basis rollforward from inception, in the §1367 ordering
- distributions above basis reported as gain
- debt basis only for direct shareholder loans
- repayment of basis-reduced debt
- suspended losses carried and used
- Form 7203 present and correct

**1040**
- Schedule E passive vs nonpassive matches material participation
- 8960 line 4b excludes nonpassive trade or business income
- all NII items present, including substitute payments
- §1411(c)(4) on S-stock gain
- QBI: SSTB consistent with the K-1, wages/UBIA from the K-1, phase-in
- capital loss carryover chain
- every K-1 amount ties to the 1040
- 2210 safe harbor
- 8959
- state returns (NY nonresident allocation)

**1120**
- NOL chain and 80% limit
- 2220
- Schedule K Q10/Q29
- M-1/M-2 ties
- §179 and bonus, with the Florida add-back
- Florida exemption shared across the controlled group
- constructive dividends and shareholder loans

**IRS account**
- TC150 posted to the right period, amount matches
- TC976 duplicates
- penalties and abatement eligibility (FTA history)
- extensions (TC460) vs filing date
- balances and levy holds
- assessment and refund statute dates
- employment tax (941, ERC), 1099 issuance, W-8BEN on file

**Cross-entity**
- K-1 → 1040
- each intercompany fee = the counterpart's revenue
- each intercompany balance = the counterpart's balance
- controlled-group consistency
- ownership consistent across returns

## Rollout

1. **Catalog.** Blanks and line dictionaries for every form and revision in the
   filed returns. Then the extractor, storage, `query_catalog`, and the coverage
   report. Done when all twelve filed returns (2022–2025 × EZA, EV, 1040) and the
   transcripts are catalogued with every page classified and residue zero.
2. **Fact registry.** Definitions for 1120-S, 1120, 1040 and 1065, the `tax_fact`
   table, migration of existing knowledge, and `fact_gaps`.
3. **Ledger.**
4. **Review framework.** The checks above, run over every catalogued year, giving
   one findings list with dollar effects and deadlines.
5. **Wiring.** Catalog on every upload. Replace the regex filed-import mapper. Gate
   the PDF on the review. Add the UI.
