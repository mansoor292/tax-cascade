-- A filed amended return is catalogued as its own kind (2026-10-23).
--
-- Owner's rule (2026-10-23): an amendment is recorded as filed by uploading the
-- signed amended return to it; it is accepted once the year's IRS account
-- transcript shows the amendment processed (TC977). The copy is catalogued
-- with return_id = the amendment.
--
-- Its own kind, not 'filed_return': every check, Compare and the amendment
-- base read the year's filed_return catalog as THE return as filed, so an
-- amended copy under that kind could stand in for the original. A 1040-X
-- uploaded through the catalog route did exactly that until now.

BEGIN;

ALTER TABLE "public"."return_catalog"
    DROP CONSTRAINT IF EXISTS "return_catalog_kind_check";
ALTER TABLE "public"."return_catalog"
    ADD CONSTRAINT "return_catalog_kind_check" CHECK (("kind" = ANY (ARRAY[
        'filed_return'::"text", 'amended_return'::"text", 'computed_return'::"text",
        'irs_transcript'::"text", 'irs_notice'::"text", 'other'::"text"])));

COMMIT;
