# packages/api — working notes for AI agents

Express 4, ESM (`"type": "module"`, NodeNext), TypeScript strict, run under
tsx in dev and `node --import tsx` under pm2 cluster in prod. Read the root
`CLAUDE.md` first for the six load-bearing facts; this file is the map of
what lives where.

## Layout

```
src/
├── bootstrap_env.ts   MUST stay server.ts's first import (see root CLAUDE.md)
├── server.ts          app assembly: auth middleware, route mounts, deploy
│                      webhook, plus stateless endpoints (/api/compute/*,
│                      /api/fill, /api/label, /api/verify, /api/tax-tables)
├── routes/            all business logic lives in the Express handlers —
│                      there is no service layer (roadmap)
├── engine/            deterministic tax computation + tax tables 2018–2025
│                      + calendar rules. calc1120 / calc1120S / calc1040 /
│                      calcCascade / calcExtension / calc4562 / calc8594 /
│                      calcScheduleE / calcForm8582. NO calc1065 — 1065s
│                      only enter as filed imports.
├── intake/            Textract / Gemini / QBO → canonical model
├── maps/              canonical_schema.ts (THE data contract),
│                      metric_to_field.ts (flat metric ↔ sectioned key),
│                      PDF field maps per form/year, qbo_to_inputs
├── builders/          PDF fill; build_return_pdf.ts is the live package
│                      builder, pdf_filler.ts has the shared helpers
├── mcp/               tax-mcp.ts (43 tools; calls this server's own REST
│                      over localhost — by design) + oauth.ts
├── discovery/         download IRS PDF → Textract → auto-build field map
└── lib/               crypto/row_crypto (encryption), http_error
                       (sendError/sendDbError), run_python, ssm, …
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
provisioned `api_key` rows (argon2-hashed). Handlers then call `getUser(req)`
which reads `req.userId` set by the middleware.

## Data + encryption model

- `tax_return.field_values` is the golden model; sectioned canonical keys
  only (`canonical_schema.ts` validates on persist). Flat metrics
  (`total_tax`) resolve per form via `maps/metric_to_field.ts`.
- Row encryption (`lib/row_crypto.ts`): sensitive columns have `*_enc`
  bytea twins, encrypted with a per-user DEK (KMS envelope, `lib/crypto.ts`).
  Write via `encryptedFields(...)` spread; read via `hydrate`/`hydrateAll`
  right after `.select()`. `tax_return` rows have no `user_id` — resolve it
  via the entity and pass `userId` to hydrate, or decryption silently
  no-ops (this bug shipped once).
- Transition states: row-crypto cutover is DONE (plaintext no longer
  written); `lib/qbo_tokens.ts` still dual-writes (roadmap); Stripe keys are
  prefix-encrypted (`enc1:`) inside the text column `stripe_key_encrypted`.
- `TAX_API_WRITE_PLAINTEXT=1` is a rollback valve, not a mode.

## Python subprocesses are the AWS layer

All S3/Textract I/O goes through inline boto3 scripts run by
`lib/run_python.ts` (`runPythonAsync`; the sync variant is deprecated for
server use). This is deliberate-but-legacy (roadmap: move to the AWS SDK).
`PYTHON_BIN` overrides the interpreter. Don't add a new inline Python block
without checking whether an existing one already does it.

## Testing honesty

`npm test` = vitest, 6 suites covering the deterministic core: tax engine
golden cases, calendar rules, QBO mapping, input coercion, 1065 archive
mapping. **Routes, crypto, builders, and MCP have no tests** — a green run
does not validate changes there; exercise those paths manually (run the
server, hit the endpoint) before claiming they work.

## Env

Full variable reference: `.env.production.template` (all ~26). Prod source
of truth is SSM `/tax-api/*`. Load order and the fail-loud service-role
check live in `bootstrap_env.ts`.

## Do not

- Add per-route `createClient()`/`getUser()` copies — reuse an existing
  route's imports until the shared client lands (roadmap #1).
- Fetch this server from itself for data a function call could return
  (returns.ts already does this 9× for QBO financials; that's the pattern
  being removed, not the pattern to copy).
- Add another money-parsing regex — grep for `replace(/[\$,\s]/g` first.
- Skip `hydrate()` after selecting encrypted tables, or forget `userId` on
  `tax_return` rows.
- Return raw `res.status(500).json(...)` in new code — use
  `lib/http_error.ts`.
