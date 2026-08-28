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
