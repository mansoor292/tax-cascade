#!/usr/bin/env bash
# Reload the pm2 cluster after a deploy — run DETACHED, never inline.
#
# Why this is a separate script run at arm's length:
#
# The deploy webhook is handled by a pm2 cluster worker. pm2 reloads workers
# one at a time, and the first it takes down is the worker that handled the
# request. pm2's treekill (on by default) kills that worker's whole child
# tree by walking ppid — which reaches a `detached: true` child even though
# setsid gave it a new session. So a reload started from inside the handler
# was killed after cycling worker 0 and never reached worker 1, leaving half
# the fleet on the old build with requests round-robining between the two.
#
# The webhook double-forks into this script so it is reparented to init
# before the killing starts, and the sleep gives that reparenting time to
# happen. Everything it needs is read from disk, so it depends on nothing
# from the process that launched it.
set -uo pipefail

cd /opt/tax-api/packages/api || exit 1

# Let the launching worker's handler return and the reparent settle.
sleep 3

echo "[reload] $(date -u +%FT%TZ) starting"

# Route modules capture process.env at import time, so the secrets have to be
# in the shell environment BEFORE pm2 hands it to node (see load-ssm-env.sh).
set -a
[ -f .env ] && . ./.env
set +a
eval "$(./scripts/load-ssm-env.sh)" || echo "[reload] WARNING: SSM load failed"

pm2 reload tax-api --update-env
echo "[reload] pm2 reload exited $?"

# ── Extraction worker ──────────────────────────────────────────────────
# The Lambda runs the SAME code (services/document_extraction) as a second
# entrypoint, but `git push` only used to redeploy the API — the worker kept
# whatever bundle it was provisioned with. That skew shipped a prompt fix to
# the API while prod ingests kept classifying with the old prompt in the
# stale worker. So the deploy updates both, always.
#
# Failure here must not fail the API deploy — the dispatcher falls back to
# in-process extraction (which IS the fresh code) — but it has to be loud:
# a stale worker is invisible from /api/health.
if [ -n "${TAX_API_EXTRACTION_FUNCTION:-}" ]; then
  echo "[reload] rebuilding extraction worker bundle"
  WLOG="$(mktemp)"
  if { bash scripts/build_worker.sh \
       && aws lambda update-function-code \
            --function-name "$TAX_API_EXTRACTION_FUNCTION" \
            --zip-file fileb://dist-worker.zip \
       && aws lambda wait function-updated --function-name "$TAX_API_EXTRACTION_FUNCTION"; } >"$WLOG" 2>&1; then
    echo "[reload] worker code updated"
    printf 'OK %s %s\n' "$(date -u +%FT%TZ)" "$(git -C /opt/tax-api rev-parse --short HEAD)" >"$WLOG.status"
  else
    echo "[reload] WARNING: worker update FAILED — Lambda is running STALE code (API falls back in-process only on invoke errors, so ingests still run the old bundle)"
    printf 'FAILED %s %s\n' "$(date -u +%FT%TZ)" "$(git -C /opt/tax-api rev-parse --short HEAD)" >"$WLOG.status"
  fi
  # This box has no shell access, so the reload log is unreadable from the
  # outside. Park the outcome (and the full output on failure) in S3, where
  # an operator or agent CAN read it. Best-effort — never fails the deploy.
  { cat "$WLOG.status" "$WLOG"; } 2>/dev/null | aws s3 cp - "s3://${S3_BUCKET:-tax-api-storage-2026}/deploy-logs/worker-update-latest.txt" >/dev/null 2>&1 || true
  rm -f "$WLOG" "$WLOG.status"
else
  echo "[reload] TAX_API_EXTRACTION_FUNCTION unset — no worker to update"
fi

# Confirm rather than assume: every worker must report the same commit.
sleep 8
EXPECTED="$(git -C /opt/tax-api rev-parse --short HEAD)"
for attempt in 1 2 3 4 5 6; do
  SEEN="$(for _ in $(seq 1 8); do
            curl -s --max-time 5 http://127.0.0.1:3737/api/health
            echo
          done | grep -o '"commit":"[^"]*"' | sort -u | wc -l)"
  if [ "$SEEN" = "1" ]; then
    echo "[reload] all workers on ${EXPECTED} after attempt ${attempt}"
    exit 0
  fi
  echo "[reload] mixed builds still serving (${SEEN} distinct) — reloading again"
  pm2 reload tax-api --update-env
  sleep 8
done

echo "[reload] FAILED to converge on ${EXPECTED} — workers still mixed"
exit 1
