-- Review runs and finding resolutions.
--
-- Why (2026-10-17): every conversation about the Edgewater returns turned up
-- something new, months apart, depending on which question was asked. The
-- owner's requirement: every return type goes through a FIXED framework of
-- checks (src/review/framework.ts), and the results are STORED, so the next
-- run says what changed and why — a new document, a new fact, a framework
-- change, or a genuine miss — instead of rediscovering things.
--
-- review_run: one row per (entity, tax year) run. Findings quote amounts from
-- the return, so they are written ciphertext-only (findings_enc); `summary`
-- holds counts only.
-- review_resolution: what the owner decided about a finding (fixed, accepted,
-- not an issue), keyed by the finding's stable fingerprint so it survives
-- later runs. Superseded, never overwritten.

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."review_run" (
    "id"                "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"           "uuid" NOT NULL,
    "entity_id"         "uuid" NOT NULL,
    "tax_year"          integer NOT NULL,
    "framework_version" "text" NOT NULL,
    "status"            "text" DEFAULT 'running'::"text" NOT NULL,
    "ai"                boolean DEFAULT false NOT NULL,
    "started_at"        timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at"       timestamp with time zone,
    "catalog_ids"       "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "facts_at"          timestamp with time zone,
    "summary"           "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "findings"          "jsonb",
    "findings_enc"      "bytea",
    "error"             "text",
    "previous_run_id"   "uuid",
    CONSTRAINT "review_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_run_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'done'::"text", 'failed'::"text"]))),
    CONSTRAINT "review_run_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "review_run_previous_run_id_fkey" FOREIGN KEY ("previous_run_id")
        REFERENCES "public"."review_run"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."review_run" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "review_run_entity_year_idx"
    ON "public"."review_run" ("entity_id", "tax_year", "started_at" DESC);

CREATE TABLE IF NOT EXISTS "public"."review_resolution" (
    "id"            "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"       "uuid" NOT NULL,
    "entity_id"     "uuid" NOT NULL,
    "fingerprint"   "text" NOT NULL,
    "check_id"      "text" NOT NULL,
    "resolution"    "text" NOT NULL,
    "note"          "text",
    "note_enc"      "bytea",
    "resolved_by"   "text",
    "resolved_at"   timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by" "uuid",
    CONSTRAINT "review_resolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_resolution_check" CHECK (("resolution" = ANY (ARRAY['fixed'::"text", 'accepted'::"text", 'not_an_issue'::"text", 'reopened'::"text"]))),
    CONSTRAINT "review_resolution_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "review_resolution_superseded_by_fkey" FOREIGN KEY ("superseded_by")
        REFERENCES "public"."review_resolution"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."review_resolution" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "review_resolution_current_idx"
    ON "public"."review_resolution" ("entity_id", "fingerprint")
    WHERE ("superseded_by" IS NULL);

ALTER TABLE "public"."review_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."review_resolution" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "review_run_select_own" ON "public"."review_run"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "review_run_insert_own" ON "public"."review_run"
    FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "review_run_update_own" ON "public"."review_run"
    FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"())
    WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "review_run_delete_own" ON "public"."review_run"
    FOR DELETE TO authenticated USING ("user_id" = "auth"."uid"());

CREATE POLICY "review_resolution_select_own" ON "public"."review_resolution"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "review_resolution_insert_own" ON "public"."review_resolution"
    FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());

GRANT ALL ON TABLE "public"."review_run" TO "anon";
GRANT ALL ON TABLE "public"."review_run" TO "authenticated";
GRANT ALL ON TABLE "public"."review_run" TO "service_role";
GRANT ALL ON TABLE "public"."review_resolution" TO "anon";
GRANT ALL ON TABLE "public"."review_resolution" TO "authenticated";
GRANT ALL ON TABLE "public"."review_resolution" TO "service_role";

COMMIT;
