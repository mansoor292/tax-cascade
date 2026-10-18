-- The entity map: how the entities in one account are tied to each other.
--
-- Why (2026-10-18): the account holds an S corporation, two C corporations
-- and the owners' joint 1040, and nothing stored how they relate. The review
-- re-derived one kind of link (an S corporation's K-1 on the 1040, matched by
-- the EIN printed on Schedule E) on every run and then threw it away.
-- Ownership of the C corporations, the controlled group, the intercompany fee
-- and the due-to/due-from balance between two of them, and a disregarded LLC
-- that runs the payroll were known only to whichever session last worked it
-- out. The owner's requirement: a hard-coded map of the group, so a change to
-- one return is traced to every return it touches without re-reading
-- everything.
--
-- One row is one relationship:
--   owns          from (the owner's return; `subject` names the person on a
--                 joint 1040) holds `pct` of to
--   disregarded   to is a disregarded entity of from (its income and payroll
--                 belong on from's return); to may be outside the account
--   intercompany  from and to deal with each other; `nature` says how
--                 (services fee, loan, rent, settlement); from is the side
--                 that pays or owes
-- `to_name` names a party with no return in this account. from_year/to_year
-- bound the years the link holds (null = open). Every link carries its
-- source and evidence.
--
-- Versioned like tax_fact and return_note: an edit inserts a new version
-- with the same link_key and points the old one at it. A link recorded in
-- error is retired by a version with removed = true, never deleted.
-- evidence/detail quote returns and name people, so they are written
-- ciphertext-only (lib/row_crypto ENCRYPTED_LINK_FIELDS).

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."entity_link" (
    "id"             "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "link_key"       "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"        "uuid" NOT NULL,
    "kind"           "text" NOT NULL,
    "from_entity_id" "uuid" NOT NULL,
    "to_entity_id"   "uuid",
    "to_name"        "text",
    "subject"        "text",
    "pct"            numeric(7,4),
    "nature"         "text",
    "from_year"      integer,
    "to_year"        integer,
    "source"         "text" NOT NULL,
    "evidence"       "text",
    "evidence_enc"   "bytea",
    "detail"         "text",
    "detail_enc"     "bytea",
    "removed"        boolean DEFAULT false NOT NULL,
    "recorded_by"    "text",
    "recorded_at"    timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by"  "uuid",
    CONSTRAINT "entity_link_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "entity_link_kind_check" CHECK (("kind" = ANY (ARRAY['owns'::"text", 'disregarded'::"text", 'intercompany'::"text"]))),
    CONSTRAINT "entity_link_source_check" CHECK (("source" = ANY (ARRAY['owner'::"text", 'filed_return'::"text", 'fact'::"text", 'entity_record'::"text"]))),
    CONSTRAINT "entity_link_nature_check" CHECK (("nature" IS NULL OR "nature" = ANY (ARRAY['services'::"text", 'loan'::"text", 'rent'::"text", 'settlement'::"text", 'other'::"text"]))),
    CONSTRAINT "entity_link_pct_check" CHECK (("pct" IS NULL OR ("pct" > 0 AND "pct" <= 100))),
    CONSTRAINT "entity_link_years_check" CHECK (("from_year" IS NULL OR "to_year" IS NULL OR "from_year" <= "to_year")),
    CONSTRAINT "entity_link_to_check" CHECK ((("to_entity_id" IS NULL) <> ("to_name" IS NULL))),
    CONSTRAINT "entity_link_not_self_check" CHECK (("to_entity_id" IS NULL OR "to_entity_id" <> "from_entity_id")),
    CONSTRAINT "entity_link_from_entity_id_fkey" FOREIGN KEY ("from_entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "entity_link_to_entity_id_fkey" FOREIGN KEY ("to_entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "entity_link_superseded_by_fkey" FOREIGN KEY ("superseded_by")
        REFERENCES "public"."entity_link"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."entity_link" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "entity_link_current_idx"
    ON "public"."entity_link" ("user_id")
    WHERE ("superseded_by" IS NULL);
CREATE INDEX IF NOT EXISTS "entity_link_key_idx"
    ON "public"."entity_link" ("link_key", "recorded_at" DESC);

ALTER TABLE "public"."entity_link" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "entity_link_select_own" ON "public"."entity_link"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "entity_link_insert_own" ON "public"."entity_link"
    FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "entity_link_update_own" ON "public"."entity_link"
    FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"())
    WITH CHECK ("user_id" = "auth"."uid"());

GRANT ALL ON TABLE "public"."entity_link" TO "anon";
GRANT ALL ON TABLE "public"."entity_link" TO "authenticated";
GRANT ALL ON TABLE "public"."entity_link" TO "service_role";

COMMIT;
