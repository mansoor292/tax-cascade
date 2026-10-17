-- tax_fact: answers to the fact registry (@taxengine/shared facts.ts).
--
-- Why: for six months the facts that decide how a return is prepared —
-- who lent the company money and from whose account, whether the owner
-- materially participates, when the S election took effect and when the IRS
-- accepted it, which EIN issues the W-2s, what the transcripts show — lived in
-- free-text entity notes or in nobody's notes at all, and surfaced one at a
-- time, months apart. docs/RETURN_CATALOG_AND_REVIEW.md §3 (R2): the facts a
-- return needs are defined ONCE per return type in the registry, and every
-- answer lands here, in one shape, with its provenance.
--
-- Shape decisions:
--   * One row per answer at a coordinate (entity, tax_year, subject,
--     fact_key). tax_year is NULL for all-years facts (scope entity/owner);
--     subject names the owner, K-1 issuer or counterparty for owner and
--     relationship scopes (and an amended return for scope 'return').
--   * Answers are SUPERSEDED, never overwritten. A new answer is a new row and
--     the previous current row gets superseded_by = the new id. The history is
--     the audit trail: who said what, when, on what evidence — which is
--     exactly what was missing when a fact had to be re-established.
--   * value / source_note carry ciphertext twins (value_enc /
--     source_note_enc) written by lib/row_crypto.ts with the user's DEK, like
--     every other sensitive column. Post-cutover writes are ciphertext-only.
--   * status 'answered' | 'unknown' | 'not_applicable' is what was SAID.
--     'missing' and 'contradicted' are computed by the gap check and never
--     stored.
--   * user_id is denormalised onto the row so RLS is a single-hop check, the
--     same choice `document`, `scenario` and `obligation` made.
--
-- RLS follows 20260423181844_enforce_user_scoped_rls.sql (direct user_id
-- pattern), with two deliberate differences:
--   * INSERT also requires the entity to belong to the caller, so a client
--     cannot file a fact against someone else's entity id.
--   * No UPDATE or DELETE policy for clients, like tax_audit_log: the fact
--     log is append-only from the outside. The API (service role, which
--     bypasses RLS) is the only writer that sets superseded_by. Rows still go
--     away with their entity through the ON DELETE CASCADE.
--
-- NOT APPLIED by this commit. Apply deliberately, then deploy the API.

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."tax_fact" (
    "id"                   "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"              "uuid" NOT NULL,
    "entity_id"            "uuid" NOT NULL,
    "tax_year"             integer,
    "subject"              "text",
    "fact_key"             "text" NOT NULL,
    "value"                "jsonb",
    "value_enc"            "bytea",
    "status"               "text" NOT NULL,
    "source"               "text" NOT NULL,
    "source_note"          "text",
    "source_note_enc"      "bytea",
    "evidence_document_id" "uuid",
    "recorded_by"          "text",
    "recorded_at"          timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by"        "uuid",
    "created_at"           timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "tax_fact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tax_fact_status_check" CHECK (("status" = ANY (ARRAY[
        'answered'::"text", 'unknown'::"text", 'not_applicable'::"text"]))),
    CONSTRAINT "tax_fact_source_check" CHECK (("source" = ANY (ARRAY[
        'owner'::"text", 'document'::"text", 'catalog'::"text",
        'derived'::"text", 'migrated'::"text"]))),
    CONSTRAINT "tax_fact_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "tax_fact_evidence_document_id_fkey" FOREIGN KEY ("evidence_document_id")
        REFERENCES "public"."document"("id") ON DELETE SET NULL,
    -- SET NULL: if a newer answer is ever removed, the one it replaced
    -- becomes current again rather than blocking the delete.
    CONSTRAINT "tax_fact_superseded_by_fkey" FOREIGN KEY ("superseded_by")
        REFERENCES "public"."tax_fact"("id") ON DELETE SET NULL
);

ALTER TABLE "public"."tax_fact" OWNER TO "postgres";

-- The dominant read: the CURRENT answers for one entity (and year).
CREATE INDEX IF NOT EXISTS "tax_fact_current_idx"
    ON "public"."tax_fact" ("entity_id", "fact_key", "tax_year")
    WHERE ("superseded_by" IS NULL);

-- History reads walk the chain backwards from a current row.
CREATE INDEX IF NOT EXISTS "tax_fact_superseded_by_idx"
    ON "public"."tax_fact" ("superseded_by")
    WHERE ("superseded_by" IS NOT NULL);

ALTER TABLE "public"."tax_fact" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tax_fact_select_own" ON "public"."tax_fact"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "tax_fact_insert_own" ON "public"."tax_fact"
    FOR INSERT TO authenticated WITH CHECK (
        "user_id" = "auth"."uid"()
        AND "entity_id" IN (SELECT "id" FROM "public"."tax_entity" WHERE "user_id" = "auth"."uid"())
    );

GRANT ALL ON TABLE "public"."tax_fact" TO "anon";
GRANT ALL ON TABLE "public"."tax_fact" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_fact" TO "service_role";

COMMIT;
