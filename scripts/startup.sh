#!/bin/bash
set -euo pipefail

# Read bucket name injected as VM metadata by the Discord bot
BUCKET=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/bucket-name")
export BUCKET

echo "[startup] Bucket: $BUCKET"

# Clean any stale flags from a previous crashed run
gsutil -q rm "gs://$BUCKET/status/ready.flag" 2>/dev/null || true
gsutil -q rm "gs://$BUCKET/status/done.flag" 2>/dev/null || true

# Download world save
echo "[startup] Syncing world save from GCS..."
gsutil -m rsync "gs://$BUCKET/saves/" /opt/valheim/worlds/ 2>/dev/null || true

# Start the shutdown HTTP server (receives POST /shutdown from the Discord bot)
nohup python3 /opt/valheim/shutdown-server.py \
  > /var/log/shutdown-server.log 2>&1 &

# Start Valheim headless server as the valheim system user
echo "[startup] Starting Valheim headless server..."
sudo -u valheim nohup /opt/valheim/valheim_server.x86_64 \
  -name "Valheim Server" \
  -world "Dedicated" \
  -password "changeme" \
  -savedir /opt/valheim/worlds \
  -port 2456 \
  -nographics \
  -batchmode \
  > /var/log/valheim.log 2>&1 &
VALHEIM_PID=$!

echo "[startup] Valheim PID: $VALHEIM_PID"

# Poll for up to 3 minutes until the Valheim process is confirmed alive
for i in $(seq 1 18); do
  if [ -f "/proc/$VALHEIM_PID/status" ]; then
    echo "[startup] Valheim process alive (attempt $i)"
    break
  fi
  if [ "$i" -eq 18 ]; then
    echo "[startup] ERROR: Valheim failed to start after 3 minutes"
    exit 1
  fi
  echo "[startup] Waiting for Valheim to start (attempt $i/18)..."
  sleep 10
done

# Write ready flag — Discord bot is polling for this
echo "ready" | gsutil cp - "gs://$BUCKET/status/ready.flag"
echo "[startup] Ready flag written. Server is up."
