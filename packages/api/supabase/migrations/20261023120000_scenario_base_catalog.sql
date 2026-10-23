-- A scenario's base can be a filed return held only in the catalog (2026-10-23).
--
-- Owner's rule (2026-10-22): a scenario defaults to the best base, normally the
-- filed return. base_return_id can only name a tax_return row, and a filed
-- return catalogued straight from its PDF (the group's 2025 returns, filed
-- 10/14) has none, so the Scenarios form fell back to the draft. The catalogued
-- return is named here instead; the compute maps its golden values back to
-- engine inputs, as an amendment's base is (services/amendment_base.ts).
--
-- An id, not taxpayer data: plaintext.

BEGIN;

ALTER TABLE "public"."scenario"
    ADD COLUMN IF NOT EXISTS "base_catalog_id" "uuid";

ALTER TABLE "public"."scenario"
    DROP CONSTRAINT IF EXISTS "scenario_base_catalog_id_fkey";
ALTER TABLE "public"."scenario"
    ADD CONSTRAINT "scenario_base_catalog_id_fkey" FOREIGN KEY ("base_catalog_id") REFERENCES "public"."return_catalog"("id") ON DELETE SET NULL;

COMMIT;
