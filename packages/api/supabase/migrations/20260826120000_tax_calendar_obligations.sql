-- Tax calendar: per-entity filing and payment obligations.
--
-- Rows are DERIVED, not authored. src/engine/tax_calendar.ts generates the
-- full set from the entity's form type, state and filed extensions; the
-- refresh endpoint upserts them on `obligation_key`. The user-owned columns
-- (status, completed_at, amount, notes) are never overwritten by a refresh,
-- so marking something done survives regeneration.
--
-- source='custom' rows are authored by the user (an insurance renewal, a
-- board meeting) and are never touched by refresh.
--
-- Scoping follows the entity-scoped pattern from
-- 20260423181844_enforce_user_scoped_rls.sql: user_id is denormalized onto
-- the row so RLS is a single-hop check, matching `document` and `scenario`.

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."obligation" (
    "id"             "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"        "uuid" NOT NULL,
    "entity_id"      "uuid" NOT NULL,
    -- Natural key from the generator. Stable across refreshes.
    "obligation_key" "text" NOT NULL,
    "source"         "text" DEFAULT 'generated'::"text" NOT NULL,
    "kind"           "text" NOT NULL,
    "title"          "text" NOT NULL,
    "due_date"       "date" NOT NULL,
    "tax_year"       integer,
    "period"         "text" DEFAULT 'annual'::"text",
    "jurisdiction"   "text" DEFAULT 'federal'::"text",
    "form"           "text",
    "extended"       boolean DEFAULT false NOT NULL,
    "status"         "text" DEFAULT 'pending'::"text" NOT NULL,
    "completed_at"   timestamp with time zone,
    "amount"         numeric,
    "notes"          "text",
    "meta"           "jsonb" DEFAULT '{}'::"jsonb",
    "created_at"     timestamp with time zone DEFAULT "now"(),
    "updated_at"     timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "obligation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "obligation_source_check" CHECK (("source" = ANY (ARRAY['generated'::"text", 'custom'::"text"]))),
    CONSTRAINT "obligation_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'done'::"text", 'dismissed'::"text"]))),
    CONSTRAINT "obligation_kind_check" CHECK (("kind" = ANY (ARRAY[
        'return'::"text", 'extension'::"text", 'estimated_payment'::"text",
        'annual_report'::"text", 'state_return'::"text", 'other'::"text"]))),
    CONSTRAINT "obligation_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE
);

ALTER TABLE "public"."obligation" OWNER TO "postgres";

-- Upsert target for refresh.
CREATE UNIQUE INDEX IF NOT EXISTS "obligation_entity_key_uniq"
    ON "public"."obligation" ("entity_id", "obligation_key");

-- The dominant query: "what is coming up for this user, soonest first".
CREATE INDEX IF NOT EXISTS "obligation_user_due_idx"
    ON "public"."obligation" ("user_id", "due_date")
    WHERE ("status" = 'pending'::"text");

ALTER TABLE "public"."obligation" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "obligation_select_own" ON "public"."obligation"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "obligation_insert_own" ON "public"."obligation"
    FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "obligation_update_own" ON "public"."obligation"
    FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"())
    WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "obligation_delete_own" ON "public"."obligation"
    FOR DELETE TO authenticated USING ("user_id" = "auth"."uid"());

GRANT ALL ON TABLE "public"."obligation" TO "anon";
GRANT ALL ON TABLE "public"."obligation" TO "authenticated";
GRANT ALL ON TABLE "public"."obligation" TO "service_role";

COMMIT;
