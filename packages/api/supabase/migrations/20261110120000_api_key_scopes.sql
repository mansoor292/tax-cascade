-- Read-only API keys.
--
-- Why (2026-11-10): the catalogs.com billing worker authenticates with a
-- txk_ key to fill QuickBooks invoices and create, charge and record Stripe
-- invoices. Every key so far has been all-powerful — the key that reads a
-- P&L is the key that can void an invoice or charge a card. `scopes` splits
-- that. The values are tiny on purpose: '*' (everything), 'read', 'write'.
-- The /api auth middleware (server.ts) loads the column and lib/scopes.ts
-- refuses a write route unless the key carries '*' or 'write'; every GET
-- stays open to any scope.
--
-- Default '{*}' so every existing row keeps exactly the power it had. A key
-- is narrowed only by asking for it at creation (POST /auth/api-keys with
-- scopes: ['read']). Written to be a no-op when re-run.

ALTER TABLE "public"."api_key"
  ADD COLUMN IF NOT EXISTS "scopes" "text"[] NOT NULL DEFAULT '{*}'::"text"[];

-- Only the three known values, and never an empty list: an empty array
-- would read as "no scopes" and lock the key out of everything.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'api_key_scopes_check'
      AND "conrelid" = '"public"."api_key"'::"regclass"
  ) THEN
    ALTER TABLE "public"."api_key"
      ADD CONSTRAINT "api_key_scopes_check"
      CHECK (("cardinality"("scopes") > 0) AND ("scopes" <@ ARRAY['*'::"text", 'read'::"text", 'write'::"text"]));
  END IF;
END
$$;

COMMENT ON COLUMN "public"."api_key"."scopes" IS
  'What the key may do: {*} = everything (default, every pre-existing key); {read} = GET routes only, refused at every QBO/Stripe write; {write} = writes allowed. Checked by lib/scopes.ts requireWrite.';
