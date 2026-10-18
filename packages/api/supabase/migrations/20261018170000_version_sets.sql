-- Version sets: restatement packages across the group, each of which must tie.
--
-- Why (2026-10-18): the owner's rule is that every set of returns must tie
-- internally. That covers what is filed with the IRS ("filed") and each
-- restatement package being prepared (v1, v2, ...). A break, where one return
-- disagrees with another or with itself, is an open item. Amendments had been
-- prepared one return at a time, as scenarios, and were deleted and restarted
-- more than once. Nothing checked that a package of amended returns agreed
-- with the returns it left alone: amending EV's 2023 receipts without EZA's
-- deduction just moves the break.
--
-- version_set   a named package (label v1, v2, ...): draft while being
--               prepared, filed once sent, abandoned if dropped. "filed" is
--               not a row; it is the original returns plus every filed set.
-- return_version one amended return in a set: the lines it changes (form,
--               line, column, new value, reason), and for a change that moves
--               an intercompany amount, the fact it moves. The full return of
--               the version is the filed catalog with these changes applied
--               (review/versions.ts), so every tie check runs on it unchanged.
--
-- A draft set's versions are working papers and are edited in place. Once the
-- set is filed or abandoned it is frozen (enforced in services/versions.ts).
-- Titles, descriptions, change lists and notes quote amounts and reasons, so
-- they are written ciphertext-only (lib/row_crypto ENCRYPTED_SET_FIELDS /
-- ENCRYPTED_VERSION_FIELDS).
--
-- review_run.version_set records which view a run checked ('filed' or a set label).

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."version_set" (
    "id"              "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"         "uuid" NOT NULL,
    "label"           "text" NOT NULL,
    "title"           "text",
    "title_enc"       "bytea",
    "description"     "text",
    "description_enc" "bytea",
    "status"          "text" DEFAULT 'draft'::"text" NOT NULL,
    "filed_on"        "date",
    "recorded_by"     "text",
    "created_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "version_set_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "version_set_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'filed'::"text", 'abandoned'::"text"]))),
    CONSTRAINT "version_set_label_check" CHECK (("label" ~ '^[a-z0-9][a-z0-9._-]{0,31}$' AND "label" <> 'filed')),
    CONSTRAINT "version_set_label_key" UNIQUE ("user_id", "label")
);
ALTER TABLE "public"."version_set" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."return_version" (
    "id"            "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"       "uuid" NOT NULL,
    "set_id"        "uuid" NOT NULL,
    "entity_id"     "uuid" NOT NULL,
    "tax_year"      integer NOT NULL,
    "form"          "text",
    "changes"       "jsonb",
    "changes_enc"   "bytea",
    "note"          "text",
    "note_enc"      "bytea",
    "tax_return_id" "uuid",
    "catalog_id"    "uuid",
    "recorded_by"   "text",
    "created_at"    timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"    timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "return_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "return_version_one_per_return" UNIQUE ("set_id", "entity_id", "tax_year"),
    CONSTRAINT "return_version_set_id_fkey" FOREIGN KEY ("set_id")
        REFERENCES "public"."version_set"("id") ON DELETE CASCADE,
    CONSTRAINT "return_version_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "return_version_tax_return_id_fkey" FOREIGN KEY ("tax_return_id")
        REFERENCES "public"."tax_return"("id") ON DELETE SET NULL,
    CONSTRAINT "return_version_catalog_id_fkey" FOREIGN KEY ("catalog_id")
        REFERENCES "public"."return_catalog"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."return_version" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "return_version_set_idx" ON "public"."return_version" ("set_id");
CREATE INDEX IF NOT EXISTS "return_version_entity_idx" ON "public"."return_version" ("entity_id", "tax_year");

ALTER TABLE "public"."review_run" ADD COLUMN IF NOT EXISTS "version_set" "text" DEFAULT 'filed'::"text" NOT NULL;
CREATE INDEX IF NOT EXISTS "review_run_version_set_idx"
    ON "public"."review_run" ("entity_id", "tax_year", "version_set", "started_at" DESC);

ALTER TABLE "public"."version_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."return_version" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "version_set_select_own" ON "public"."version_set" FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "version_set_insert_own" ON "public"."version_set" FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "version_set_update_own" ON "public"."version_set" FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "return_version_select_own" ON "public"."return_version" FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "return_version_insert_own" ON "public"."return_version" FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "return_version_update_own" ON "public"."return_version" FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"()) WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "return_version_delete_own" ON "public"."return_version" FOR DELETE TO authenticated USING ("user_id" = "auth"."uid"());

GRANT ALL ON TABLE "public"."version_set" TO "anon";
GRANT ALL ON TABLE "public"."version_set" TO "authenticated";
GRANT ALL ON TABLE "public"."version_set" TO "service_role";
GRANT ALL ON TABLE "public"."return_version" TO "anon";
GRANT ALL ON TABLE "public"."return_version" TO "authenticated";
GRANT ALL ON TABLE "public"."return_version" TO "service_role";

COMMIT;
