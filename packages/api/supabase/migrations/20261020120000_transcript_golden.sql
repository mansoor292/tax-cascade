-- One golden IRS transcript of each kind per entity and year (2026-10-20).
--
-- Mansoor added 47 transcripts in one pull: account transcripts, return
-- transcripts and records of account (which carry both), several years
-- already holding an older pull, three identical copies of one. The review
-- read "the" transcript of a year as whichever row the database returned
-- first, so a return transcript or a stale pull could silently stand in for
-- the account transcript and blank the penalty and misposting checks.
--
-- Owner's rule: hold a single golden copy of the return transcript and of the
-- account transcript per entity and year; a newer one supersedes the older.
-- "Newer" is the IRS's response date (as_of), not the upload time — an old
-- pull uploaded late must not displace a fresh one. The rule is enforced in
-- catalog/store.ts reconcileTranscripts: a record of account counts for both
-- kinds, and loses a tie to the dedicated transcript of the same date.
-- Superseded rows are kept (superseded_by), never deleted.
--
-- Both columns are structure, not taxpayer data, so they are plaintext.

BEGIN;

ALTER TABLE "public"."return_catalog"
    ADD COLUMN IF NOT EXISTS "transcript_type" "text",
    ADD COLUMN IF NOT EXISTS "as_of" "date";

ALTER TABLE "public"."return_catalog"
    DROP CONSTRAINT IF EXISTS "return_catalog_transcript_type_check";
ALTER TABLE "public"."return_catalog"
    ADD CONSTRAINT "return_catalog_transcript_type_check" CHECK (("transcript_type" IS NULL OR "transcript_type" = ANY (ARRAY[
        'account'::"text", 'return'::"text", 'record_of_account'::"text", 'wage_income'::"text", 'other'::"text"])));

CREATE INDEX IF NOT EXISTS "return_catalog_transcript_current_idx"
    ON "public"."return_catalog" ("entity_id", "tax_year", "transcript_type")
    WHERE ("superseded_by" IS NULL AND "kind" = 'irs_transcript');

COMMIT;
