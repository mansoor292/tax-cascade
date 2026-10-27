-- A practice whose clients come from an imported transaction export, and the
-- review tools for its findings.
--
-- Why (2026-10-26): Kenneth (TaxNow's owner) handed over an export of his
-- book — 8,834 clients known only by number, ~845,000 IRS transactions — as
-- prospects he will bring in under his own id. Mansoor: "for now just set it
-- up as an account." There is no 8821 with us, so:
--   - the practice's provider is 'import' and its clients' stage 'imported':
--     never read through TaxNow, never an IRS request, never in the daily
--     run (which takes submitted/readable/claimed only). The rule that a
--     practice reads an account only on its own 8821 stays whole for everyone
--     else.
--   - each client is keyed by the export's client number (import_key), so a
--     later export, or his API with a mapping found later, attaches to it.
--   - a refresh is a new import: replace per client number, recompute, and
--     record what changed (practice_run.changes).
--
-- At this size (100,825 periods) analysis runs in batches of clients, each a
-- taxnow_job (CLAUDE.md fact 3: no in-process state); a practice_run row
-- ties the batches together and its progress is read from them.
--
-- Findings carry the rules version they were computed under, and a reviewer's
-- verdict (valid / not valid / unsure) is kept per finding in a table of its
-- own, keyed so it survives the findings being recomputed. The key holds no
-- amounts; the reviewer's note is ciphertext-only.

BEGIN;

ALTER TABLE "public"."practice" DROP CONSTRAINT IF EXISTS "practice_provider_check";
ALTER TABLE "public"."practice" ADD CONSTRAINT "practice_provider_check"
    CHECK (("provider" = ANY (ARRAY['taxnow'::"text", 'fixture'::"text", 'import'::"text"])));

ALTER TABLE "public"."practice_client" DROP CONSTRAINT IF EXISTS "practice_client_stage_check";
ALTER TABLE "public"."practice_client" ADD CONSTRAINT "practice_client_stage_check"
    CHECK (("stage" = ANY (ARRAY['draft'::"text", 'awaiting_signature'::"text", 'signed'::"text", 'submitted'::"text", 'readable'::"text", 'claimed'::"text", 'imported'::"text"])));
ALTER TABLE "public"."practice_client"
    -- The client's number in the export it came from. Not a TIN: the export carries none.
    ADD COLUMN IF NOT EXISTS "import_key" "text",
    -- The import that last wrote this client; one not in the latest import is kept, not deleted.
    ADD COLUMN IF NOT EXISTS "import_run_id" "uuid";
CREATE UNIQUE INDEX IF NOT EXISTS "practice_client_import_key_idx" ON "public"."practice_client" ("practice_id", "import_key") WHERE ("import_key" IS NOT NULL);

-- The seventh status, imports only: the export lists the period with nothing in it.
ALTER TABLE "public"."taxnow_transcript" DROP CONSTRAINT IF EXISTS "taxnow_transcript_status_check";
ALTER TABLE "public"."taxnow_transcript" ADD CONSTRAINT "taxnow_transcript_status_check"
    CHECK (("status" = ANY (ARRAY['filed'::"text", 'no_return_filed'::"text", 'activity_no_return'::"text", 'no_irs_account'::"text", 'not_authorized'::"text", 'never_synced'::"text", 'no_transactions'::"text"])));
CREATE INDEX IF NOT EXISTS "taxnow_transcript_client_idx" ON "public"."taxnow_transcript" ("practice_client_id");

ALTER TABLE "public"."practice_finding" ADD COLUMN IF NOT EXISTS "rules_version" "text";
CREATE INDEX IF NOT EXISTS "practice_finding_client_idx" ON "public"."practice_finding" ("practice_client_id");

-- One import of an export, or one re-run of the analysis, over a practice.
--   kind    'import' (a file) | 'analysis' (recompute from what is stored)
--   status  uploading → queued → running → done | failed
-- `stats` and `changes` are counts only (rows, periods, findings new/gone per
-- type): no taxpayer amounts, so they need no encryption.
CREATE TABLE IF NOT EXISTS "public"."practice_run" (
    "id"             "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "practice_id"    "uuid" NOT NULL,
    "user_id"        "uuid" NOT NULL,
    "kind"           "text" NOT NULL,
    "status"         "text" DEFAULT 'queued'::"text" NOT NULL,
    "file_name"      "text",
    "s3_key"         "text",
    "bytes"          bigint,
    "sha256"         "text",
    "as_of"          "date",
    "rules_version"  "text" NOT NULL,
    "stats"          "jsonb",
    "batches_total"  integer,
    "changes"        "jsonb",
    "error"          "text",
    "created_by"     "uuid" NOT NULL,
    "created_at"     timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at"     timestamp with time zone,
    "finished_at"    timestamp with time zone,
    CONSTRAINT "practice_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "practice_run_kind_check" CHECK (("kind" = ANY (ARRAY['import'::"text", 'analysis'::"text"]))),
    CONSTRAINT "practice_run_status_check" CHECK (("status" = ANY (ARRAY['uploading'::"text", 'queued'::"text", 'running'::"text", 'done'::"text", 'failed'::"text"]))),
    CONSTRAINT "practice_run_practice_fkey" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "practice_run_practice_idx" ON "public"."practice_run" ("practice_id", "created_at" DESC);

-- A reviewer's verdict on one finding. finding_key = type|form|year|month|TC
-- (the penalty's code where there is one), stable across recomputes and
-- re-imports; it holds no amount. The amount the verdict was given on rides
-- in the detail's ciphertext, so a changed amount can be shown as such.
CREATE TABLE IF NOT EXISTS "public"."practice_finding_verdict" (
    "id"                 "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "practice_id"        "uuid" NOT NULL,
    "user_id"            "uuid" NOT NULL,
    "practice_client_id" "uuid" NOT NULL,
    "finding_key"        "text" NOT NULL,
    "verdict"            "text" NOT NULL,
    -- {note, amount_cents}. Ciphertext-only.
    "detail"             "jsonb",
    "detail_enc"         "bytea",
    "rules_version"      "text",
    "decided_by"         "uuid" NOT NULL,
    "decided_at"         timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "practice_finding_verdict_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "practice_finding_verdict_key" UNIQUE ("practice_client_id", "finding_key"),
    CONSTRAINT "practice_finding_verdict_check" CHECK (("verdict" = ANY (ARRAY['valid'::"text", 'invalid'::"text", 'unsure'::"text"]))),
    CONSTRAINT "practice_finding_verdict_client_fkey" FOREIGN KEY ("practice_client_id") REFERENCES "public"."practice_client"("id") ON DELETE CASCADE,
    CONSTRAINT "practice_finding_verdict_practice_fkey" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "practice_finding_verdict_practice_idx" ON "public"."practice_finding_verdict" ("practice_id");

ALTER TABLE "public"."taxnow_job" DROP CONSTRAINT IF EXISTS "taxnow_job_kind_check";
ALTER TABLE "public"."taxnow_job" ADD CONSTRAINT "taxnow_job_kind_check"
    CHECK (("kind" = ANY (ARRAY['read_client'::"text", 'onboarding_check'::"text", 'irs_request'::"text", 'daily'::"text", 'import_start'::"text", 'import_batch'::"text", 'analysis_batch'::"text"])));
CREATE INDEX IF NOT EXISTS "taxnow_job_run_idx" ON "public"."taxnow_job" ((("payload" ->> 'run_id'))) WHERE (("payload" ->> 'run_id') IS NOT NULL);

-- Period statuses per client, counted in the database and returned as ONE
-- jsonb {client id: {status: n}}: an imported practice has ~100,000 periods,
-- and a set of rows would be cut at PostgREST's 1,000-row page.
CREATE OR REPLACE FUNCTION "public"."practice_status_counts"("p_practice" "uuid")
RETURNS "jsonb"
LANGUAGE "sql" STABLE
SET "search_path" TO 'public'
AS $$
  SELECT COALESCE(jsonb_object_agg(cid, counts), '{}'::jsonb) FROM (
    SELECT cid, jsonb_object_agg(status, n) AS counts FROM (
      SELECT t.practice_client_id AS cid, t.status, COUNT(*) AS n
      FROM taxnow_transcript t JOIN practice_client c ON c.id = t.practice_client_id
      WHERE c.practice_id = p_practice AND t.type = 'ACTR'
      GROUP BY 1, 2) s
    GROUP BY cid) x
$$;
REVOKE ALL ON FUNCTION "public"."practice_status_counts"("uuid") FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."practice_status_counts"("uuid") TO "service_role";

ALTER TABLE "public"."practice_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."practice_finding_verdict" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "practice_run_own" ON "public"."practice_run" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "practice_finding_verdict_own" ON "public"."practice_finding_verdict" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
GRANT ALL ON TABLE "public"."practice_run" TO "authenticated", "service_role";
GRANT ALL ON TABLE "public"."practice_finding_verdict" TO "authenticated", "service_role";

COMMIT;
