-- Return catalog: every value on every page of a return, stored once.
--
-- Why (2026-10-17): for six months every question about a filed return went
-- back to its PDF, and a different slice was read each time. The filed-import
-- mapper kept 10–40% of a return — no checkboxes, no Schedule E
-- passive/nonpassive columns, no K-1 Part II, no M-2, no statements — so
-- errors surfaced one question at a time, months apart. The owner's rule since:
-- every box, check, statement row and worksheet line is catalogued, and every
-- question is answered from the catalog. See docs/RETURN_CATALOG_AND_REVIEW.md.
--
-- One row per catalogued source document (a filed return PDF, a generated
-- return, an IRS transcript). The entries themselves are taxpayer data and live
-- only in entries_enc / pages_enc (row_crypto ENCRYPTED_CATALOG_FIELDS); the
-- plaintext columns hold structure only — which forms, how many pages, the
-- coverage counts — so listings never need a decrypt.
--
-- Re-cataloguing never edits a row: it inserts a new one and points the old
-- row's superseded_by at it, so what a past review read stays reproducible.

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."return_catalog" (
    "id"              "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id"         "uuid" NOT NULL,
    "entity_id"       "uuid" NOT NULL,
    "tax_year"        integer,
    "document_id"     "uuid",
    "return_id"       "uuid",
    "kind"            "text" NOT NULL,
    "extractor"       "text" NOT NULL,
    "source_sha256"   "text" NOT NULL,
    "source_filename" "text",
    "status"          "text" NOT NULL,
    -- Structure only (no taxpayer values): page kinds/forms/scores, counts,
    -- blocking problems and warnings (page numbers and form names only).
    "forms"           "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "coverage"        "jsonb" NOT NULL,
    "page_index"      "jsonb" NOT NULL,
    -- Taxpayer data: written ciphertext-only.
    "entries"         "jsonb",
    "entries_enc"     "bytea",
    "pages"           "jsonb",
    "pages_enc"       "bytea",
    "superseded_by"   "uuid",
    "created_at"      timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "return_catalog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "return_catalog_kind_check" CHECK (("kind" = ANY (ARRAY[
        'filed_return'::"text", 'computed_return'::"text", 'irs_transcript'::"text",
        'irs_notice'::"text", 'other'::"text"]))),
    CONSTRAINT "return_catalog_status_check" CHECK (("status" = ANY (ARRAY[
        'complete'::"text", 'incomplete'::"text"]))),
    CONSTRAINT "return_catalog_entity_id_fkey" FOREIGN KEY ("entity_id")
        REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE,
    CONSTRAINT "return_catalog_document_id_fkey" FOREIGN KEY ("document_id")
        REFERENCES "public"."document"("id") ON DELETE SET NULL,
    CONSTRAINT "return_catalog_return_id_fkey" FOREIGN KEY ("return_id")
        REFERENCES "public"."tax_return"("id") ON DELETE SET NULL,
    CONSTRAINT "return_catalog_superseded_by_fkey" FOREIGN KEY ("superseded_by")
        REFERENCES "public"."return_catalog"("id") ON DELETE SET NULL
);

ALTER TABLE "public"."return_catalog" OWNER TO "postgres";

-- "The current catalogs for this entity, by year" — every query starts here.
CREATE INDEX IF NOT EXISTS "return_catalog_entity_year_current_idx"
    ON "public"."return_catalog" ("entity_id", "tax_year")
    WHERE ("superseded_by" IS NULL);

-- One current catalog per source document.
CREATE UNIQUE INDEX IF NOT EXISTS "return_catalog_document_current_uniq"
    ON "public"."return_catalog" ("document_id")
    WHERE ("superseded_by" IS NULL AND "document_id" IS NOT NULL);

ALTER TABLE "public"."return_catalog" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "return_catalog_select_own" ON "public"."return_catalog"
    FOR SELECT TO authenticated USING ("user_id" = "auth"."uid"());
CREATE POLICY "return_catalog_insert_own" ON "public"."return_catalog"
    FOR INSERT TO authenticated WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "return_catalog_update_own" ON "public"."return_catalog"
    FOR UPDATE TO authenticated USING ("user_id" = "auth"."uid"())
    WITH CHECK ("user_id" = "auth"."uid"());
CREATE POLICY "return_catalog_delete_own" ON "public"."return_catalog"
    FOR DELETE TO authenticated USING ("user_id" = "auth"."uid"());

GRANT ALL ON TABLE "public"."return_catalog" TO "anon";
GRANT ALL ON TABLE "public"."return_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."return_catalog" TO "service_role";

COMMIT;
