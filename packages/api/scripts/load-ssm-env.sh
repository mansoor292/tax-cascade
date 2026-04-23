#!/usr/bin/env bash
# Dump /tax-api/* from SSM Parameter Store as shell `export KEY=value` lines.
#
# Why: tax-api's route files capture `process.env.X` at module-load time, and
# ESM hoists `import` statements above server.ts's in-process SSM loader —
# meaning any secret only in SSM (e.g. SUPABASE_SERVICE_ROLE_KEY) is undefined
# when the route modules grab it. Eval-ing this script's stdout into the
# deploy shell BEFORE `pm2 restart --update-env` plants those secrets in the
# shell env, which pm2 then propagates to node, which then has them at
# module-load.
#
# Usage (from the deploy webhook):
#   eval "$(scripts/load-ssm-env.sh)"
#   pm2 restart tax-api --update-env
#
# Safe to re-run; does not log values.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PREFIX="/tax-api/"

# Note on quoting: the python one-liner runs inside single quotes so bash leaves
# it untouched. Inside, we use double-quoted strings — those are python strings,
# not bash. Stdin is the JSON from aws; sys.stdin reads it, not a heredoc.
aws ssm get-parameters-by-path \
  --path "$PREFIX" \
  --with-decryption \
  --recursive \
  --region "$REGION" \
  --output json \
  | python3 -c 'import json, sys, shlex
for p in json.load(sys.stdin).get("Parameters", []):
    key = p["Name"].rsplit("/", 1)[-1]
    if key:
        print("export " + key + "=" + shlex.quote(p["Value"]))'
