# packages/web — working notes for AI agents

Vite 8 + React 19 + TypeScript, react-router v7, Tailwind v4 + shadcn
("base-nova" on Base UI), sonner toasts. Dark theme is hardcoded
(`index.html` ships `<html class="dark">`; there is no theme provider).
Brand is **Catipult** everywhere. Read the root `CLAUDE.md` first.

## Layout & conventions

```
src/
├── App.tsx              all routes, eagerly declared; /app subtree behind Guard
├── lib/
│   ├── api.ts           THE fetch helper — injects the Supabase bearer token.
│   │                    Only legit raw fetch()es: S3 presigned PUT (must not
│   │                    carry auth) and the Netlify OAuth function call.
│   ├── format.ts        fmtMoney / fmtMoneyCompact / fmtDelta / fmtDate /
│   │                    coerceNumericInputs — import these, never redefine
│   ├── labels.ts        FORM_TYPE_LABEL, FORM_TYPE_OPTIONS,
│   │                    COMPUTABLE_FORM_OPTIONS (≠ — engine has no calc1065),
│   │                    LEGAL_FORMS, SOURCE_LABEL/VARIANT
│   ├── mask.ts          maskTaxId — EINs/SSNs are never rendered raw
│   ├── auth.tsx         AuthProvider (Supabase session), toast.ts, supabase.ts
├── hooks/               one bespoke hook per resource (use-entities,
│                        use-returns, use-documents, use-scenarios, use-qbo,
│                        use-schema, use-calendar). Server state goes through
│                        these — don't hand-roll fetch+useState in pages.
├── pages/               route components
├── components/tabs/     the four EntityDetail tabs (Returns is the largest)
├── components/ui/       vendored shadcn primitives — treat as vendor code
netlify/functions/       OAuth 2.1 endpoints (stateless HS256-JWT codes via
                         jose — stateless BECAUSE the API's pm2 cluster can't
                         share memory; don't add server-side session state)
public/.well-known/      OAuth discovery JSON (paired with netlify.toml rules)
```

Types for API responses are hand-written in the hooks and can drift from the
server (the scenario-PDF button once no-oped for exactly that reason:
POST vs GET and `pdf_url` vs `url`). Until shared types land (roadmap),
verify the real response shape in `packages/api/src/routes/` before writing
a new call.

## Run / test

```bash
npm run dev -w packages/web    # :5173, proxies /api + /auth → localhost:3737
npm run lint -w packages/web
npm run test:e2e               # Playwright vs localhost:5173 — start dev first
npm run test:e2e:prod          # vs fin.catipult.ai — creates REAL accounts;
                               # test:e2e:clean sources SSM creds to purge them
```

No unit tests exist yet (roadmap). The e2e suite is incident-regression
style: every spec pins a bug that actually shipped (blank-page states, SPA
fallback swallowing /auth, OAuth discovery served as HTML, RLS isolation).
Keep that discipline — a fixed bug gets a spec.

## Env

`VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — set in
`netlify.toml` for prod builds; dev falls back to the vite proxy. Netlify
Functions additionally need `OAUTH_CODE_SECRET`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `API_BASE_URL` (set in the Netlify dashboard, not in
the repo).

## Do not

- Redefine a money/date formatter or a label map in a page — import from
  `lib/format.ts` / `lib/labels.ts`.
- Bypass `lib/api.ts` or the hooks for API data.
- Add 1065 to `COMPUTABLE_FORM_OPTIONS` — entities can *be* partnerships,
  but the engine cannot compute one.
- Touch `netlify.toml` redirects without reading the ordering rules in the
  root CLAUDE.md.
- Swallow a load error into an empty page state in NEW code — the e2e suite
  explicitly hunts "loads and quietly shows nothing" (existing hooks still
  do this; fixing them is a roadmap item).
- Render an EIN/SSN without `maskTaxId`.
