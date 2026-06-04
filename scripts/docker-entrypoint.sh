#!/bin/bash
set -euo pipefail

: "${BUCKET:?BUCKET env var is required}"
: "${SERVER_PASSWORD:?SERVER_PASSWORD env var is required}"
: "${SERVER_NAME:?SERVER_NAME env var is required}"

echo "[entrypoint] Bucket: $BUCKET"

# Clean stale flags
gsutil -q rm "gs://$BUCKET/status/$SERVER_NAME/ready.flag" 2>/dev/null || true
gsutil -q rm "gs://$BUCKET/status/$SERVER_NAME/done.flag" 2>/dev/null || true

# Sync world save from GCS
echo "[entrypoint] Syncing world save from GCS..."
gsutil -m rsync -r "gs://$BUCKET/saves/$SERVER_NAME/" /opt/valheim/worlds/ 2>/dev/null || true

# Start shutdown HTTP server
nohup python3 /opt/valheim/shutdown-server.py \
  > /var/log/shutdown-server.log 2>&1 &

# Start Valheim
echo "[entrypoint] Starting Valheim headless server..."
cd /opt/valheim
export SteamAppId=892970
export LD_LIBRARY_PATH=/opt/valheim/linux64:${LD_LIBRARY_PATH:-}

/opt/valheim/valheim_server.x86_64 \
  -name "Valheim Server" \
  -world "Dedicated" \
  -password "$SERVER_PASSWORD" \
  -savedir /opt/valheim/worlds \
  -port 2456 \
  -nographics \
  -batchmode \
  > /var/log/valheim.log 2>&1 &
VALHEIM_PID=$!

echo "[entrypoint] Valheim PID: $VALHEIM_PID"

# Wait up to 10 minutes for Valheim to finish loading the world.
# "DungeonDB Start" appears in the log only after the world is fully loaded
# and the server is ready to accept connections.
READY=false
for i in $(seq 1 120); do
  if ! [ -f "/proc/$VALHEIM_PID/status" ]; then
    echo "[entrypoint] ERROR: Valheim process died before becoming ready"
    exit 1
  fi
  if grep -q "Opened Steam server" /var/log/valheim.log 2>/dev/null; then
    READY=true
    break
  fi
  echo "[entrypoint] Waiting for world to load (attempt $i/120)..."
  sleep 5
done

if [ "$READY" != "true" ]; then
  echo "[entrypoint] ERROR: Valheim failed to become ready after 10 minutes"
  exit 1
fi

echo "ready" | gsutil cp - "gs://$BUCKET/status/$SERVER_NAME/ready.flag"
echo "[entrypoint] Ready flag written. Server is accepting connections."

# Keep container alive — stop.sh (triggered via /shutdown) will write done.flag,
# then the bot deletes the VM. Exiting here would kill stop.sh mid-cleanup.
sleep infinity
