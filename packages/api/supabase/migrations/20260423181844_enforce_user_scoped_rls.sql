-- Enforce per-user RLS on every tax table.
--
-- Prerequisite: tax-api must use SUPABASE_SERVICE_ROLE_KEY (landed in commits
-- 067e1fb + d717fea + b0c976e). Before those, the anon-keyed API relied on
-- USING(true) policies and applying this migration broke every route twice.
-- Service role bypasses RLS, so the app keeps working; only the public
-- PostgREST surface (Netlify frontend's anon key) gets locked out.
--
-- Scoping map:
--   Direct user_id:   api_key (pre-existing policies), user_profile,
--                     qbo_connection, stripe_connection, document,
--                     scenario, tax_entity.
--   Entity-scoped:    qbo_report, nol_schedule, shareholder_basis, tax_return.
--   2-hop:            tax_return_form, tax_audit_log (return_id → tax_return
--                     → tax_entity → user_id).
--   Reference data:   field_map, form_discovery — open SELECT, no writes.
--
-- "Allow key lookup by value" on api_key stays — auth middleware needs anon
-- SELECT to validate incoming Bearer tokens before any user context exists.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Direct user_id tables
-- ────────────────────────────────────────────────────────────────────────────

-- tax_entity
DROP POLICY IF EXISTS "open_select" ON "public"."tax_entity";
DROP POLICY IF EXISTS "open_insert" ON "public"."tax_entity";
DROP POLICY IF EXISTS "open_update" ON "public"."tax_entity";
CREATE POLICY "tax_entity_select_own" ON "public"."tax_entity" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "tax_entity_insert_own" ON "public"."tax_entity" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "tax_entity_update_own" ON "public"."tax_entity" FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "tax_entity_delete_own" ON "public"."tax_entity" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- qbo_connection
DROP POLICY IF EXISTS "Users can manage their own QBO connections" ON "public"."qbo_connection";
CREATE POLICY "qbo_connection_select_own" ON "public"."qbo_connection" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "qbo_connection_insert_own" ON "public"."qbo_connection" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "qbo_connection_update_own" ON "public"."qbo_connection" FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "qbo_connection_delete_own" ON "public"."qbo_connection" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- stripe_connection
DROP POLICY IF EXISTS "Open access for stripe_connection" ON "public"."stripe_connection";
CREATE POLICY "stripe_connection_select_own" ON "public"."stripe_connection" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "stripe_connection_insert_own" ON "public"."stripe_connection" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "stripe_connection_update_own" ON "public"."stripe_connection" FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "stripe_connection_delete_own" ON "public"."stripe_connection" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- document
DROP POLICY IF EXISTS "open_select" ON "public"."document";
DROP POLICY IF EXISTS "open_insert" ON "public"."document";
DROP POLICY IF EXISTS "open_update" ON "public"."document";
DROP POLICY IF EXISTS "open_delete" ON "public"."document";
CREATE POLICY "document_select_own" ON "public"."document" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "document_insert_own" ON "public"."document" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "document_update_own" ON "public"."document" FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "document_delete_own" ON "public"."document" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- scenario
DROP POLICY IF EXISTS "open_select" ON "public"."scenario";
DROP POLICY IF EXISTS "open_insert" ON "public"."scenario";
DROP POLICY IF EXISTS "open_update" ON "public"."scenario";
DROP POLICY IF EXISTS "open_delete" ON "public"."scenario";
CREATE POLICY "scenario_select_own" ON "public"."scenario" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "scenario_insert_own" ON "public"."scenario" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "scenario_update_own" ON "public"."scenario" FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "scenario_delete_own" ON "public"."scenario" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- user_profile (PK id = user id)
DROP POLICY IF EXISTS "open_select" ON "public"."user_profile";
DROP POLICY IF EXISTS "open_insert" ON "public"."user_profile";
DROP POLICY IF EXISTS "open_update" ON "public"."user_profile";
CREATE POLICY "user_profile_select_own" ON "public"."user_profile" FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "user_profile_insert_own" ON "public"."user_profile" FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "user_profile_update_own" ON "public"."user_profile" FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────────
-- Entity-scoped (1-hop via tax_entity.user_id)
-- ────────────────────────────────────────────────────────────────────────────

-- qbo_report
DROP POLICY IF EXISTS "Open access for qbo_report" ON "public"."qbo_report";
CREATE POLICY "qbo_report_select_own" ON "public"."qbo_report" FOR SELECT TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "qbo_report_insert_own" ON "public"."qbo_report" FOR INSERT TO authenticated WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "qbo_report_update_own" ON "public"."qbo_report" FOR UPDATE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid())) WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "qbo_report_delete_own" ON "public"."qbo_report" FOR DELETE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));

-- nol_schedule
DROP POLICY IF EXISTS "open_all" ON "public"."nol_schedule";
CREATE POLICY "nol_schedule_select_own" ON "public"."nol_schedule" FOR SELECT TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "nol_schedule_insert_own" ON "public"."nol_schedule" FOR INSERT TO authenticated WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "nol_schedule_update_own" ON "public"."nol_schedule" FOR UPDATE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid())) WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "nol_schedule_delete_own" ON "public"."nol_schedule" FOR DELETE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));

-- shareholder_basis
DROP POLICY IF EXISTS "open_all" ON "public"."shareholder_basis";
CREATE POLICY "shareholder_basis_select_own" ON "public"."shareholder_basis" FOR SELECT TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "shareholder_basis_insert_own" ON "public"."shareholder_basis" FOR INSERT TO authenticated WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "shareholder_basis_update_own" ON "public"."shareholder_basis" FOR UPDATE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid())) WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "shareholder_basis_delete_own" ON "public"."shareholder_basis" FOR DELETE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));

-- tax_return
DROP POLICY IF EXISTS "open_select" ON "public"."tax_return";
DROP POLICY IF EXISTS "open_insert" ON "public"."tax_return";
DROP POLICY IF EXISTS "open_update" ON "public"."tax_return";
CREATE POLICY "tax_return_select_own" ON "public"."tax_return" FOR SELECT TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "tax_return_insert_own" ON "public"."tax_return" FOR INSERT TO authenticated WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "tax_return_update_own" ON "public"."tax_return" FOR UPDATE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid())) WITH CHECK (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));
CREATE POLICY "tax_return_delete_own" ON "public"."tax_return" FOR DELETE TO authenticated USING (entity_id IN (SELECT id FROM public.tax_entity WHERE user_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- 2-hop (return_id → tax_return.entity_id → tax_entity.user_id)
-- ────────────────────────────────────────────────────────────────────────────

-- tax_return_form
DROP POLICY IF EXISTS "open_all" ON "public"."tax_return_form";
CREATE POLICY "tax_return_form_select_own" ON "public"."tax_return_form" FOR SELECT TO authenticated USING (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid()));
CREATE POLICY "tax_return_form_insert_own" ON "public"."tax_return_form" FOR INSERT TO authenticated WITH CHECK (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid()));
CREATE POLICY "tax_return_form_update_own" ON "public"."tax_return_form" FOR UPDATE TO authenticated USING (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid())) WITH CHECK (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid()));
CREATE POLICY "tax_return_form_delete_own" ON "public"."tax_return_form" FOR DELETE TO authenticated USING (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid()));

-- tax_audit_log (append-only for clients)
DROP POLICY IF EXISTS "open_all" ON "public"."tax_audit_log";
CREATE POLICY "tax_audit_log_select_own" ON "public"."tax_audit_log" FOR SELECT TO authenticated USING (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid()));
CREATE POLICY "tax_audit_log_insert_own" ON "public"."tax_audit_log" FOR INSERT TO authenticated WITH CHECK (return_id IN (SELECT r.id FROM public.tax_return r JOIN public.tax_entity e ON e.id = r.entity_id WHERE e.user_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- Reference data: SELECT open, writes locked to service role
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "open_all" ON "public"."field_map";
CREATE POLICY "field_map_read_all" ON "public"."field_map" FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "open_all" ON "public"."form_discovery";
CREATE POLICY "form_discovery_read_all" ON "public"."form_discovery" FOR SELECT TO anon, authenticated USING (true);

COMMIT;
