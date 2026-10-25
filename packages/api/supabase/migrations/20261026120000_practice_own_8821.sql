-- A practice reads an account only on its own 8821 (Mansoor, 2026-10-25).
--
-- Every 8821 names the platform's one CAF, so TaxNow finding a TIN proves
-- only that SOMEONE's 8821 is on file: practice B could enter an EIN that
-- practice A onboarded and be handed A's account. Now a client becomes
-- readable only when its own signed, ID-verified 8821 accounts for the
-- account (services/practice.ts readableVerdict); admin-claimed accounts
-- (stage 'claimed', 8821s signed before Catipult) keep standing as they are.
-- Catipult's own client lifecycle decides when a read stops; nothing here
-- watches TaxNow for revoked authorizations.
--
-- Plain columns: dates and TaxNow account ids, no taxpayer data.

BEGIN;

ALTER TABLE "public"."practice_client"
    -- The TaxNow accounts the platform org listed when this client was
    -- submitted. If the client's account is among them, someone else's 8821
    -- put it there. Cleared once the client is readable.
    ADD COLUMN IF NOT EXISTS "accounts_at_submit"      "text"[],
    -- Written by the submission channel once it has proof that THIS 8821
    -- reached the IRS. Required when the account predates the submission or
    -- another practice holds it. Never set by the preparer.
    ADD COLUMN IF NOT EXISTS "submission_confirmed_at" timestamp with time zone;

COMMIT;
