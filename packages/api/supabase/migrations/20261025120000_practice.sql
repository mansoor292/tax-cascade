-- The practice workspace: one preparer, many clients, IRS records read
-- through TaxNow.
--
-- Why (2026-10-24): the product claimed "built for accounting firms" while
-- every entity belonged to one owner and nothing grouped clients, read their
-- IRS accounts or compared them. A TaxNow prototype (one org, 45 readable
-- clients, ~2,800 account transcripts) showed what a preparer needs across
-- clients: money the IRS holds, penalties that can still come off, missing
-- returns, claims in flight, amendment candidates, risks read from the returns.
--
-- Decisions this schema encodes (Mansoor, 2026-10-24):
--  - One preparer first. practice_member exists so staff can be added later,
--    holding only the owner for now.
--  - Catipult faces TaxNow under ONE platform key (SSM, never a column here).
--    Being in that TaxNow org does not make an account anybody's client: an
--    account is read only through a practice_client row, and what is read is
--    stored against that client's own entity in that practice's account.
--  - Practices are completely isolated: two customers may hold the same EIN,
--    each with their own entity and their own copy of the IRS data. A practice
--    never links to the owner's personal entities.
--  - Each practice names its designee: the platform's CAF (practitioners with
--    none), or its own, editable in settings.
--  - Onboarding: create the client, fill an 8821, have it signed (a link the
--    practitioner copies to the client, or the owner signs their own), we
--    verify the signer, it is submitted, and a daily check marks the client
--    readable once TaxNow finds the account.
--
-- Taxpayer data is ciphertext-only (lib/row_crypto ENCRYPTED_PRACTICE_*):
-- the full TIN while onboarding is pending (wiped once readable, last four
-- kept), parsed transcripts, findings' amounts and wording, signer details.
-- Plain columns carry structure only, so listings and counts need no decrypt.

BEGIN;

-- A practice: the preparer's workspace.
CREATE TABLE IF NOT EXISTS "public"."practice" (
    "id"             "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"        "uuid" NOT NULL,
    "name"           "text" NOT NULL,
    -- 'platform' = the 8821 names Catipult's designee; 'own' = the preparer's.
    "designee_mode"  "text" DEFAULT 'platform'::"text" NOT NULL,
    -- {name, caf, ptin?, address, city, state, zip, phone, fax?} — a
    -- practitioner's public registration details, not taxpayer data.
    "designee"       "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    -- 'taxnow' = the platform TaxNow org; 'fixture' = the fictional demo
    -- practice's in-process TaxNow (never the network).
    "provider"       "text" DEFAULT 'taxnow'::"text" NOT NULL,
    "created_at"     timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"     timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "practice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "practice_user_key" UNIQUE ("user_id"),
    CONSTRAINT "practice_designee_mode_check" CHECK (("designee_mode" = ANY (ARRAY['platform'::"text", 'own'::"text"]))),
    CONSTRAINT "practice_provider_check" CHECK (("provider" = ANY (ARRAY['taxnow'::"text", 'fixture'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."practice_member" (
    "practice_id" "uuid" NOT NULL,
    "user_id"     "uuid" NOT NULL,
    "role"        "text" DEFAULT 'owner'::"text" NOT NULL,
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "practice_member_pkey" PRIMARY KEY ("practice_id", "user_id"),
    CONSTRAINT "practice_member_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'preparer'::"text", 'viewer'::"text"]))),
    CONSTRAINT "practice_member_practice_fkey" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE CASCADE
);

-- An entity belongs to a practice when it is a practice client's. The owner's
-- own pages list only entities with no practice.
ALTER TABLE "public"."tax_entity" ADD COLUMN IF NOT EXISTS "practice_id" "uuid";
ALTER TABLE "public"."tax_entity" DROP CONSTRAINT IF EXISTS "tax_entity_practice_fkey";
ALTER TABLE "public"."tax_entity" ADD CONSTRAINT "tax_entity_practice_fkey"
    FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "tax_entity_practice_idx" ON "public"."tax_entity" ("practice_id") WHERE ("practice_id" IS NOT NULL);

-- A client of a practice, from the first form to readable.
--   draft              created, 8821 not yet filled or sent
--   awaiting_signature 8821 filled, signature link out
--   signed             signed and the signer verified; ready to submit
--   submitted          sent for processing; checked daily against TaxNow
--   readable           TaxNow can read the account; transcripts are read
--   claimed            an account already in the platform org, assigned to
--                      this practice by an admin (8821 signed outside Catipult)
CREATE TABLE IF NOT EXISTS "public"."practice_client" (
    "id"                  "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "practice_id"         "uuid" NOT NULL,
    "user_id"             "uuid" NOT NULL,
    "entity_id"           "uuid" NOT NULL,
    "stage"               "text" DEFAULT 'draft'::"text" NOT NULL,
    "tin_last4"           "text",
    -- Full TIN, only while onboarding is pending. Ciphertext-only.
    "tin"                 "text",
    "tin_enc"             "bytea",
    "taxnow_account_id"   "text",
    "taxnow_client_uri"   "text",
    -- {income: [forms], payroll: [forms], from_year, to_year, year_end_month}
    "authorization_scope" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    -- Signer, ID verification, signed document id. Ciphertext-only.
    "signature"           "jsonb",
    "signature_enc"       "bytea",
    -- Per-client roll-up written by each read (balance due, credit held,
    -- deposits awaiting a return, penalties, filed-through year, next due).
    -- Amounts are taxpayer data: ciphertext-only.
    "summary"             "jsonb",
    "summary_enc"         "bytea",
    "sign_token_hash"     "text",
    "sign_token_expires"  timestamp with time zone,
    "signed_at"           timestamp with time zone,
    "submitted_at"        timestamp with time zone,
    "last_check_at"       timestamp with time zone,
    "check_count"         integer DEFAULT 0 NOT NULL,
    "readable_at"         timestamp with time zone,
    "last_read_at"        timestamp with time zone,
    "created_at"          timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"          timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "practice_client_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "practice_client_entity_key" UNIQUE ("entity_id"),
    CONSTRAINT "practice_client_stage_check" CHECK (("stage" = ANY (ARRAY['draft'::"text", 'awaiting_signature'::"text", 'signed'::"text", 'submitted'::"text", 'readable'::"text", 'claimed'::"text"]))),
    CONSTRAINT "practice_client_last4_check" CHECK (("tin_last4" IS NULL OR "tin_last4" ~ '^[0-9]{4}$')),
    CONSTRAINT "practice_client_practice_fkey" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE CASCADE,
    CONSTRAINT "practice_client_entity_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "practice_client_practice_idx" ON "public"."practice_client" ("practice_id");
CREATE UNIQUE INDEX IF NOT EXISTS "practice_client_sign_token_idx" ON "public"."practice_client" ("sign_token_hash") WHERE ("sign_token_hash" IS NOT NULL);
-- One practice holds a TaxNow account once; another practice may hold it too.
CREATE UNIQUE INDEX IF NOT EXISTS "practice_client_account_idx" ON "public"."practice_client" ("practice_id", "taxnow_account_id") WHERE ("taxnow_account_id" IS NOT NULL);

-- One IRS transcript (account or return) of a client's entity, as last read
-- from TaxNow: one row per form-period, replaced on each read. `status` is one
-- of the six answers, never merged:
--   filed / no_return_filed / activity_no_return / no_irs_account /
--   not_authorized (IRS 451) / never_synced
CREATE TABLE IF NOT EXISTS "public"."taxnow_transcript" (
    "id"                 "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"            "uuid" NOT NULL,
    "practice_client_id" "uuid" NOT NULL,
    "entity_id"          "uuid" NOT NULL,
    "type"               "text" NOT NULL,
    "form"               "text" NOT NULL,
    "tax_year"           integer NOT NULL,
    "period_month"       integer NOT NULL,
    "status"             "text" NOT NULL,
    "listed"             boolean DEFAULT true NOT NULL,
    "synced_at"          timestamp with time zone,
    "response_date"      "date",
    "source_sha256"      "text",
    -- Parsed transcript (balances, return lines, transactions). Ciphertext-only.
    "parsed"             "jsonb",
    "parsed_enc"         "bytea",
    "read_at"            timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "taxnow_transcript_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "taxnow_transcript_period_key" UNIQUE ("practice_client_id", "type", "form", "tax_year", "period_month"),
    CONSTRAINT "taxnow_transcript_type_check" CHECK (("type" = ANY (ARRAY['ACTR'::"text", 'RETR'::"text"]))),
    CONSTRAINT "taxnow_transcript_status_check" CHECK (("status" = ANY (ARRAY['filed'::"text", 'no_return_filed'::"text", 'activity_no_return'::"text", 'no_irs_account'::"text", 'not_authorized'::"text", 'never_synced'::"text"]))),
    CONSTRAINT "taxnow_transcript_client_fkey" FOREIGN KEY ("practice_client_id") REFERENCES "public"."practice_client"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "taxnow_transcript_user_idx" ON "public"."taxnow_transcript" ("user_id");

-- A finding across a client's IRS records and returns, recomputed whole on
-- every read of that client (never edited). section: income | payroll | risk.
CREATE TABLE IF NOT EXISTS "public"."practice_finding" (
    "id"                 "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"            "uuid" NOT NULL,
    "practice_id"        "uuid" NOT NULL,
    "practice_client_id" "uuid" NOT NULL,
    "section"            "text" NOT NULL,
    "type"               "text" NOT NULL,
    "severity"           "text" NOT NULL,
    "form"               "text" NOT NULL,
    "tax_year"           integer NOT NULL,
    "period_month"       integer,
    -- {amount_cents, note}. Ciphertext-only.
    "detail"             "jsonb",
    "detail_enc"         "bytea",
    "computed_at"        timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "practice_finding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "practice_finding_section_check" CHECK (("section" = ANY (ARRAY['income'::"text", 'payroll'::"text", 'risk'::"text"]))),
    CONSTRAINT "practice_finding_client_fkey" FOREIGN KEY ("practice_client_id") REFERENCES "public"."practice_client"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "practice_finding_practice_idx" ON "public"."practice_finding" ("practice_id");

-- Background work that must survive N pm2 workers (CLAUDE.md fact 3): reads
-- from TaxNow, the daily onboarding check, and IRS requests. A worker claims
-- a job with claim_taxnow_job() (FOR UPDATE SKIP LOCKED). `run_key` makes a
-- scheduled job unique (one 'daily:2026-10-25' however many workers try).
-- An IRS request ('irs_request') is a real pull under the designee's CAF and
-- carries who confirmed it.
CREATE TABLE IF NOT EXISTS "public"."taxnow_job" (
    "id"            "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"       "uuid",
    "practice_id"   "uuid",
    "kind"          "text" NOT NULL,
    "payload"       "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status"        "text" DEFAULT 'queued'::"text" NOT NULL,
    "run_key"       "text",
    "confirmed_by"  "uuid",
    "confirmed_at"  timestamp with time zone,
    "attempts"      integer DEFAULT 0 NOT NULL,
    "locked_until"  timestamp with time zone,
    "result"        "jsonb",
    "error"         "text",
    "created_at"    timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at"    timestamp with time zone,
    "finished_at"   timestamp with time zone,
    CONSTRAINT "taxnow_job_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "taxnow_job_kind_check" CHECK (("kind" = ANY (ARRAY['read_client'::"text", 'onboarding_check'::"text", 'irs_request'::"text", 'daily'::"text"]))),
    CONSTRAINT "taxnow_job_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'done'::"text", 'failed'::"text"]))),
    CONSTRAINT "taxnow_job_irs_confirmed_check" CHECK (("kind" <> 'irs_request'::"text" OR ("confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS "taxnow_job_run_key_idx" ON "public"."taxnow_job" ("run_key") WHERE ("run_key" IS NOT NULL);
CREATE INDEX IF NOT EXISTS "taxnow_job_queue_idx" ON "public"."taxnow_job" ("created_at") WHERE ("status" = 'queued'::"text");

CREATE OR REPLACE FUNCTION "public"."claim_taxnow_job"("lock_seconds" integer DEFAULT 600)
RETURNS SETOF "public"."taxnow_job"
LANGUAGE "plpgsql"
SET "search_path" TO 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE taxnow_job j SET status = 'running', attempts = j.attempts + 1, started_at = now(),
         locked_until = now() + make_interval(secs => lock_seconds)
  WHERE j.id = (
    SELECT id FROM taxnow_job
    WHERE status = 'queued' OR (status = 'running' AND locked_until < now() AND attempts < 3)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1)
  RETURNING j.*;
END;
$$;
REVOKE ALL ON FUNCTION "public"."claim_taxnow_job"(integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."claim_taxnow_job"(integer) TO "service_role";

-- Row-level security: each row is its user's.
ALTER TABLE "public"."practice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."practice_member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."practice_client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."taxnow_transcript" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."practice_finding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."taxnow_job" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "practice_own" ON "public"."practice" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "practice_member_own" ON "public"."practice_member" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "practice_client_own" ON "public"."practice_client" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "taxnow_transcript_own" ON "public"."taxnow_transcript" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "practice_finding_own" ON "public"."practice_finding" TO authenticated
    USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
-- Jobs are the server's: no policy, service role only.

GRANT ALL ON TABLE "public"."practice" TO "authenticated", "service_role";
GRANT ALL ON TABLE "public"."practice_member" TO "authenticated", "service_role";
GRANT ALL ON TABLE "public"."practice_client" TO "authenticated", "service_role";
GRANT ALL ON TABLE "public"."taxnow_transcript" TO "authenticated", "service_role";
GRANT ALL ON TABLE "public"."practice_finding" TO "authenticated", "service_role";
GRANT ALL ON TABLE "public"."taxnow_job" TO "service_role";

COMMIT;
