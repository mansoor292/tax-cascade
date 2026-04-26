-- Invalidate legacy tax_return rows so they get regenerated under the
-- canonical-schema refactor.
--
-- After this commit, every writer emits sectioned-only field_values and
-- flat-only computed_data.computed. Existing rows hold a mix of both shapes
-- (descriptive + sectioned dual-write, alias-canonicalized computed). Rather
-- than migrate the mixed data in place — which would silently combine stale
-- and fresh values — we null the JSON columns and mark each row as stale so
-- the user (or MCP client) can regenerate one return at a time:
--
--   - filed_imports → ingest_document(re_archive=true) on the source PDF
--   - proformas / amendments / extensions → compute_return(return_id=…)
--
-- Encrypted shadow columns (input_data_enc, computed_data_enc, field_values_enc)
-- get nulled too so the post-decrypt view stays consistent — the row_crypto
-- helpers treat null as "no data", matching the plaintext columns.
--
-- input_data is preserved (it's the immutable record of what was passed) so
-- a recompute can replay the same inputs without the user re-entering them.
-- agg_* plaintext columns are preserved as historical totals; they'll be
-- overwritten on the next compute via extractAggregates().
--
-- Encrypted document.textract_data is unaffected — filed PDFs re-archive
-- straight from there with no Textract re-run.

UPDATE tax_return
SET
  field_values        = NULL,
  field_values_enc    = NULL,
  computed_data       = NULL,
  computed_data_enc   = NULL,
  status              = 'invalidated'
WHERE
  computed_at IS NULL
  OR computed_at < '2026-04-25T00:00:00Z';

-- Status check + sanity log: if any rows remain with non-null field_values
-- after this migration, they were computed AFTER the cutoff and are
-- already in canonical shape. Nothing further to do.
DO $$
DECLARE
  invalidated_count int;
  remaining_count int;
BEGIN
  SELECT count(*) INTO invalidated_count FROM tax_return WHERE status = 'invalidated';
  SELECT count(*) INTO remaining_count FROM tax_return WHERE field_values IS NOT NULL;
  RAISE NOTICE 'Invalidated % tax_return rows; % rows kept with canonical-shape data.',
    invalidated_count, remaining_count;
END $$;
