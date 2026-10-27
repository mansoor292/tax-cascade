-- A test client: a practice's way to walk the whole signing flow without a
-- real signer.
--
-- Why (2026-10-27): Mansoor tried the BCL practice's signature link with a
-- made-up SSN. Real practices run Didit live, where a made-up SSN can never
-- pass (that is the check), so the flow could not be shown end to end. A
-- test client runs its identity and membership checks in Didit's sandbox,
-- its 8821 is stamped TEST — NOT FOR FILING, the signature page lets the
-- signer approve the sandbox check and shows the signed copy at the end, and
-- the daily check never looks for it at TaxNow.

BEGIN;
ALTER TABLE "public"."practice_client" ADD COLUMN IF NOT EXISTS "test" boolean DEFAULT false NOT NULL;
COMMIT;
