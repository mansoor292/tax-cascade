-- Each client's period statuses, counted when its periods are written.
--
-- Why (2026-10-26): the client list counted every client's periods by status
-- on each load (practice_status_counts, 20261028120000). On a fictional book
-- the size of the 8,834-client export (172,700 periods) that grouping took
-- 1–4 s of every Clients page. The counts change only when periods are
-- written — a read, an import batch, an IRS request's outcome — so they are
-- written then, beside the summary. Counts are structure, not taxpayer data:
-- plain. A client written before this column existed has none until its
-- next read; the list counts those few with practice_status_counts.

ALTER TABLE "public"."practice_client" ADD COLUMN IF NOT EXISTS "status_counts" "jsonb";
