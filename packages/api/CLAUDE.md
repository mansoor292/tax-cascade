# packages/api — working notes for AI agents

Express 4, ESM (`"type": "module"`, NodeNext), TypeScript strict, run under
tsx in dev and `node --import tsx` under pm2 cluster in prod. Read the root
`CLAUDE.md` first for the load-bearing facts; this file is the map of
what lives where.

## Layout

```
src/
├── bootstrap_env.ts   MUST stay server.ts's first import (see root CLAUDE.md)
├── server.ts          app assembly: auth middleware, route mounts, deploy
│                      webhook, plus stateless endpoints (/api/compute/*,
│                      /api/fill, /api/label, /api/tax-tables)
├── routes/            Express handlers; the compute engine-room lives in
├── services/          compute_return (the old 1,000-line POST /compute body,
│                      returning {status, body}), compute_validation,
│                      qbo helpers — call these, never fetch the server
│                      from itself
├── engine/            deterministic tax computation + tax tables 2018–2025
│                      + calendar rules. calc1120 / calc1120S / calc1040 /
│                      calcCascade / calcExtension / calc4562 / calc8594 /
│                      calcScheduleE / calcForm8582. NO calc1065 — 1065s
│                      only enter as filed imports.
├── intake/            Textract / Gemini / QBO → canonical model
├── maps/              canonical_schema.ts (THE data contract), PDF field
│                      maps per form/year, qbo_to_inputs. The flat-metric ↔
│                      sectioned-key map moved to @taxengine/shared
├── builders/          PDF fill; build_return_pdf.ts is the live package
│                      builder, pdf_filler.ts has the shared helpers
├── mcp/               tax-mcp.ts (44 tools; calls this server's own REST
│                      over localhost — by design). OAuth lives ONLY in the
│                      web package's Netlify Functions; do not add an
│                      Express OAuth stack here (see server.ts's comment)
├── discovery/         download IRS PDF → Textract → auto-build field map
└── lib/               supabase.ts (serviceClient/anonClient/userClient/
                       requestUserId — THE clients, three on purpose;
                       module scope must use lazyServiceClient/lazyAnonClient
                       so a missing key fails one request, not boot),
                       crypto/row_crypto (encryption + the ENCRYPTED_*
                       field specs), http_error (sendError/errorOutcome),
                       s3.ts + textract.ts (flag-gated AWS dual path),
                       run_python, ssm, …
data/field_maps/       Textract-verified JSON maps (per form per year)
data/irs_forms/        blank IRS PDFs, 2020–2025 — loadBlankForm() reads
                       these at runtime; they MUST be committed
supabase/migrations/   7 migrations; *_remote_schema.sql is a dump, never
                       hand-edited
scripts/               deploy-reload.sh + load-ssm-env.sh are LOAD-BEARING
                       (webhook + pm2 call them by path); field-map regen
                       tools; archive/ holds dead one-shots
```

## Route surface

Mounted in `server.ts` (~line 217): `/auth` (signup/signin/me/API keys),
`/api/scenarios`, `/api/documents`, `/api/returns` (the big one — compute,
compute_from_qbo, amend, validate, PDF, extensions), `/api/entities`,
`/api/schema` (self-describing form specs — clients should read this instead
of hardcoding), `/api/qbo` (OAuth, reports, transactions, AI
recategorization, bank reconciliation), `/api/stripe`, `/api/scratch` (KV
offload for MCP context), `/api/intake` (Gemini gap-fill), `/api/calendar`,
`/api/discover`. `SKILL.md` documents the consumer workflow (entities → QBO →
financials → validate → compute → scenarios → promote → PDF).

Auth middleware (`server.ts` `/api` gate): static keys from `TAX_API_KEYS`
(no default — unset means only real auth works), Supabase JWTs, and
provisioned `api_key` rows (argon2-hashed). Handlers read the resolved id
via `requestUserId(req)` from lib/supabase (imported `as getUser`) — never
re-verify tokens in a handler; the middleware already did.

## Data + encryption model

- `tax_return.field_values` is the golden model; sectioned canonical keys
  only (`canonical_schema.ts` validates on persist). Flat metrics
  (`total_tax`) resolve per form via `@taxengine/shared` (readMetric/metricKey).
- Row encryption (`lib/row_crypto.ts`): sensitive columns have `*_enc`
  bytea twins, encrypted with a per-user DEK (KMS envelope, `lib/crypto.ts`).
  Write via `encryptedFields(...)` spread; read via `hydrate`/`hydrateAll`
  right after `.select()`. `tax_return` rows have no `user_id` — resolve it
  via the entity and pass `userId` to hydrate, or decryption silently
  no-ops (this bug shipped once).
- Cutover state: row-crypto AND qbo_tokens write ciphertext-only now;
  Stripe keys are prefix-encrypted (`enc1:`) inside the text column
  `stripe_key_encrypted`. Legacy-row backfills:
  `scripts/backfill_null_qbo_plaintext.ts`, `scripts/migrate_stripe_enc1.ts`
  (dry-run by default; run manually against prod).
- `TAX_API_WRITE_PLAINTEXT=1` is a rollback valve, not a mode.

## AWS layer: lib/s3.ts + lib/textract.ts (flag-gated)

Every S3/Textract operation goes through those two modules. With
`TAX_API_AWS_SDK=1` they run the AWS SDK in-process; unset, they run the
historical boto3 subprocess scripts (via `lib/run_python.ts`,
`PYTHON_BIN` overrides the interpreter) so a flag-off deploy is unchanged.
The SDK Textract path THROWS on a failed job; the Python path keeps the
legacy print-a-sentinel behavior. Never add a new inline Python block —
add an operation to lib/s3 or lib/textract. form_discovery.ts keeps two
bespoke Python Textract reductions (in-file note).

## Testing honesty

`npm test` = vitest (src/ only — vitest.config.ts excludes compiled dist
tests). Covered: the engine golden cases, calendar rules, QBO mapping,
input coercion, 1065 archive mapping, the encrypted-field-spec drift
guards, compute arithmetic validation, entity-identity parsing, the
Textract poll loop, and the shared metric contract. **Route handlers,
crypto primitives, and MCP still have no tests** — a green run does not
validate changes there; exercise those paths manually before claiming
they work. `npm run lint` (eslint) exists here too.

## Env

Full variable reference: `.env.production.template` (all ~26). Prod source
of truth is SSM `/tax-api/*`. Load order and the fail-loud service-role
check live in `bootstrap_env.ts`.

## Do not

- Create a Supabase client anywhere but `lib/supabase.ts`, or re-implement
  getUser — `requestUserId(req)` is one line. serviceClient/anonClient/
  userClient are three exports ON PURPOSE (RLS vs service-role vs auth).
- Fetch this server from itself. `getFinancials()` (routes/qbo.ts) and
  `computeReturn()` (services/compute_return.ts) exist precisely because
  12 loopback fetches used to do this.
- Add another money-parsing regex — grep for `replace(/[\$,\s]/g` first.
- Skip `hydrate()` after selecting encrypted tables, or forget `userId` on
  `tax_return` rows.
- Return raw `res.status(500).json(...)` in new code — use
  `lib/http_error.ts`.
