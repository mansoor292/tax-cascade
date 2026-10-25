-- How a signed 8821 goes in (Mansoor, 2026-10-25): the signer is verified
-- first, then draws a signature; the signed copy is kept (encrypted, in S3,
-- referenced from the encrypted practice_client.signature); Catipult staff
-- send it to TaxNow's staff, who submit it to the IRS, and record TaxNow's
-- confirmation. That confirmation is what writes submission_confirmed_at
-- (20261026120000_practice_own_8821.sql) — never the preparer.
--
-- `submission` holds who sent it, to whom, when, and who recorded the
-- confirmation: staff user ids, a mailbox address and a note. No taxpayer
-- data, so it is a plain column.

BEGIN;

ALTER TABLE "public"."practice_client"
    ADD COLUMN IF NOT EXISTS "submission" "jsonb";

COMMIT;
