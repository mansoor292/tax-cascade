# tax-cascade — working notes for AI agents

Catipult Tax: computes, fills, and validates IRS tax returns. npm-workspaces
monorepo, three packages.

| Package | What | Where it runs |
|---|---|---|
| `packages/api` | Express 4 (ESM): tax engine, REST API, MCP server (45 tools), OAuth, discovery metadata, AND the built SPA | EC2 behind pm2 cluster + ALB |
| `packages/web` | Vite + React 19 SPA (built by the deploy script, served by Express) | same origin as the API |
| `packages/shared` | Canonical metric maps, section vocabulary, response types | Imported by both (its CLAUDE.md explains the wiring — read before touching) |

The public hostname is **fin.catipult.ai** — since 2026-09-02 a CNAME
straight to the Dynalogs ALB; ONE origin serves everything. Netlify was cut
out of the request path after its edge was caught corrupting
first-request-after-idle responses (HTTP/2 INTERNAL_ERROR), which Anthropic's
connector proxy surfaced as intermittent 502s that never reached AWS. The
Netlify site (`tax-engine-app.netlify.app`) still exists solely as a DNS
rollback target; `netlify.toml` is inert. `tax-api.catalogshub.com` is the
same origin under its legacy name.
Per-package details: `packages/api/CLAUDE.md`, `packages/web/CLAUDE.md`.

## Run / test

```bash
npm install            # root — npm workspaces, ONE root package-lock.json
npm run dev            # api on :3737 + web on :5173 together
npm test               # vitest in every workspace (api + web)
npm run test:e2e       # web Playwright vs localhost:5173 (test:e2e:prod for live)
npm run lint -w packages/web
```

Local dev needs `SUPABASE_SERVICE_ROLE_KEY` at minimum (see
`packages/api/.env.production.template` for the full variable list); the web
dev server proxies `/api` and `/auth` to `localhost:3737`.

## Load-bearing facts (learned from production incidents — do not re-learn)

1. **`src/bootstrap_env.ts` must stay the FIRST import in `server.ts`.**
   ESM hoists imports, so route modules capture `process.env` before any
   inline env loading would run. When this rule was broken, every route
   silently ran on the anon key and RLS returned zero rows while the API
   looked healthy. Nothing imported by bootstrap_env may itself read env at
   module load.

2. **Route ORDER is semantic — the SPA fallback must lose to everything.**
   Two production incidents (on Netlify, whose redirect rules encoded this)
   came from the SPA fallback swallowing `/auth/*` (API-key list silently
   empty) and discovery URLs (an HTML page served with 200 parses as broken
   metadata → "Couldn't reach server"). The rules now live in code:
   `routes/wellknown.ts` serves every RFC spelling of the discovery docs and
   404s every OTHER `.well-known` path as JSON; `server.ts` mounts
   wellknown+oauth BEFORE `/mcp` (or `/mcp/.well-known/*` is swallowed by
   the MCP handler) and mounts the SPA static+fallback LAST, with the
   fallback refusing backend prefixes. Anything that must 404 must do so
   explicitly before the fallback can answer.

3. **The API runs in pm2 CLUSTER mode — no in-process shared state.**
   One worker per core (`ecosystem.config.cjs`). The DEK cache in
   `lib/crypto.ts` is per-worker (fine). An in-memory OAuth code store once
   lived in `mcp/oauth.ts` and was broken for exactly this reason (a code
   issued by worker 0 was invisible to worker 1); it has been deleted — the
   stateless-JWT Netlify Functions are the only OAuth implementation. Any
   new cache or session map must survive N processes.

4. **pm2 runs `node --import tsx`, never the tsx bin shim.** The shim spawns
   a child that isn't a cluster worker → EADDRINUSE respawn loop (4.2M
   restarts over 135 days, one worker silently serving). Deploys go through
   the GitHub webhook (`POST /deploy`) which double-forks
   `packages/api/scripts/deploy-reload.sh` so pm2's treekill can't kill the
   reload halfway and leave half the fleet on the old build.

5. **Secrets live in AWS SSM Parameter Store under `/tax-api/*`.**
   `scripts/load-ssm-env.sh` exports them into the deploy shell;
   `bootstrap_env.ts` also loads them in-process. Precedence is
   first-loaded-wins: `.env.production` → SSM → `.env` →
   `DOTENV_CONFIG_PATH`. `.env.production.template` documents every
   variable. Never commit a real value, never invent a fallback literal.

6. **AWS I/O is flag-gated dual-path.** `lib/s3.ts` / `lib/textract.ts` run
   the AWS SDK when `TAX_API_AWS_SDK=1` and fall back to the historical
   boto3-subprocess scripts otherwise. Don't add a new inline Python block —
   add an operation to those modules.

7. **Filed vs computed returns are strictly separated.** Filed imports
   (`source='filed_import'`, from OCR'd prior-year PDFs) are immutable;
   computed returns (proforma/amendment/extension) come from the engine.
   `tax_return.field_values` is the golden model, keyed by sectioned
   canonical keys (`income.L1a_gross_receipts`, `tax.L31_total_tax`); flat
   metric names are per-form code aliases in `@taxengine/shared`
   (packages/shared/src/metrics.ts), never a persisted slot. See
   `packages/api/src/maps/canonical_schema.ts` for the whole contract.

## Rules

- **Never** re-add hardcoded Supabase URL/anon-key fallback literals — they
  were removed everywhere (the leaked key is being rotated). Clients come
  from `api/src/lib/supabase.ts` only.
- **Never** hand-edit `packages/api/supabase/migrations/*_remote_schema.sql`
  (it's a `db pull` dump). New schema changes are new migration files.
- **Never** put a real key, EIN, or SSN in a committed file — this repo
  handles exactly that data and has a masking/encryption layer for it
  (`web/src/lib/mask.ts`, `api/src/lib/crypto.ts`). The README once carried
  a real SSN; don't repeat that.
- Comment style: file-header comments explain *why* (often a postmortem).
  Preserve them through refactors; they are this repo's institutional
  memory. Follow the same style for new modules.
- `main` branch deploys the API on push via the webhook. Keep it green.
