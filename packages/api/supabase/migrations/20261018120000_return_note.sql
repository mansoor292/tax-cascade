-- Return notes: the open information about a return that is neither a
-- registry fact nor a review finding.
--
-- Why (2026-10-18): auditing what the MCP knew against what a working session
-- knew showed the catalog had every document right, while the open threads
-- lived only in conversation and were lost when a session ended. Examples: a
-- payroll refund check whose receipt was unconfirmed, refund interest the IRS
-- may owe, a misposting the representative still had to call about, and
-- whether a related company's return was filed at all. A note is one such
-- thread, scoped to a return (entity + tax year) or to the entity when no
-- year applies. It says who it is waiting on and is open, closed, or
-- standing context.
--
-- Notes are versioned like tax_fact: an edit inserts a new version with the
-- same note_key and points the old one at it, so what was believed and when
-- is never lost. title/body name people and amounts, so they are written
-- ciphertext-only (title_enc/body_enc, lib/row_crypto ENCRYPTED_NOTE_FIELDS).

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."return_note" (
    "id"                  "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "note_key"            "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"             "uuid" NOT NULL,
    "entity_id"           "uuid" NOT NULL,
    "tax_year"            integer,
    "status"              "text" DEFAULT 'open'::"text" NOT NULL,
    "waiting_on"          "text",
    "title"               "text",
    "title_enc"           "bytea",
    "body"                "text",
    "body_enc"            "bytea",
    "fact_key"            "text",
    "finding_fingerprint" "text",
    "due_date"            "date",
    "recorded_by"         "text",
    "recorded_at"         timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by"       "uuid",
    CONSTRAINT "return_note_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "return_note_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text", 'info'::"text"]))),
    CONSTRAINT "return_note_waiting_on_check" CHECK (("waiting_on" IS NULL OR "waiting_on" = ANY (ARRAY['owner'::"text", 'irs'::"text", 'preparer'::"text", 'agent'::"text", 'third_party'::"text"]))),
    CONSTRAINT "return_note_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "return_note_superseded_by_fkey" FOREIGN KEY ("superseded_by")
        REFERENCES "public"."return_note"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."return_note" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "return_note_current_idx"
    ON "public"."return_note" ("entity_id", "tax_year")
    WHERE ("superseded_by" IS NULL);
CREATE INDEX IF NOT EXISTS "return_note_key_idx"
    ON "public"."return_note" ("note_key", "recorded_at" DESC);

ALTER TABLE "public"."return_note" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "return_note_select_own" ON "public"."return_note"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "return_note_insert_own" ON "public"."return_note"
    FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "return_note_update_own" ON "public"."return_note"
    FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"())
    WITH CHECK ("user_id" = "auth"."uid"());

GRANT ALL ON TABLE "public"."return_note" TO "anon";
GRANT ALL ON TABLE "public"."return_note" TO "authenticated";
GRANT ALL ON TABLE "public"."return_note" TO "service_role";

COMMIT;
