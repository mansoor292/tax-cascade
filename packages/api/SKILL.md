# Tax Preparation API — Claude Skill

## Auth
- Base URL: `https://tax-api.catalogshub.com`
- Header: `x-api-key: test-key-2026`

## Discovery
Always start by calling `GET /api/schema` to see supported forms, years, required inputs, and all available endpoints.

For detailed input specs: `GET /api/schema/:form_type/:year`

## Workflow

1. **See what exists**: `GET /api/entities` — list entities and their returns
2. **Set up entity**: `POST /api/entities` if new entity needed
3. **Check QBO**: `GET /api/qbo/:entity_id/status` — is QuickBooks connected?
4. **Pull financials**: `GET /api/qbo/:entity_id/financials?year=YYYY` — unified P&L + Balance Sheet (cached; add `&refresh=true` to re-fetch from QBO)
5. **Map QBO → tax**: `GET /api/schema/:form_type/qbo-mapping` — get P&L category → tax field mappings
6. **Validate inputs**: `POST /api/returns/validate` with `{ form_type, tax_year, inputs }` — check before compute
7. **Compute return**: `POST /api/returns/compute` with `{ entity_id, tax_year, form_type, inputs }`
8. **What-if scenarios**: `POST /api/scenarios` → `POST /api/scenarios/:id/compute`
9. **Compare options**: `POST /api/scenarios/compare`
10. **Finalize**: `POST /api/scenarios/:id/promote` to make a scenario the official return
11. **Get PDF**: `GET /api/returns/:id/pdf` — returns a 1-hour presigned download URL

## QuickBooks Integration
- **Check status**: `GET /api/qbo/:entity_id/status`
- **Connect**: `GET /api/qbo/connect/:entity_id` — returns `auth_url` for user to click
- **Financials**: `GET /api/qbo/:entity_id/financials?year=2025` — flattened P&L + Balance Sheet
- **Individual reports**: `GET /api/qbo/:entity_id/reports/profit-and-loss?year=2025` (also: balance-sheet, trial-balance, general-ledger, cash-flow)
- **List cached reports**: `GET /api/qbo/:entity_id/reports`
- **Refresh**: add `?refresh=true` to any report/financials call to re-fetch from QBO
- **Raw query**: `GET /api/qbo/:entity_id/query?q=SELECT * FROM Account`

When QBO is connected, pull financials first and auto-map to tax inputs before asking the user for manual data.

## Document Upload (prior returns, W-2s, etc.)
1. `GET /api/documents/presign?filename=2024_1040.pdf` — get presigned S3 upload URL
2. User uploads file to the presigned URL
3. `POST /api/documents/register` with `{ s3_key, filename }` — triggers OCR + classification
4. `POST /api/returns/process/:document_id` — extract → map → compute → save

## Rules
- Never fabricate financial data — ask for missing values
- Always confirm tax year before computing
- Validate before compute
- For S-Corps, shareholder percentages must sum to 100%
