#!/usr/bin/env bash
# Read the /mcp request ring buffer from prod — both pm2 workers, deduped,
# chronological. The one job of this script is to never repeat the mistake
# that hid a full buffer behind a broken ad-hoc reader: each curl response is
# one JSON document, NOT one line.
#
#   scripts/mcp-recent.sh            # everything
#   scripts/mcp-recent.sh Claude     # filter (grep -i on the rendered lines)
set -euo pipefail
KEY="$(aws ssm get-parameter --name /tax-api/TAX_API_KEYS --with-decryption \
  --query 'Parameter.Value' --output text | cut -d, -f1)"
TMP="$(mktemp -d)"
for i in $(seq 1 10); do
  curl -s -m 15 https://tax-api.catalogshub.com/api/mcp-recent \
    -H "X-API-Key: $KEY" -o "$TMP/$i.json" || true
done
python3 - "$TMP" <<'PY'
import json, sys, glob
seen = {}
for f in glob.glob(sys.argv[1] + '/*.json'):
    try: d = json.load(open(f))
    except Exception: continue
    for e in d.get('recent', []):
        seen[(e.get('ts'), e.get('auth'), e.get('ip'), e.get('rpc'))] = e
for k in sorted(seen):
    e = seen[k]
    line = (f"{e['ts']}  {e['method']:4} {str(e.get('rpc') or ''):22} "
            f"{str(e.get('tool') or ''):24} status={str(e.get('status')):>6} "
            f"ms={str(e.get('ms')):>5} auth={str(e.get('auth')):<14} "
            f"ip={str(e.get('ip')):<16} ua={str(e.get('ua'))[:40]}")
    print(line)
    if e.get('resp'): print(f"    └─ resp: {e['resp'][:200]}")
print('---', len(seen), 'distinct requests')
PY
rm -rf "$TMP"
