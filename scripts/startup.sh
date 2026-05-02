#!/bin/bash
set -euo pipefail

BUCKET=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/bucket-name")

TOKEN=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | sed 's/.*"access_token":"\([^"]*\)".*/\1/')

curl -sf -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "https://storage.googleapis.com/storage/v1/b/$BUCKET/o/status%2Fready.flag" || true
curl -sf -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "https://storage.googleapis.com/storage/v1/b/$BUCKET/o/status%2Fdone.flag" || true

echo "[startup] Stale flags cleared. Container will be started by COS."
