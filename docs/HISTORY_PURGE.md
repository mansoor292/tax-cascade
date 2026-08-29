# Git history purge — runbook

The working tree is clean since the 2026-08 cleanup, but git HISTORY still
carries: a real SSN and two EINs (the old README's "Entities" table), the
Supabase anon JWT (hardcoded fallback in 19 files), and the static API keys
(`test-key-2026`, `txk_prod_edgewater_2026` in SKILL.md /
.env.production.template). History rewriting is destructive and
force-pushes `main` — a human runs this, deliberately.

## Order of operations

Rotation FIRST, purge second: until the push lands everywhere, the old
history is still cloneable, so treat the secrets as burned regardless.

1. **Rotate credentials** (independent of the purge, do it now):
   - Supabase anon key: Supabase dashboard → Settings → API → roll anon key.
     Update: Netlify env (`VITE_SUPABASE_ANON_KEY`), SSM `/tax-api/SUPABASE_ANON_KEY`,
     local `.env` files.
   - Static API keys: remove `test-key-2026` and `txk_prod_edgewater_2026`
     from SSM `/tax-api/TAX_API_KEYS`; issue fresh keys via /auth/api-keys.
   - Audit `api_key` rows: `select * from api_key where user_id = '00000000-0000-0000-0000-000000000000'`.
2. **Freeze pushes.** Merge/close every open PR; tell anyone with a clone
   that history is about to rewrite.
3. **Purge** on a fresh mirror clone:

   ```bash
   pip install git-filter-repo
   git clone --mirror git@github.com:mansoor292/tax-cascade.git purge && cd purge

   cat > /tmp/replacements.txt <<'TXT'
   597-09-1708==>XXX-XX-XXXX
   83-1889553==>XX-XXXXXXX
   87-3340910==>XX-XXXXXXX
   test-key-2026==>REDACTED-KEY
   txk_prod_edgewater_2026==>REDACTED-KEY
   TXT
   # Add the FULL anon JWT (both eyJ... segments) as another ==>REDACTED line;
   # it is long — copy it from the old netlify.toml blob, don't retype it.

   git filter-repo --replace-text /tmp/replacements.txt
   git push --force --mirror git@github.com:mansoor292/tax-cascade.git
   ```

4. **Invalidate old copies:** every collaborator re-clones (a pull onto an
   old clone resurrects the old objects); delete stale forks; GitHub
   support can clear cached views/PR diffs of the old commits if needed.
5. **Verify:** `git log -S 597-09-1708 --all` and `git log -S eyJhbGci --all`
   on a fresh clone come back empty.

## Notes

- The deploy webhook pulls `main` by commit — after the force-push, the
  EC2 checkout needs one `git fetch && git reset --hard origin/main`
  (deploy-reload.sh's normal pull may refuse the rewritten history).
- Commit hashes change repo-wide; any external references to old hashes
  (links in docs, issue comments) go stale. Acceptable cost.
