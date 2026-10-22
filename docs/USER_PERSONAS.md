# Who uses Catipult Tax — personas and their journeys

Why this exists: on 2026-10-21 a shipped view (Compare → All sources) could not
be reached by clicking, because its only button appeared when a year had an
amendment and no entity had one. Every test opened it by URL. Mansoor: "there
is a lot of misdirects in this UI … we need user personas first." The UI audit
walks each persona's journeys from where that persona starts, by clicking
only, and every fix gets a click-through test named for the journey.

Each persona says what it rests on. **Observed** = someone like this used the
product and we have their words or findings. **Decided** = Mansoor named them
as a customer (2026-10-21) though none has been observed yet.

## The business model, and what it means for the UI

**$99 per filed return or amendment, state returns included** (Mansoor,
2026-10-21). So:

- The unit a customer pays for is a **filed** return or amendment. Every
  journey that matters commercially ends there, and the UI must make it plain
  what has been filed, what is ready to file, and what is still a draft.
- A customer should see what the $99 buys before paying: the federal return,
  its state returns, the PDF package.
- "States included" promises more than the product does today: the only state
  forms it builds are New York's IT-203 set (nonresident individual) and
  Florida's F-1120 (corporate). That is a product gap, not a UI misdirect.
- The product has no pricing, billing or payment step today.

**OPEN:** does an extension count as a filed return? Is the $99 per entity
per year, with every state return for that entity-year included?

## The personas

### P1. The business owner — Observed (Mansoor), primary

*Who:* runs one or a few related companies and files for them and the family
(Mansoor: an S-corp, two C-corps and a joint 1040, one shareholder across
them). Prepares with Claude's help, without an outside CPA.

*Rests on:* Mansoor's own use since 2026-04; the "business owner focus"
dashboard (2026-04-14); the catalog, entity map, version sets and Group page,
all built at his request.

*Wants, in order:*
1. For a year, the state of every return: filed, late, extended, what the IRS
   holds, what is owed.
2. One return seen across every source (filed, IRS, books, documents), with
   the differences called out.
3. What doesn't tie across the companies, and the open items, kept as one
   list rather than re-derived every conversation.
4. A filing package that is right, and the papers to answer the IRS.

*Knows:* the businesses and their money, and tax concepts. Does not think in
IRS line numbers, form revisions or our internal names ("canonical key",
"proforma", "cascade").

*Starts at:* the Dashboard, the Group page, or an entity in the sidebar —
often from a page Claude named.

*A misdirect for P1:* a feature hidden behind a condition he doesn't meet; the
same thing in two places that disagree; a label in engine terms; a page that
can only be reached by typing its address.

### P2. The tax preparer — Decided, primary

*Who:* prepares returns for many clients through a season.

*Rests on:* Mansoor's decision (2026-10-21) and the landing page ("Built for
tax preparers", "Built for accounting firms"). No preparer has been observed
using the product yet.

*Wants:* every client with each return's status and deadline; prior returns
and documents imported fast; compute, then review line by line with where
each number came from; extensions, amendments, PDFs and K-1s.

*Knows:* the forms and line numbers cold; wants speed and density more than
explanation.

*Starts at:* the client list, or the deadline calendar.

*Today:* a preparer's clients are simply entities in the preparer's own
account. There is no firm, client or invitation model.

*A misdirect for P2:* switching clients loses your place; a number shown
without the line it belongs to; a step that needs the owner's knowledge of
our internals.

### P3. The business owner on day one — Observed (SOP testers playing a client)

*Who:* P1 at sign-up, with a new, empty account and a stack of papers
(prior returns, W-2s, 1099s, K-1s to issue as a managing partner).

*Rests on:* the SOP 01–04 walks (Christy and others, 2026-08/09, playing a
client): connect Claude, upload documents, compare the filed return, compute,
issue K-1s. Their findings are pinned in the e2e specs.

*Wants:* to get from nothing to a computed return and its PDF without help.

*Knows:* their own papers, not return lines ("users hold W-2s and 1099s, not
return-line concepts" — SOP-04).

*Starts at:* sign-up, then an empty Dashboard.

*A misdirect for P3:* an empty page that doesn't say what to do next; an error
that flashes and vanishes; an input that asks for a tax concept instead of a
box on a form they hold.

### P4. The outside reviewer — Decided

*Who:* someone the owner or preparer lets look at one entity, without changing
anything: the representative calling the IRS, or a CPA asked for a second look.

*Rests on:* Mansoor's decision (2026-10-21).

*Wants:* the filed return beside the IRS's record for a year, the open
items, and the document behind a number.

*Starts at:* a link they were sent.

*Today:* there is no way to share an entity. Every account sees only its own
entities.

### P5. Claude, through the connector — Observed (not a web-UI user)

*Who:* the model working for P1–P4 through the MCP tools.

*Why it is here:* people arrive in the web app because Claude named a page or
a view. The names and links in tool output must match the pages exactly. The
web audit checks only that; Claude's own behaviour is the MCP harness's job.

## Journeys

The first walk, its findings and what was fixed: `docs/UI_AUDIT_2026-10-22.md`.

Each is walked by clicking only, from the persona's starting page. A step
that cannot be done because the capability does not exist is logged as
**missing**. A step that exists but is hard to find or misleads is logged as a
**misdirect**. ($) marks a journey that ends at the paid unit.

**P1 — business owner**
1. Dashboard → this year's status for every return (filed, extended, late,
   owed) → open the one that needs action.
2. Entity → one year across every source → what differs, and why.
3. Group → what doesn't tie between the companies → the open items to clear
   before filing.
4. Entity → year → the filing package, federal and state → recorded as
   filed. ($)
5. Entity → filed year → an amendment → its change against the filed
   return → filed. ($)

**P2 — tax preparer**
1. Client list or calendar → the next return due across all clients.
2. Add a client → import a prior-year return and the documents → ready to
   compute.
3. Client → compute → review line by line, with the source of each number →
   package, federal and state → filed. ($)
4. Client → extension filed → tracked until the return is filed.
5. S-corp client → K-1s issued → the shareholder's 1040 picks them up.

**P3 — business owner on day one**
1. Sign up → an empty Dashboard that says what to do → first entity.
2. Upload a prior return and W-2s/1099s → see what was read → fix what was
   misread.
3. Connect QuickBooks; connect Claude.
4. First computed return → PDF → what the $99 buys, before paying. ($)

**P4 — outside reviewer**
1. Open the link they were sent → one entity only → a year's filed return
   beside the IRS's record.
2. The open items, and the document behind a number, with nothing editable.

**P5 — Claude**
1. Every page and view named in MCP tool descriptions and output exists
   under that name and can be reached by clicking.
