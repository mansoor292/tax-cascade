-- Lock down user_key + remove the dead "coach" cluster.
--
-- user_key holds per-user envelope-encrypted DEKs. Service role bypasses
-- RLS so the app still works; enabling RLS with a USING(false) policy
-- closes the anon-key / PostgREST surface to user_key entirely. The
-- KMS-encrypted ciphertext was never readable without the KMS key, but
-- an indefensible posture for SOC 2.
--
-- The coach*/user_roles/system_prompts/generated_content/video_content/
-- conversations tables are remnants of a prior app that shared this
-- Supabase project. All FKs point inward; reverse topological drop with
-- CASCADE handles it. Row counts at drop time: coaches 0, coach_*_prompts 0,
-- coach_documents 0, coach_document_embeddings 0, user_roles 4,
-- system_prompts 3, generated_content 0, video_content 0, conversations 0.
--
-- Storage buckets (coach-avatars, coach-videos) are NOT dropped here —
-- Supabase protects storage.buckets with a trigger that blocks direct
-- DELETE. Those come out via the Storage API (handled separately, see
-- scripts/delete-coach-buckets.sh).

BEGIN;

-- 1. user_key lockdown — service role bypasses; anon/authenticated denied.
ALTER TABLE "public"."user_key" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_key_service_role_only" ON "public"."user_key"
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- 2. Drop the dead coach cluster.
DROP TABLE IF EXISTS "public"."coach_document_embeddings" CASCADE;
DROP TABLE IF EXISTS "public"."coach_documents" CASCADE;
DROP TABLE IF EXISTS "public"."coach_custom_prompts" CASCADE;
DROP TABLE IF EXISTS "public"."generated_content" CASCADE;
DROP TABLE IF EXISTS "public"."video_content" CASCADE;
DROP TABLE IF EXISTS "public"."conversations" CASCADE;
DROP TABLE IF EXISTS "public"."coaches" CASCADE;
DROP TABLE IF EXISTS "public"."system_prompts" CASCADE;
DROP TABLE IF EXISTS "public"."user_roles" CASCADE;

-- 3. Drop coach-era storage.objects policies (bucket rows deleted via API).
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND (policyname ILIKE '%coach%' OR policyname ILIKE '%avatar%' OR policyname ILIKE '%video%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

-- 4. Drop orphaned ENUM + its dependent function (has_role).
DROP TYPE IF EXISTS "public"."app_role" CASCADE;
DROP FUNCTION IF EXISTS "public"."get_user_id_by_email"("text");

COMMIT;
