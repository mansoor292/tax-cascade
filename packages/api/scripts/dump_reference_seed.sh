#!/usr/bin/env bash
# Regenerate supabase/seed.sql from the linked remote project.
#
# Reference data only — field_map (PDF field labels) + form_discovery (textract
# outputs). User-scoped tables are explicitly excluded. Run after bulk updates
# to either table so branch-created dev environments pick up fresh seed data.
#
# Requires: docker running (supabase CLI uses a containerized pg_dump 17).
set -euo pipefail

cd "$(dirname "$0")/.."

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Dump every public + system table, then filter to just the two reference
# tables. Simpler than -x-listing every user table by name.
supabase db dump --data-only -f "$TMP" \
  -x public.tax_entity \
  -x public.tax_return \
  -x public.tax_return_form \
  -x public.tax_audit_log \
  -x public.document \
  -x public.scenario \
  -x public.qbo_connection \
  -x public.qbo_report \
  -x public.stripe_connection \
  -x public.api_key \
  -x public.user_profile \
  -x public.user_key \
  -x public.user_roles \
  -x public.system_prompts \
  -x public.coaches \
  -x public.coach_custom_prompts \
  -x public.coach_documents \
  -x public.coach_document_embeddings \
  -x public.generated_content \
  -x public.video_content \
  -x public.conversations \
  -x public.nol_schedule \
  -x public.shareholder_basis

# Extract only the public.field_map and public.form_discovery INSERT blocks.
# Everything else (auth.*, storage.*) is dropped — those contain real user
# sessions and must never land in git.
FM_START=$(grep -n '^INSERT INTO "public"\."field_map"'       "$TMP" | head -1 | cut -d: -f1)
FD_START=$(grep -n '^INSERT INTO "public"\."form_discovery"' "$TMP" | head -1 | cut -d: -f1)
FD_END=$((FD_START))
# form_discovery INSERT runs until the next line starting with "INSERT INTO" or blank-line boundary
while IFS= read -r line && (( FD_END < $(wc -l < "$TMP") )); do
  FD_END=$((FD_END + 1))
  next=$(sed -n "${FD_END}p" "$TMP")
  if [[ "$next" == "INSERT INTO"* || "$next" == "--"* ]]; then
    FD_END=$((FD_END - 1))
    break
  fi
done < "$TMP"

{
  echo '--'
  echo '-- Reference data seed for fresh Supabase environments (dev branches, local).'
  echo '-- Only contains non-user tables: field_map (PDF field labels) and form_discovery'
  echo '-- (per-form textract outputs). User-scoped tables are intentionally excluded.'
  echo '-- Regenerate with: scripts/dump_reference_seed.sh'
  echo '--'
  echo ''
  echo 'SET session_replication_role = replica;'
  echo 'SET statement_timeout = 0;'
  echo "SET client_encoding = 'UTF8';"
  echo ''
  sed -n "${FM_START},$((FD_START - 1))p" "$TMP"
  echo ''
  sed -n "${FD_START},${FD_END}p" "$TMP"
  echo ''
  echo 'RESET session_replication_role;'
} > supabase/seed.sql

echo "Wrote $(wc -l < supabase/seed.sql) lines to supabase/seed.sql"
echo "  field_map rows:      $(sed -n "${FM_START},$((FD_START - 1))p" "$TMP" | grep -c '^\t(')"
echo "  form_discovery rows: $(sed -n "${FD_START},${FD_END}p" "$TMP" | grep -c '^\t(')"
