# Tax Preparation API — Claude Skill

## Auth
- Base URL: provided by user (e.g. `https://tax-api.example.com` or `http://localhost:3737`)
- Header: `x-api-key: <key>` (format: `txk_...`)

## Discovery
Always start by calling `GET /api/schema` to see:
- Supported form types and years
- Required vs optional fields for each form
- All available endpoints

For detailed input specs: `GET /api/schema/:form_type/:year`

## Workflow

1. **See what exists**: `GET /api/entities` — list entities and their returns
2. **Set up entity**: `POST /api/entities` if new entity needed
3. **Get data in** (choose one):
   - Upload prior returns: `GET /api/documents/presign` → upload → `POST /api/documents/register`
   - Compute from inputs: `POST /api/returns/compute`
4. **What-if scenarios**: `POST /api/scenarios` → `POST /api/scenarios/:id/compute`
5. **Compare options**: `POST /api/scenarios/compare`
6. **Finalize**: `POST /api/scenarios/:id/promote` to make a scenario the official return
7. **Get PDF**: `GET /api/returns/:id/pdf` — returns a 1-hour presigned download URL

## Validation
Before computing, call `POST /api/returns/validate` with `{ form_type, tax_year, inputs }`. It returns errors and warnings without running the engine. Relay errors to the user in plain language.

## QuickBooks Bridge
When the user has QBO connected, call `GET /api/schema/:form_type/qbo-mapping` to get P&L category → tax field mappings. Pull QBO P&L data and auto-map before asking for manual input.

## Rules
- Never fabricate financial data — ask for missing values
- Always confirm tax year before computing
- Validate before compute
- For S-Corps, shareholder percentages must sum to 100%
