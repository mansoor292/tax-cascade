# Catipult Tax — IRS Form Engine, API & Web App

Computes, fills, and validates IRS tax returns programmatically: OCR intake of
filed returns, QuickBooks/Stripe ingestion, a deterministic tax engine, PDF
fill, what-if scenarios, and an MCP server so AI assistants can drive the
whole workflow.

## Monorepo layout

```
tax-cascade/
├── packages/api    Express 4 API + tax engine + MCP server (EC2 + pm2)
│   ├── src/engine/     tax computation (1120, 1120-S, 1040, cascade, extensions…)
│   ├── src/intake/     Textract/Gemini/QBO → canonical model
│   ├── src/maps/       canonical ↔ PDF field mappings (per form, per year)
│   ├── src/builders/   PDF fill + package assembly
│   ├── src/routes/     REST API (returns, entities, documents, QBO, Stripe…)
│   ├── src/mcp/        MCP server (~40 tools) + OAuth
│   └── data/           verified field maps + blank IRS forms (2020–2025)
└── packages/web    Vite + React SPA (Netlify) + OAuth Netlify Functions
```

**Key principle:** fuzzy logic on intake (OCR is messy), deterministic on
output (PDF field IDs are exact). Every field mapping is Textract-verified:
label the blank form with field IDs, OCR it, map ID → label, fill, re-OCR,
compare.

## Getting started

```bash
npm install          # root; npm workspaces
npm run dev          # api on :3737 + web on :5173 (concurrently)
npm test             # api unit tests (vitest)
npm run test:e2e     # web Playwright suite
```

The API needs Supabase, AWS, and (optionally) QuickBooks/Gemini credentials —
see `packages/api/.env.production.template` for the full variable reference
and `packages/api/CLAUDE.md` for how configuration is loaded (SSM, dotenv,
precedence).

## Documentation

- `CLAUDE.md` (root, and one per package) — architecture, capabilities,
  operational memories, and the rules AI agents must follow in this repo.
- `packages/api/SKILL.md` — the REST workflow contract for external API
  consumers (AI assistants using the hosted API).
- `docs/CLEANUP_ROADMAP.md` — planned deep refactors and their rationale.

## Deployment

- **API**: EC2 behind pm2 cluster (`ecosystem.config.cjs`), deployed via a
  GitHub webhook that runs `packages/api/scripts/deploy-reload.sh`. Secrets
  come from AWS SSM Parameter Store (`/tax-api/*`).
- **Web**: Netlify (`netlify.toml` at the repo root — its redirect order is
  load-bearing; read the comments before touching it). The SPA proxies
  `/api/*`, `/auth/*`, and `/mcp` to the API origin.
