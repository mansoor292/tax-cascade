# tax-cascade — working notes for AI agents

Catipult Tax: computes, fills, and validates IRS tax returns. npm-workspaces
monorepo, two packages, no shared package (yet — see docs/CLEANUP_ROADMAP.md).

| Package | What | Where it runs |
|---|---|---|
| `packages/api` | Express 4 (ESM) tax engine, REST API, MCP server (43 tools) | EC2 behind pm2 cluster, origin `tax-api.catalogshub.com` |
| `packages/web` | Vite + React 19 SPA + OAuth Netlify Functions | Netlify at `fin.catipult.ai` |

The public hostname is **fin.catipult.ai**; Netlify rewrites `/api/*`,
`/auth/*`, and `/mcp` to the EC2 origin. `tax-engine-app.netlify.app` is a
legacy domain still present in `packages/api/supabase/config.toml`.
Per-package details: `packages/api/CLAUDE.md`, `packages/web/CLAUDE.md`.

## Run / test

```bash
npm install            # root — npm workspaces, ONE root package-lock.json
npm run dev            # api on :3737 + web on :5173 together
npm test               # api vitest (engine/calendar/QBO mapping only)
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

2. **`netlify.toml` redirect ORDER is semantic.** Rules match top-down:
   OAuth function routes, then `/mcp` + `/api/*` + `/auth/*` proxies, then
   the `.well-known` discovery rewrites, then the `.well-known` 404
   catch-alls, then the SPA fallback LAST. Two separate production incidents
   came from the SPA fallback swallowing `/auth/*` (API-key list silently
   empty) and discovery URLs (an HTML page served with 200 parses as broken
   metadata → "Couldn't reach server"). Never append a redirect without
   placing it deliberately; anything that must 404 must do so explicitly
   above the fallback.

3. **The API runs in pm2 CLUSTER mode — no in-process shared state.**
   One worker per core (`ecosystem.config.cjs`). The DEK cache in
   `lib/crypto.ts` is per-worker (fine). The in-memory OAuth code store in
   `mcp/oauth.ts` is NOT fine (a code issued by worker 0 is invisible to
   worker 1 — roadmap item; the Netlify Functions implementation went
   stateless with JWTs for exactly this reason). Any new cache or session
   map must survive N processes.

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

6. **Filed vs computed returns are strictly separated.** Filed imports
   (`source='filed_import'`, from OCR'd prior-year PDFs) are immutable;
   computed returns (proforma/amendment/extension) come from the engine.
   `tax_return.field_values` is the golden model, keyed by sectioned
   canonical keys (`income.L1a_gross_receipts`, `tax.L31_total_tax`); flat
   metric names are per-form code aliases in
   `packages/api/src/maps/metric_to_field.ts`, never a persisted slot. See
   `packages/api/src/maps/canonical_schema.ts` for the whole contract.

## Rules

- **Never** re-add hardcoded Supabase URL/anon-key fallback literals. The
  ones still in route files are vestigial (bootstrap_env made them dead) and
  are being removed, not multiplied.
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
