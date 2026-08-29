# Cleanup roadmap — deep refactors, in order

The 2026-08 cleanup branch shipped the safe wins: AI-facing docs (CLAUDE.md),
security quick wins (Stripe key encryption, no default API key, README PII
scrub), ~12k lines of dead code deleted, lint/gitignore/Playwright repairs,
and the web format/label dedup plus the scenario-PDF bug fix. What remains is
the structural work, ordered by leverage. Each item is sized for one
reviewable PR.

## 1. One Supabase client + one getUser (api)

Every route module re-declares `SUPABASE_URL`/key fallbacks, calls
`createClient()` (13× in src), and copies `getUser()` (7×, byte-identical);
`lib/get_user.ts` is the already-written extraction nobody imports. Since
`bootstrap_env.ts` became the first import, the hardcoded anon-JWT fallback
literals are dead weight — and a leaked credential sitting in 15+ files.

Do: add `lib/supabase.ts` exporting the singleton (env only, fail loud);
rewire all `createClient` sites; adopt `lib/get_user.ts` (or promote the
middleware's `req.userId` contract); delete every fallback literal, including
`netlify.toml`'s and the two copies in `web/e2e/helpers.ts` +
`web/src/lib/supabase.ts`. Also standardize `lib/http_error.ts` across the
29 remaining raw `res.status(500)` sites. Rotate the leaked anon key after.

## 2. getFinancials() and the returns.ts split (api)

`routes/returns.ts` is 2,333 lines; `POST /compute` alone is ~1,050 and
fetches THIS SERVER over HTTP nine times (three URL variants) to get QBO
financials/Schedule L. Extract `getFinancials(entityId, year, opts)` from
`routes/qbo.ts` into a service module both routers call (mind: the loopback
carried the caller's bearer token — thread userId explicitly). Then carve
`POST /compute` into a `services/compute.ts`. The MCP server's
localhost-REST pattern stays — that one is by design.

## 3. packages/shared — types, canonical keys, labels

The web hand-writes every API response type (Scenario was declared 3×) and
re-derives 35 canonical field-path strings that `api/src/maps/
metric_to_field.ts` owns (Compare, Dashboard, ReturnsTab). One engine-side
line renumber silently breaks the dashboard. Create `packages/shared` with:
canonical key constants + the metric→field map, response types (derive from
the MCP zod schemas where possible), and the label/option lists now in
`web/src/lib/labels.ts`. Three parallel input-contract definitions (engine
interfaces, `routes/schema.ts` INPUT_SCHEMAS, MCP zod) should collapse to
one source there too.

## 4. Replace inline-Python boto3 with the AWS SDK (api)

~19 inline Python template-literals across 6 files do all S3/Textract work
(the Textract poll loop is written out 4+ times). Add `lib/s3.ts` and
`lib/textract.ts` on `@aws-sdk/client-s3`/`client-textract` and migrate
call sites incrementally (documents.ts first — it has 9). Kills the Python
runtime dependency and the /tmp script-file dance.

## 5. Finish the encryption cutover (api)

- `lib/qbo_tokens.ts` still dual-writes plaintext OAuth tokens; stop, and
  backfill-null the plaintext columns.
- Migrate legacy plaintext `stripe_key_encrypted` rows to the `enc1:` format
  (they currently only re-encrypt on reconnect).
- Unify `ENCRYPTED_RETURN_FIELDS`/`ENCRYPTED_DOC_FIELDS` (declared 4×/2×,
  the doc one in two different orders) into `lib/row_crypto.ts`, and audit
  the hydrate call sites that omit `userId`.

## 6. One OAuth implementation

Two independent OAuth 2.1 + PKCE stacks exist: `api/src/mcp/oauth.ts`
(in-memory Map — broken under pm2 cluster) and the Netlify Functions
(stateless JWT — correct). Retire the Express one onto the stateless
approach and collapse the four copies of the discovery metadata
(oauth.ts, two public/.well-known JSON files, netlify.toml rules) to one
generated source. The six consecutive fix commits on discovery all trace to
this duplication.

## 7. Web structure + tests

- Split `ReturnsTab.tsx` (761 lines, 10 useState) — extract the compute
  dialog (shares logic with Compute.tsx and Extensions.tsx: three variants
  of schema-driven form → coerce → POST) and `YearDetail`. Split
  `Compare.tsx` (682, three page states).
- Move Dashboard/Compare's raw `Promise.all` fetching onto the hooks and
  delete the remaining shadow interfaces.
- First vitest setup: `lib/format.ts`, `lib/mask.ts`, `groupByYear`,
  Compare's `collectValues`/`sortKey` are pure and untested.
- Surface hook load errors (7 of 8 hooks `catch {}` into empty states —
  the e2e suite tests against exactly that symptom).
- Unify the three auth forms (Login, OAuthAuthorize's inline pair) on
  `useAuth()`.

## 8. Ops / security follow-ups (not code)

- Purge the README's old SSN/EINs from git history (filter-repo +
  coordinated force-push) — the working tree is clean since 2026-08, the
  history is not.
- Rotate: the Supabase anon key (once #1 removes the literals), the static
  API keys that were committed in `.env.production.template`/SKILL.md, and
  audit `api_key` rows for the all-zeros user.
- Point `supabase/config.toml` `site_url` at fin.catipult.ai (still the
  legacy Netlify domain).
- API-side ESLint (web has a config now; api has none) and a shared
  tsconfig base once web can turn `strict` on.
