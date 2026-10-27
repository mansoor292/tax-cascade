-- Which TaxNow org a practice reads through.
--
-- Why (2026-10-27): the Better Choice Lenders TaxNow org has its own API key
-- and its own clients — accounts in one org answer 403 to another org's key —
-- and Mansoor wanted it brought in as a practice of its own, under its own
-- login, readable over MCP. One org per practice still holds; a practice now
-- names its org instead of every practice sharing the platform's.
--
-- Only the NAME lives here. 'platform' is the org Catipult faces TaxNow under
-- (SSM TAXNOW_API_KEY / TAXNOW_ORG_ID); any other name reads
-- TAXNOW_API_KEY_<NAME> / TAXNOW_ORG_ID_<NAME> from SSM (taxnow/client.ts
-- orgCredentials). A key is never a column.

BEGIN;

ALTER TABLE "public"."practice" ADD COLUMN IF NOT EXISTS "taxnow_org" "text" DEFAULT 'platform'::"text" NOT NULL;
ALTER TABLE "public"."practice" DROP CONSTRAINT IF EXISTS "practice_taxnow_org_check";
ALTER TABLE "public"."practice" ADD CONSTRAINT "practice_taxnow_org_check" CHECK (("taxnow_org" ~ '^[a-z][a-z0-9_]{0,31}$'::"text"));

COMMIT;
