#!/bin/bash
# Recompute all 2024 returns via the live API — picks up engine fixes + QBO auto-pull
API=http://13.223.50.81:3737
KEY=txk_999fb6a457964ca0b66d556c

compute() {
  local entity_id=$1 tax_year=$2 form_type=$3 return_id=$4
  echo "--- Recomputing $form_type $tax_year (entity $entity_id) ---"

  # Pull existing inputs
  INPUTS=$(curl -s -H "x-api-key: $KEY" "$API/api/returns/$return_id" | python3 -c "import json,sys; r=json.load(sys.stdin)['return']; print(json.dumps(r.get('input_data',{})))")

  # POST to /compute with those inputs
  curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    "$API/api/returns/compute" \
    -d "{\"entity_id\":\"$entity_id\",\"tax_year\":$tax_year,\"form_type\":\"$form_type\",\"inputs\":$INPUTS,\"save\":true}" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'error' in d: print(f'  ERROR: {d[\"error\"]}')
else:
    c = d.get('computed', {})
    print(f'  saved: {d.get(\"saved\")}')
    print(f'  coverage: {d.get(\"pdf_coverage\",{}).get(\"pct\",\"?\")}%  ({d.get(\"pdf_coverage\",{}).get(\"filled\",\"?\")}/{d.get(\"pdf_coverage\",{}).get(\"total\",\"?\")})')
    print(f'  total_tax: {c.get(\"total_tax\", \"?\")}')
"
  echo ""
}

compute 7182b3e4-1b24-4756-8a6b-20d2cc54f59f 2024 1120  85f9ad1b-d705-44db-9da5-fed092ef8d4e
compute fc3589ea-8b79-4c4b-b843-79dc241a007a 2024 1120S 27acbe8c-4037-4474-b554-49f47b57227a
compute 463be538-88c1-4a1d-8ddb-60d5201a0315 2024 1120  eab4606e-8f81-4a90-b00e-e85faf6d6a9b
compute c256eac9-bb9b-4cf3-af6c-f88fa6cc08f6 2024 1040  d188a94c-d459-4535-9400-ab45db5e8a46
