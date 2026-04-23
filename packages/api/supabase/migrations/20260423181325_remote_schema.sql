


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'user',
    'coach'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_id_by_email"("user_email" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  found_user_id uuid;
BEGIN
  -- Only allow admins to use this function
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins can look up users by email';
  END IF;

  SELECT id INTO found_user_id
  FROM auth.users
  WHERE email = user_email;

  IF found_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email: %', user_email;
  END IF;

  RETURN found_user_id;
END;
$$;


ALTER FUNCTION "public"."get_user_id_by_email"("user_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.user_profile (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user_role"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Check if email matches a coach profile
  IF EXISTS (
    SELECT 1 FROM public.coaches 
    WHERE email = NEW.email
  ) THEN
    -- Assign coach role
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'coach')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user_signup"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Assign coach role to all new users
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'coach')
  ON CONFLICT (user_id, role) DO NOTHING;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user_signup"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_role"("_user_id" "uuid", "_role" "public"."app_role") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.user_roles
    where user_id = _user_id
      and role = _role
  )
$$;


ALTER FUNCTION "public"."has_role"("_user_id" "uuid", "_role" "public"."app_role") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_content_owner"("_user_id" "uuid", "_content_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.generated_content gc
    join public.coaches c on c.id = gc.coach_id
    where gc.id = _content_id
      and c.user_id = _user_id
  )
$$;


ALTER FUNCTION "public"."is_content_owner"("_user_id" "uuid", "_content_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."link_coach_to_user"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.coaches
  SET user_id = auth.uid()
  WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid())
    AND user_id IS NULL;
END;
$$;


ALTER FUNCTION "public"."link_coach_to_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "p_coach_id" "uuid", "match_threshold" double precision DEFAULT 0.7, "match_count" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "document_id" "uuid", "chunk_text" "text", "similarity" double precision)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    coach_document_embeddings.id,
    coach_document_embeddings.document_id,
    coach_document_embeddings.chunk_text,
    1 - (coach_document_embeddings.embedding <=> query_embedding) as similarity
  FROM coach_document_embeddings
  WHERE coach_document_embeddings.coach_id = p_coach_id
    AND 1 - (coach_document_embeddings.embedding <=> query_embedding) > match_threshold
  ORDER BY coach_document_embeddings.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "p_coach_id" "uuid", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."api_key" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "key_value" "text" NOT NULL,
    "name" "text" DEFAULT 'Default'::"text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "key_value_hash" "text",
    "key_prefix" "text"
);


ALTER TABLE "public"."api_key" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coach_custom_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "system_prompt" "text" NOT NULL,
    "endpoint_slug" "text" NOT NULL,
    "api_key" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(32), 'base64'::"text") NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."coach_custom_prompts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coach_document_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "chunk_text" "text" NOT NULL,
    "chunk_index" integer NOT NULL,
    "embedding" "extensions"."vector"(768),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."coach_document_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coach_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "file_url" "text" NOT NULL,
    "file_type" "text" NOT NULL,
    "file_size" integer,
    "content_text" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "enabled_for_chat" boolean DEFAULT true,
    "extraction_status" "text" DEFAULT 'pending'::"text",
    "word_count" integer,
    "summary" "text"
);


ALTER TABLE "public"."coach_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coaches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "title" "text",
    "bio" "text",
    "expertise" "text"[],
    "image_url" "text" NOT NULL,
    "linkedin_url" "text",
    "email" "text",
    "phone" "text",
    "location" "text",
    "years_experience" integer,
    "featured" boolean DEFAULT false,
    "display_order" integer DEFAULT 0,
    "published" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "uuid",
    "approved_by_admin" boolean DEFAULT false,
    "personality_prompt" "text",
    "use_documents_in_chat" boolean DEFAULT false,
    "system_prompt_id" "uuid",
    "video_url" "text"
);


ALTER TABLE "public"."coaches" OWNER TO "postgres";


COMMENT ON COLUMN "public"."coaches"."system_prompt_id" IS 'The system prompt template to use for this coach AI chatbot';



CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "title" "text",
    "messages" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "entity_id" "uuid",
    "filename" "text" NOT NULL,
    "file_type" "text",
    "s3_path" "text" NOT NULL,
    "doc_type" "text",
    "tax_year" integer,
    "textract_data" "jsonb",
    "extracted_at" timestamp with time zone,
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "meta_enc" "bytea",
    "textract_data_enc" "bytea"
);


ALTER TABLE "public"."document" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."field_map" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "form_name" "text" NOT NULL,
    "tax_year" integer NOT NULL,
    "page" integer DEFAULT 1 NOT NULL,
    "field_id" "text" NOT NULL,
    "label" "text" NOT NULL,
    "verified" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "acro_name" "text"
);


ALTER TABLE "public"."field_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."form_discovery" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "form_name" "text" NOT NULL,
    "tax_year" integer NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "pdf_s3_key" "text",
    "labeled_s3_key" "text",
    "field_count" integer,
    "map_count" integer,
    "verify_matches" integer,
    "verify_mismatches" integer,
    "source_url" "text",
    "is_fillable" boolean,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "form_discovery_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'downloading'::"text", 'labeling'::"text", 'mapping'::"text", 'verifying'::"text", 'active'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."form_discovery" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."generated_content" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "content_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "system_prompt_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'draft'::"text",
    "slug" "text",
    CONSTRAINT "generated_content_content_type_check" CHECK (("content_type" = ANY (ARRAY['article'::"text", 'transcript'::"text"]))),
    CONSTRAINT "generated_content_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."generated_content" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."nol_schedule" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "tax_year" integer NOT NULL,
    "nol_boy" numeric DEFAULT 0 NOT NULL,
    "nol_generated" numeric DEFAULT 0 NOT NULL,
    "nol_applied" numeric DEFAULT 0 NOT NULL,
    "nol_eoy" numeric DEFAULT 0 NOT NULL,
    "source" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."nol_schedule" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_connection" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "realm_id" "text" NOT NULL,
    "company_name" "text",
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "access_token_expires_at" timestamp with time zone NOT NULL,
    "refresh_token_expires_at" timestamp with time zone,
    "scope" "text" DEFAULT 'com.intuit.quickbooks.accounting'::"text",
    "connected_at" timestamp with time zone DEFAULT "now"(),
    "last_synced_at" timestamp with time zone,
    "is_active" boolean DEFAULT true,
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "access_token_enc" "bytea",
    "refresh_token_enc" "bytea"
);


ALTER TABLE "public"."qbo_connection" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_report" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "report_type" "text" NOT NULL,
    "period_start" "date",
    "period_end" "date",
    "accounting_method" "text" DEFAULT 'Accrual'::"text",
    "raw_data" "jsonb" NOT NULL,
    "summary" "jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."qbo_report" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scenario" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "entity_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "tax_year" integer NOT NULL,
    "base_return_id" "uuid",
    "adjustments" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "computed_result" "jsonb",
    "ai_analysis" "text",
    "status" "text" DEFAULT 'draft'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scenario" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shareholder_basis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "shareholder_name" "text" NOT NULL,
    "tax_year" integer NOT NULL,
    "basis_boy" numeric DEFAULT 0 NOT NULL,
    "income_items" numeric DEFAULT 0 NOT NULL,
    "distributions" numeric DEFAULT 0 NOT NULL,
    "nondeductible" numeric DEFAULT 0 NOT NULL,
    "basis_eoy" numeric DEFAULT 0 NOT NULL,
    "source" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."shareholder_basis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_connection" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stripe_key_encrypted" "text" NOT NULL,
    "account_name" "text",
    "account_id" "text",
    "connected_at" timestamp with time zone DEFAULT "now"(),
    "last_used_at" timestamp with time zone,
    "is_active" boolean DEFAULT true
);


ALTER TABLE "public"."stripe_connection" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "prompt" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."system_prompts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "return_id" "uuid",
    "action" "text" NOT NULL,
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."tax_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_entity" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "ein" "text",
    "entity_type" "text" NOT NULL,
    "form_type" "text" NOT NULL,
    "address" "text",
    "city" "text",
    "state" "text",
    "zip" "text",
    "date_incorporated" "date",
    "fiscal_year_end" "text" DEFAULT '12/31'::"text",
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "uuid",
    "ein_enc" "bytea",
    "ein_hash" "text",
    CONSTRAINT "tax_entity_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['c_corp'::"text", 's_corp'::"text", 'individual'::"text", 'partnership'::"text"]))),
    CONSTRAINT "tax_entity_form_type_check" CHECK (("form_type" = ANY (ARRAY['1120'::"text", '1120S'::"text", '1040'::"text", '1065'::"text"])))
);


ALTER TABLE "public"."tax_entity" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_return" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "tax_year" integer NOT NULL,
    "form_type" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "is_amended" boolean DEFAULT false,
    "input_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "computed_data" "jsonb",
    "field_values" "jsonb",
    "verification" "jsonb",
    "pdf_path" "text",
    "package_path" "text",
    "computed_at" timestamp with time zone,
    "filled_at" timestamp with time zone,
    "verified_at" timestamp with time zone,
    "filed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "pdf_s3_path" "text",
    "source" "text" DEFAULT 'proforma'::"text",
    "scenario_id" "uuid",
    "reviewed_at" timestamp with time zone,
    "supersedes_id" "uuid",
    "agg_total_income" numeric,
    "agg_taxable_income" numeric,
    "agg_total_tax" numeric,
    "agg_agi" numeric,
    "input_data_enc" "bytea",
    "computed_data_enc" "bytea",
    "field_values_enc" "bytea",
    "verification_enc" "bytea",
    CONSTRAINT "tax_return_source_check" CHECK (("source" = ANY (ARRAY['filed_import'::"text", 'proforma'::"text", 'extension'::"text", 'amendment'::"text"]))),
    CONSTRAINT "tax_return_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'computed'::"text", 'filled'::"text", 'verified'::"text", 'filed'::"text", 'amended'::"text"])))
);


ALTER TABLE "public"."tax_return" OWNER TO "postgres";


COMMENT ON COLUMN "public"."tax_return"."reviewed_at" IS 'Timestamp when user confirmed missing fields and approved the return for PDF generation. Cleared whenever inputs change.';



CREATE TABLE IF NOT EXISTS "public"."tax_return_form" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "return_id" "uuid",
    "form_name" "text" NOT NULL,
    "form_year" integer NOT NULL,
    "field_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "pdf_path" "text",
    "verification" "jsonb",
    "status" "text" DEFAULT 'draft'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."tax_return_form" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_key" (
    "user_id" "uuid" NOT NULL,
    "dek_encrypted" "bytea" NOT NULL,
    "kms_key_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rotated_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."user_key" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_key" IS 'Per-user 256-bit DEKs, envelope-encrypted by KMS CMK. Crypto-shred by setting deleted_at + removing dek_encrypted.';



COMMENT ON COLUMN "public"."user_key"."dek_encrypted" IS 'CMK-encrypted DEK ciphertext blob (as returned by KMS GenerateDataKey).';



CREATE TABLE IF NOT EXISTS "public"."user_profile" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "company_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_profile" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."app_role" NOT NULL
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."video_content" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "video_url" "text",
    "transcript" "text",
    "status" "text" DEFAULT 'raw'::"text" NOT NULL,
    "slug" "text",
    "thumbnail_url" "text",
    "duration" integer,
    "file_size" bigint,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "published_at" timestamp with time zone
);


ALTER TABLE "public"."video_content" OWNER TO "postgres";


ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_key_value_key" UNIQUE ("key_value");



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coach_custom_prompts"
    ADD CONSTRAINT "coach_custom_prompts_coach_id_endpoint_slug_key" UNIQUE ("coach_id", "endpoint_slug");



ALTER TABLE ONLY "public"."coach_custom_prompts"
    ADD CONSTRAINT "coach_custom_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coach_document_embeddings"
    ADD CONSTRAINT "coach_document_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coach_documents"
    ADD CONSTRAINT "coach_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaches"
    ADD CONSTRAINT "coaches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaches"
    ADD CONSTRAINT "coaches_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document"
    ADD CONSTRAINT "document_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."field_map"
    ADD CONSTRAINT "field_map_form_name_tax_year_field_id_key" UNIQUE ("form_name", "tax_year", "field_id");



ALTER TABLE ONLY "public"."field_map"
    ADD CONSTRAINT "field_map_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."form_discovery"
    ADD CONSTRAINT "form_discovery_form_name_tax_year_key" UNIQUE ("form_name", "tax_year");



ALTER TABLE ONLY "public"."form_discovery"
    ADD CONSTRAINT "form_discovery_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."generated_content"
    ADD CONSTRAINT "generated_content_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."generated_content"
    ADD CONSTRAINT "generated_content_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."nol_schedule"
    ADD CONSTRAINT "nol_schedule_entity_id_tax_year_source_key" UNIQUE ("entity_id", "tax_year", "source");



ALTER TABLE ONLY "public"."nol_schedule"
    ADD CONSTRAINT "nol_schedule_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_connection"
    ADD CONSTRAINT "qbo_connection_entity_id_key" UNIQUE ("entity_id");



ALTER TABLE ONLY "public"."qbo_connection"
    ADD CONSTRAINT "qbo_connection_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_report"
    ADD CONSTRAINT "qbo_report_entity_id_report_type_period_start_period_end_ac_key" UNIQUE ("entity_id", "report_type", "period_start", "period_end", "accounting_method");



ALTER TABLE ONLY "public"."qbo_report"
    ADD CONSTRAINT "qbo_report_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scenario"
    ADD CONSTRAINT "scenario_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shareholder_basis"
    ADD CONSTRAINT "shareholder_basis_entity_id_shareholder_name_tax_year_sourc_key" UNIQUE ("entity_id", "shareholder_name", "tax_year", "source");



ALTER TABLE ONLY "public"."shareholder_basis"
    ADD CONSTRAINT "shareholder_basis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_connection"
    ADD CONSTRAINT "stripe_connection_entity_id_key" UNIQUE ("entity_id");



ALTER TABLE ONLY "public"."stripe_connection"
    ADD CONSTRAINT "stripe_connection_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_prompts"
    ADD CONSTRAINT "system_prompts_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."system_prompts"
    ADD CONSTRAINT "system_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_audit_log"
    ADD CONSTRAINT "tax_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_entity"
    ADD CONSTRAINT "tax_entity_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_return_form"
    ADD CONSTRAINT "tax_return_form_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_return"
    ADD CONSTRAINT "tax_return_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coach_document_embeddings"
    ADD CONSTRAINT "unique_doc_chunk" UNIQUE ("document_id", "chunk_index");



ALTER TABLE ONLY "public"."user_key"
    ADD CONSTRAINT "user_key_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_profile"
    ADD CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_role_key" UNIQUE ("user_id", "role");



ALTER TABLE ONLY "public"."video_content"
    ADD CONSTRAINT "video_content_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."video_content"
    ADD CONSTRAINT "video_content_slug_key" UNIQUE ("slug");



CREATE INDEX "coach_document_embeddings_coach_idx" ON "public"."coach_document_embeddings" USING "btree" ("coach_id");



CREATE INDEX "coach_document_embeddings_document_idx" ON "public"."coach_document_embeddings" USING "btree" ("document_id");



CREATE INDEX "coach_document_embeddings_embedding_idx" ON "public"."coach_document_embeddings" USING "ivfflat" ("embedding" "extensions"."vector_cosine_ops") WITH ("lists"='100');



CREATE UNIQUE INDEX "idx_api_key_hash" ON "public"."api_key" USING "btree" ("key_value_hash") WHERE ("key_value_hash" IS NOT NULL);



CREATE INDEX "idx_basis_entity_year" ON "public"."shareholder_basis" USING "btree" ("entity_id", "tax_year");



CREATE INDEX "idx_coach_documents_chat_enabled" ON "public"."coach_documents" USING "btree" ("coach_id", "enabled_for_chat") WHERE (("enabled_for_chat" = true) AND ("content_text" IS NOT NULL));



CREATE INDEX "idx_coaches_slug" ON "public"."coaches" USING "btree" ("slug");



CREATE INDEX "idx_coaches_user_id" ON "public"."coaches" USING "btree" ("user_id");



CREATE INDEX "idx_conversations_coach_id" ON "public"."conversations" USING "btree" ("coach_id");



CREATE INDEX "idx_conversations_updated_at" ON "public"."conversations" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_field_map_form_year" ON "public"."field_map" USING "btree" ("form_name", "tax_year");



CREATE INDEX "idx_generated_content_slug" ON "public"."generated_content" USING "btree" ("slug");



CREATE INDEX "idx_nol_entity_year" ON "public"."nol_schedule" USING "btree" ("entity_id", "tax_year");



CREATE INDEX "idx_qbo_connection_entity" ON "public"."qbo_connection" USING "btree" ("entity_id");



CREATE INDEX "idx_qbo_connection_user" ON "public"."qbo_connection" USING "btree" ("user_id");



CREATE INDEX "idx_qbo_report_entity" ON "public"."qbo_report" USING "btree" ("entity_id");



CREATE INDEX "idx_qbo_report_lookup" ON "public"."qbo_report" USING "btree" ("entity_id", "report_type", "period_start", "period_end");



CREATE INDEX "idx_return_entity_year" ON "public"."tax_return" USING "btree" ("entity_id", "tax_year");



CREATE INDEX "idx_return_status" ON "public"."tax_return" USING "btree" ("status");



CREATE INDEX "idx_stripe_connection_entity" ON "public"."stripe_connection" USING "btree" ("entity_id");



CREATE INDEX "idx_tax_entity_ein_hash" ON "public"."tax_entity" USING "btree" ("ein_hash") WHERE ("ein_hash" IS NOT NULL);



CREATE INDEX "idx_tax_return_entity_year_form" ON "public"."tax_return" USING "btree" ("entity_id", "tax_year", "form_type");



CREATE INDEX "idx_tax_return_scenario" ON "public"."tax_return" USING "btree" ("scenario_id");



CREATE INDEX "idx_tax_return_source" ON "public"."tax_return" USING "btree" ("source");



CREATE INDEX "idx_tax_return_supersedes" ON "public"."tax_return" USING "btree" ("supersedes_id") WHERE ("supersedes_id" IS NOT NULL);



CREATE INDEX "idx_user_roles_role" ON "public"."user_roles" USING "btree" ("role");



CREATE INDEX "idx_user_roles_user_id" ON "public"."user_roles" USING "btree" ("user_id");



CREATE INDEX "idx_video_content_coach_id" ON "public"."video_content" USING "btree" ("coach_id");



CREATE INDEX "idx_video_content_slug" ON "public"."video_content" USING "btree" ("slug");



CREATE INDEX "idx_video_content_status" ON "public"."video_content" USING "btree" ("status");



CREATE OR REPLACE TRIGGER "update_coach_custom_prompts_updated_at" BEFORE UPDATE ON "public"."coach_custom_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "update_coach_documents_updated_at" BEFORE UPDATE ON "public"."coach_documents" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "update_coaches_updated_at" BEFORE UPDATE ON "public"."coaches" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "update_conversations_updated_at" BEFORE UPDATE ON "public"."conversations" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "update_generated_content_updated_at" BEFORE UPDATE ON "public"."generated_content" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "update_system_prompts_updated_at" BEFORE UPDATE ON "public"."system_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "update_video_content_updated_at" BEFORE UPDATE ON "public"."video_content" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coach_custom_prompts"
    ADD CONSTRAINT "coach_custom_prompts_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coach_document_embeddings"
    ADD CONSTRAINT "coach_document_embeddings_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coach_document_embeddings"
    ADD CONSTRAINT "coach_document_embeddings_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."coach_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coach_documents"
    ADD CONSTRAINT "coach_documents_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coaches"
    ADD CONSTRAINT "coaches_system_prompt_id_fkey" FOREIGN KEY ("system_prompt_id") REFERENCES "public"."system_prompts"("id");



ALTER TABLE ONLY "public"."coaches"
    ADD CONSTRAINT "coaches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document"
    ADD CONSTRAINT "document_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."document"
    ADD CONSTRAINT "document_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."generated_content"
    ADD CONSTRAINT "generated_content_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."generated_content"
    ADD CONSTRAINT "generated_content_system_prompt_id_fkey" FOREIGN KEY ("system_prompt_id") REFERENCES "public"."system_prompts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nol_schedule"
    ADD CONSTRAINT "nol_schedule_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_connection"
    ADD CONSTRAINT "qbo_connection_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_report"
    ADD CONSTRAINT "qbo_report_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scenario"
    ADD CONSTRAINT "scenario_base_return_id_fkey" FOREIGN KEY ("base_return_id") REFERENCES "public"."tax_return"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scenario"
    ADD CONSTRAINT "scenario_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scenario"
    ADD CONSTRAINT "scenario_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shareholder_basis"
    ADD CONSTRAINT "shareholder_basis_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stripe_connection"
    ADD CONSTRAINT "stripe_connection_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_audit_log"
    ADD CONSTRAINT "tax_audit_log_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "public"."tax_return"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_entity"
    ADD CONSTRAINT "tax_entity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_return"
    ADD CONSTRAINT "tax_return_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."tax_entity"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_return_form"
    ADD CONSTRAINT "tax_return_form_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "public"."tax_return"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_return"
    ADD CONSTRAINT "tax_return_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenario"("id");



ALTER TABLE ONLY "public"."tax_return"
    ADD CONSTRAINT "tax_return_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "public"."tax_return"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_profile"
    ADD CONSTRAINT "user_profile_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."video_content"
    ADD CONSTRAINT "video_content_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE CASCADE;



CREATE POLICY "Allow key lookup by value" ON "public"."api_key" FOR SELECT USING (true);



CREATE POLICY "Coaches can create their own conversations" ON "public"."conversations" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "conversations"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can delete their own content" ON "public"."generated_content" FOR DELETE TO "authenticated" USING ("public"."is_content_owner"("auth"."uid"(), "id"));



CREATE POLICY "Coaches can delete their own conversations" ON "public"."conversations" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "conversations"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can delete their own embeddings" ON "public"."coach_document_embeddings" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "coach_document_embeddings"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can delete their own videos" ON "public"."video_content" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "video_content"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can insert their own content" ON "public"."generated_content" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "generated_content"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can insert their own embeddings" ON "public"."coach_document_embeddings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "coach_document_embeddings"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can insert their own videos" ON "public"."video_content" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "video_content"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can update their own content" ON "public"."generated_content" FOR UPDATE TO "authenticated" USING ("public"."is_content_owner"("auth"."uid"(), "id"));



CREATE POLICY "Coaches can update their own conversations" ON "public"."conversations" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "conversations"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can update their own videos" ON "public"."video_content" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "video_content"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can view their own content" ON "public"."generated_content" FOR SELECT TO "authenticated" USING (("public"."is_content_owner"("auth"."uid"(), "id") OR ("status" = 'published'::"text")));



CREATE POLICY "Coaches can view their own conversations" ON "public"."conversations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "conversations"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can view their own embeddings" ON "public"."coach_document_embeddings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "coach_document_embeddings"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))));



CREATE POLICY "Coaches can view their own videos" ON "public"."video_content" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."coaches"
  WHERE (("coaches"."id" = "video_content"."coach_id") AND ("coaches"."user_id" = "auth"."uid"())))) OR ("status" = 'published'::"text")));



CREATE POLICY "Open access for qbo_report" ON "public"."qbo_report" USING (true) WITH CHECK (true);



CREATE POLICY "Open access for stripe_connection" ON "public"."stripe_connection" USING (true) WITH CHECK (true);



CREATE POLICY "Public can view published videos" ON "public"."video_content" FOR SELECT TO "anon" USING (("status" = 'published'::"text"));



CREATE POLICY "Published articles are publicly viewable" ON "public"."generated_content" FOR SELECT USING (("status" = 'published'::"text"));



CREATE POLICY "Users can manage their own QBO connections" ON "public"."qbo_connection" USING (true) WITH CHECK (true);



CREATE POLICY "Users manage own keys" ON "public"."api_key" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users see own keys" ON "public"."api_key" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."api_key" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coach_document_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."document" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."field_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."form_discovery" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."generated_content" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nol_schedule" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "open_all" ON "public"."field_map" USING (true);



CREATE POLICY "open_all" ON "public"."form_discovery" USING (true);



CREATE POLICY "open_all" ON "public"."nol_schedule" USING (true);



CREATE POLICY "open_all" ON "public"."shareholder_basis" USING (true);



CREATE POLICY "open_all" ON "public"."tax_audit_log" USING (true);



CREATE POLICY "open_all" ON "public"."tax_return_form" USING (true);



CREATE POLICY "open_delete" ON "public"."document" FOR DELETE USING (true);



CREATE POLICY "open_delete" ON "public"."scenario" FOR DELETE USING (true);



CREATE POLICY "open_insert" ON "public"."document" FOR INSERT WITH CHECK (true);



CREATE POLICY "open_insert" ON "public"."scenario" FOR INSERT WITH CHECK (true);



CREATE POLICY "open_insert" ON "public"."tax_entity" FOR INSERT WITH CHECK (true);



CREATE POLICY "open_insert" ON "public"."tax_return" FOR INSERT WITH CHECK (true);



CREATE POLICY "open_insert" ON "public"."user_profile" FOR INSERT WITH CHECK (true);



CREATE POLICY "open_select" ON "public"."document" FOR SELECT USING (true);



CREATE POLICY "open_select" ON "public"."scenario" FOR SELECT USING (true);



CREATE POLICY "open_select" ON "public"."tax_entity" FOR SELECT USING (true);



CREATE POLICY "open_select" ON "public"."tax_return" FOR SELECT USING (true);



CREATE POLICY "open_select" ON "public"."user_profile" FOR SELECT USING (true);



CREATE POLICY "open_update" ON "public"."document" FOR UPDATE USING (true);



CREATE POLICY "open_update" ON "public"."scenario" FOR UPDATE USING (true);



CREATE POLICY "open_update" ON "public"."tax_entity" FOR UPDATE USING (true);



CREATE POLICY "open_update" ON "public"."tax_return" FOR UPDATE USING (true);



CREATE POLICY "open_update" ON "public"."user_profile" FOR UPDATE USING (true);



ALTER TABLE "public"."qbo_connection" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_report" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scenario" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shareholder_basis" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_connection" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_entity" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_return" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_return_form" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profile" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."video_content" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("user_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("user_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user_signup"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user_signup"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user_signup"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_role"("_user_id" "uuid", "_role" "public"."app_role") TO "anon";
GRANT ALL ON FUNCTION "public"."has_role"("_user_id" "uuid", "_role" "public"."app_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_role"("_user_id" "uuid", "_role" "public"."app_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_content_owner"("_user_id" "uuid", "_content_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_content_owner"("_user_id" "uuid", "_content_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_content_owner"("_user_id" "uuid", "_content_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."link_coach_to_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."link_coach_to_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."link_coach_to_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "p_coach_id" "uuid", "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "p_coach_id" "uuid", "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "extensions"."vector", "p_coach_id" "uuid", "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON TABLE "public"."api_key" TO "anon";
GRANT ALL ON TABLE "public"."api_key" TO "authenticated";
GRANT ALL ON TABLE "public"."api_key" TO "service_role";



GRANT ALL ON TABLE "public"."coach_custom_prompts" TO "anon";
GRANT ALL ON TABLE "public"."coach_custom_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."coach_custom_prompts" TO "service_role";



GRANT ALL ON TABLE "public"."coach_document_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."coach_document_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."coach_document_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."coach_documents" TO "anon";
GRANT ALL ON TABLE "public"."coach_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."coach_documents" TO "service_role";



GRANT ALL ON TABLE "public"."coaches" TO "anon";
GRANT ALL ON TABLE "public"."coaches" TO "authenticated";
GRANT ALL ON TABLE "public"."coaches" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."document" TO "anon";
GRANT ALL ON TABLE "public"."document" TO "authenticated";
GRANT ALL ON TABLE "public"."document" TO "service_role";



GRANT ALL ON TABLE "public"."field_map" TO "anon";
GRANT ALL ON TABLE "public"."field_map" TO "authenticated";
GRANT ALL ON TABLE "public"."field_map" TO "service_role";



GRANT ALL ON TABLE "public"."form_discovery" TO "anon";
GRANT ALL ON TABLE "public"."form_discovery" TO "authenticated";
GRANT ALL ON TABLE "public"."form_discovery" TO "service_role";



GRANT ALL ON TABLE "public"."generated_content" TO "anon";
GRANT ALL ON TABLE "public"."generated_content" TO "authenticated";
GRANT ALL ON TABLE "public"."generated_content" TO "service_role";



GRANT ALL ON TABLE "public"."nol_schedule" TO "anon";
GRANT ALL ON TABLE "public"."nol_schedule" TO "authenticated";
GRANT ALL ON TABLE "public"."nol_schedule" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_connection" TO "anon";
GRANT ALL ON TABLE "public"."qbo_connection" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_connection" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_report" TO "anon";
GRANT ALL ON TABLE "public"."qbo_report" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_report" TO "service_role";



GRANT ALL ON TABLE "public"."scenario" TO "anon";
GRANT ALL ON TABLE "public"."scenario" TO "authenticated";
GRANT ALL ON TABLE "public"."scenario" TO "service_role";



GRANT ALL ON TABLE "public"."shareholder_basis" TO "anon";
GRANT ALL ON TABLE "public"."shareholder_basis" TO "authenticated";
GRANT ALL ON TABLE "public"."shareholder_basis" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_connection" TO "anon";
GRANT ALL ON TABLE "public"."stripe_connection" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_connection" TO "service_role";



GRANT ALL ON TABLE "public"."system_prompts" TO "anon";
GRANT ALL ON TABLE "public"."system_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."system_prompts" TO "service_role";



GRANT ALL ON TABLE "public"."tax_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."tax_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."tax_entity" TO "anon";
GRANT ALL ON TABLE "public"."tax_entity" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_entity" TO "service_role";



GRANT ALL ON TABLE "public"."tax_return" TO "anon";
GRANT ALL ON TABLE "public"."tax_return" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_return" TO "service_role";



GRANT ALL ON TABLE "public"."tax_return_form" TO "anon";
GRANT ALL ON TABLE "public"."tax_return_form" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_return_form" TO "service_role";



GRANT ALL ON TABLE "public"."user_key" TO "anon";
GRANT ALL ON TABLE "public"."user_key" TO "authenticated";
GRANT ALL ON TABLE "public"."user_key" TO "service_role";



GRANT ALL ON TABLE "public"."user_profile" TO "anon";
GRANT ALL ON TABLE "public"."user_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profile" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."video_content" TO "anon";
GRANT ALL ON TABLE "public"."video_content" TO "authenticated";
GRANT ALL ON TABLE "public"."video_content" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







