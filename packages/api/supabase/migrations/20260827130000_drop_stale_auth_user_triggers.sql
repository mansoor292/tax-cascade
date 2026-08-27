-- Signup has been failing with "Database error saving new user" since
-- 20260423221916 dropped the legacy coach tables.
--
-- That migration removed public.coaches and public.user_roles but left two
-- triggers on auth.users still pointing at them:
--
--   on_auth_user_created_assign_role -> handle_new_user_role()
--       SELECT 1 FROM public.coaches WHERE email = NEW.email
--   on_auth_user_signup              -> handle_new_user_signup()
--       INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'coach')
--
-- Both relations are gone, so every INSERT into auth.users raised, the
-- transaction aborted, and GoTrue surfaced the generic "Database error
-- saving new user". Nobody hit it for four months because nobody signed up;
-- it surfaced the moment a new person tried to create an account.
--
-- Both triggers belong to the removed coaching feature and have no purpose
-- here. Dropped outright rather than recreating tables we deliberately
-- deleted.
--
-- on_auth_user_created -> handle_new_user() STAYS: it mirrors new auth.users
-- rows into public.user_profile and is still required.

BEGIN;

DROP TRIGGER IF EXISTS "on_auth_user_created_assign_role" ON "auth"."users";
DROP TRIGGER IF EXISTS "on_auth_user_signup"              ON "auth"."users";

DROP FUNCTION IF EXISTS "public"."handle_new_user_role"();
DROP FUNCTION IF EXISTS "public"."handle_new_user_signup"();

COMMIT;
