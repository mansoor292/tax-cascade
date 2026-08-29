#!/usr/bin/env bash
# Build the extraction worker's Lambda zip.
#
# Bundled with esbuild rather than shipped as a container image, for one
# practical reason: this produces an artifact that can be built AND executed on
# any machine with node, so the worker is testable before it is ever deployed.
# A container image would need docker plus the Lambda runtime emulator to get
# the same confidence.
#
# Bundling also removes two runtime hazards outright:
#   - no tsx at runtime, so the Lambda runtime never has to resolve a .ts
#     handler file
#   - @taxengine/shared exports raw TypeScript and emits no JS, so anything
#     running under plain node must have it inlined — esbuild does that at
#     build time
#
# LAYOUT MATTERS. maps/field_maps.ts computes its data directory from its own
# module URL:
#     __dirname = dirname(fileURLToPath(import.meta.url))
#     DATA_DIR  = join(__dirname, '../../data/field_maps')
# In a bundle that URL is the BUNDLE's path, so the zip mirrors the source tree
# (src/worker/handler.mjs + data/field_maps) to keep that relative hop correct.
# Moving the handler without moving the data is how field maps go missing at
# runtime.
#
# The AWS SDK is bundled, not marked external. The Node 22 Lambda runtime ships
# only a subset of @aws-sdk clients, and this depends on textract, s3, kms, ssm
# and lambda — cheaper to carry them than to discover which one is absent.
set -euo pipefail

cd "$(dirname "$0")/.."   # packages/api

OUT="${1:-dist-worker}"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT/src/worker"

npx esbuild src/worker/extract_handler.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --outfile="$OUT/src/worker/handler.mjs" \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

# Needed at runtime: archiving a prior return resolves canonical fields through
# these. data/irs_forms is NOT included — that is ~10MB of blank PDFs used only
# by the PDF builders, which the worker never calls.
mkdir -p "$OUT/data"
cp -r data/field_maps "$OUT/data/field_maps"

# python's zipfile rather than the zip(1) binary, which is not installed
# everywhere (this box included) and would make the build host-dependent.
python3 - "$OUT" <<'ZIP'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out + '.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(out):
        for f in sorted(files):
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, out))
ZIP
echo "built $OUT.zip ($(du -h "$OUT.zip" | cut -f1)) — handler: src/worker/handler.handler"
