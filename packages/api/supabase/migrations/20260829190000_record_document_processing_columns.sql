-- Record the document processing columns that already exist in prod.
--
-- public.document.processing_status, .processing_error and
-- .processing_started_at back the async ingest contract: POST /documents/ingest
-- inserts the row as 'processing', answers 202, and finishes the extraction in
-- the background. The ingest_document MCP tool documents that polling contract
-- to callers.
--
-- All three were added directly against the database and appear in NO
-- migration, so a fresh `supabase db reset` produces a schema where
-- /documents/ingest fails on insert. This migration is pure drift capture: it
-- states what prod already has, changes nothing there, and is written to be a
-- no-op against the live database.
--
-- Recorded now because extraction is moving into a separate Lambda worker that
-- writes these same columns. Two services depending on a column that exists in
-- no migration is how the next environment gets built wrong.

ALTER TABLE "public"."document"
  ADD COLUMN IF NOT EXISTS "processing_status" "text" NOT NULL DEFAULT 'done'::"text",
  ADD COLUMN IF NOT EXISTS "processing_error" "text",
  ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone;

-- Default is 'done', not 'processing': every row that predates the async split
-- was extracted inline and is finished. Only rows that /ingest explicitly marks
-- 'processing' are in flight.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'document_processing_status_check'
      AND "conrelid" = '"public"."document"'::"regclass"
  ) THEN
    ALTER TABLE "public"."document"
      ADD CONSTRAINT "document_processing_status_check"
      CHECK (("processing_status" = ANY (ARRAY['processing'::"text", 'done'::"text", 'failed'::"text"])));
  END IF;
END
$$;

COMMENT ON COLUMN "public"."document"."processing_status" IS
  'processing = extraction still running in the background; done = finished; failed = extraction errored, see processing_error';
