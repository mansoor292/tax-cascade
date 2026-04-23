-- Harden the last two public-schema functions advisor flagged.
--
-- handle_new_user: auth trigger that mirrors new auth.users rows into
-- public.user_profile. Stays; pin its search_path to '' so a malicious
-- same-named object in a user-writable schema can't hijack it.
--
-- match_documents: vector-search helper for the prior coach-documents
-- RAG feature. The coach_document_embeddings table it queries was
-- dropped in the previous migration, so the function is already broken.
-- Drop it outright rather than pretend-harden.

BEGIN;

ALTER FUNCTION "public"."handle_new_user"() SET search_path = '';

-- `double precision` is a compound built-in type name — do not quote it as "double precision".
DROP FUNCTION IF EXISTS public.match_documents(vector, uuid, double precision, integer);

COMMIT;
