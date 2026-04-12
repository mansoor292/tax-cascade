# Tax API — IRS Form Engine & PDF Pipeline

Computes, fills, and validates IRS tax returns programmatically.

## Architecture

```
Textract (OCR)  →  Fuzzy Mapper  →  Canonical Model  →  Tax Engine  →  PDF Fill
   intake/            intake/         (structured)        engine/       builders/
```

**Key principle:** Fuzzy logic on intake (OCR is messy), deterministic on output (PDF field IDs are exact).

## Directory Structure

```
tax-api/
├── src/
│   ├── engine/           # Tax computation
│   │   ├── tax_engine.ts   # calc1120, calc1120S, calc1040, calcCascade
│   │   └── tax_tables.ts   # IRS brackets/thresholds 2020-2025
│   ├── intake/           # Data extraction
│   │   ├── json_model_mapper.ts  # Textract/Gemini/QBO → canonical model
│   │   └── textract_verify.ts    # Round-trip verification utility
│   ├── maps/             # PDF field mappings (deterministic)
│   │   ├── field_maps.ts          # Loader + API for field maps
│   │   ├── pdf_field_map_2024.ts  # Canonical → field ID (2024 forms)
│   │   └── pdf_field_map_2025.ts  # Canonical → field ID (2025 forms)
│   ├── builders/         # PDF fill + package assembly
│   │   └── pdf_filler.ts          # Shared fill utilities
│   └── index.ts          # Barrel export
├── data/
│   ├── field_maps/       # Textract-verified JSON maps (per form per year)
│   │   ├── f1040_2025_fields.json
│   │   ├── f1120_2025_fields.json
│   │   ├── f1120s_2025_fields.json
│   │   └── ... (13 forms total)
│   └── irs_forms/        # Blank IRS PDF forms (2020-2025, 54 forms)
├── output/               # Generated PDFs (gitignored)
│   ├── 2025/verify/        # Per-form Textract-verified outputs
│   └── ...
└── irs_xfa_map.json      # XFA field position data (supplementary)
```

## Verified Forms (2025)

| # | Form | Fields | Textract Verified |
|---|------|--------|-------------------|
| 1 | Form 1040 | 88 | 23 values ✓ |
| 2 | Schedule 1 | 60 | 2 values ✓ |
| 3 | Schedule 2 | 45 | 3 values ✓ |
| 4 | Schedule B | 24 | 3 values ✓ |
| 5 | Schedule D | 11 | 2 values ✓ |
| 6 | Schedule E | 34 | 3 values ✓ |
| 7 | Form 8959 | 26 | 8 values ✓ |
| 8 | Form 8960 | 35 | 9 values ✓ |
| 9 | Form 8995-A | 14 | 7 values ✓ |
| 10 | Form 7203 | 34 | 12 values ✓ |
| 11 | Form 1120 | 130 | 17+ values ✓ |
| 12 | Form 1120-S | 116 | 13 values ✓ |
| 13 | Form 1125-A | 12 | 4 values ✓ |
| 14 | Schedule K-1 | 23 | verified ✓ |

## Verification Process

Every field mapping is confirmed by this process:

1. **Label**: Print each field's ID (`f1_47`, `f2_03`, etc.) into its position on the blank form
2. **Upload**: Send labeled PDF to AWS Textract
3. **Read**: Textract reports which form label each field ID sits next to
4. **Map**: field_id → form_label mapping saved to JSON
5. **Fill**: Use the verified map to fill actual values
6. **Validate**: Send filled PDF back to Textract, compare extracted values against expected

## Usage

```typescript
import { calc1120S } from './src/engine/tax_engine.js'
import { fillFromMap, loadBlankForm } from './src/builders/pdf_filler.js'
import { F1120S_2025 } from './src/maps/pdf_field_map_2025.js'

// 1. Compute
const result = calc1120S({ gross_receipts: 2_169_999, ... })

// 2. Fill
const pdf = await loadBlankForm('f1120s', 2025)
const form = pdf.getForm()
fillFromMap(form, F1120S_2025, {
  'income.L1a_gross_receipts': 2_169_999,
  'tax.L22_ordinary_income': result.computed.ordinary_income_loss,
  ...
})

// 3. Save
writeFileSync('output/1120S_2025.pdf', await pdf.save())
```

## Entities

| Entity | Form | EIN |
|--------|------|-----|
| Edgewater Ventures Inc | 1120 (C-Corp) | 83-1889553 |
| Edgewater Investments Inc (EZ-Advisors) | 1120-S (S-Corp) | 87-3340910 |
| Mansoor & Ingrid Razzaq | 1040 (MFJ) | 597-09-1708 |
