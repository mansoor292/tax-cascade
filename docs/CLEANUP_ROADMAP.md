# Cleanup roadmap — status

The 2026-08 cleanup shipped in two waves on `claude/code-cleanup-plan-2xxxqy`.

**Wave 1 (docs + safe wins):** CLAUDE.md memories, README PII scrub, Stripe
key encryption, published-API-key removal, ~12k lines of dead code deleted,
lint/gitignore/Playwright repairs, web format/label dedup, scenario-PDF fix.

**Wave 2 (deep refactors) — ALL DONE:**
1. ✅ One Supabase module (`api/src/lib/supabase.ts`: service/anon/userClient
   + requestUserId); 13 createClient copies, 7 getUser copies, and every
   hardcoded anon-JWT literal removed; http_error adopted across routes.
2. ✅ `getFinancials()` + `computeReturn()` as functions — all 14 self-HTTP
   loopbacks gone; POST /compute body lives in `services/compute_return.ts`
   with pure parts (`compute_validation`, `entity_identity`) extracted and
   tested. NOT yet unified: the near-duplicate 1120/1120S dispatch arms.
3. ✅ `packages/shared` — metric maps, section vocabulary, response types;
   web hardcoded canonical strings removed; Compare drift fixed.
4. ✅ AWS SDK dual path in `lib/s3.ts`/`lib/textract.ts` behind
   `TAX_API_AWS_SDK=1` (Python remains default until ops flips it).
   Remaining: form_discovery's two bespoke Textract reductions.
5. ✅ Encryption cutover: qbo_tokens ciphertext-only; backfill scripts
   committed (`backfill_null_qbo_plaintext.ts`, `migrate_stripe_enc1.ts`).
6. ✅ Express OAuth deleted; Netlify Functions + static discovery JSON are
   the single implementation.
7. ✅ Web: ReturnsTab/Compare split, hook error surfacing + LoadError,
   unified AuthForm, first vitest suites (root `npm test` runs both).
8. ✅ Docs/config: HISTORY_PURGE.md runbook, supabase config.toml site_url,
   API eslint.

## Remaining — OPS ACTIONS (need credentials/coordination, not code)

- [ ] Run `docs/HISTORY_PURGE.md`: rotate the anon key + static API keys,
      then git-filter-repo + force-push (SSN/EINs/keys live in history).
- [ ] Set `VITE_SUPABASE_ANON_KEY` in the Netlify dashboard BEFORE the next
      web deploy (removed from netlify.toml; the app now fails loudly
      without it).
- [ ] Set `OAUTH_CODE_SECRET` confirmed present in Netlify (the Express
      OAuth fallback no longer exists).
- [ ] **Set `SUPABASE_ANON_KEY` for the API.** It is in neither SSM
      (`/tax-api/*` has 7 params, not this one) nor the committed
      `.env.production.template`'s live counterpart on every box. Removing
      the hardcoded anon literals left the API with no source for it, and
      `/auth/*` plus JWT auth on `/api/*` answer 503 without it (static
      `TAX_API_KEYS` callers are unaffected). Add it as an SSM SecureString:
      `aws ssm put-parameter --name /tax-api/SUPABASE_ANON_KEY --type SecureString --value <anon key>`
      — SSM is skipped for vars already set, so a box that already has it in
      `.env.production` keeps its value. Fetch the value with
      `supabase projects api-keys --project-ref ophnjqjmxeohbyydxnlg`.
      Rotate it as part of HISTORY_PURGE rather than treating it as secret.
- [x] ~~First API deploy: manual `npm install` at /opt/tax-api.~~ NOT
      needed. The claim read only deploy-reload.sh; the install is in
      server.ts's deploy webhook, which runs
      `npm install --include=dev` from packages/api after the reset.
      Verified locally: deleting node_modules/@taxengine and running that
      exact command from packages/api recreates the shared symlink, and the
      API boots with packages/shared/dist absent (it is gitignored, and
      only tsc needs it — prod runs tsx off src).
- [ ] Run the two encryption backfills with SSM env (dry-run first).
- [ ] When ready, set `TAX_API_AWS_SDK=1` in SSM and watch one
      upload→extract cycle; roll back by unsetting.
- [ ] Audit `api_key` rows for the all-zeros user id.

## Remaining — future code work (nice-to-have)

- Unify the 1120/1120S engine-dispatch arms in compute_return (needs test
  cover first); route/crypto/MCP test suites.
- Port form_discovery's two Python Textract reductions onto lib/textract.
- content_hash dedupe: move the hash out of encrypted meta into its own
  column so post-cutover uploads dedupe again.
- One <SchemaForm> for the ReturnsTab dialog / Compute / Extensions trio.
- Web `strict: true` + shared tsconfig base.
