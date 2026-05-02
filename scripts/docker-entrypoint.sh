#!/bin/bash
set -euo pipefail

: "${BUCKET:?BUCKET env var is required}"
: "${SERVER_PASSWORD:?SERVER_PASSWORD env var is required}"

echo "[entrypoint] Bucket: $BUCKET"

# Clean stale flags
gsutil -q rm "gs://$BUCKET/status/ready.flag" 2>/dev/null || true
gsutil -q rm "gs://$BUCKET/status/done.flag" 2>/dev/null || true

# Sync world save from GCS
echo "[entrypoint] Syncing world save from GCS..."
gsutil -m rsync "gs://$BUCKET/saves/" /opt/valheim/worlds/ 2>/dev/null || true

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

for i in $(seq 1 18); do
  if [ -f "/proc/$VALHEIM_PID/status" ]; then
    echo "[entrypoint] Valheim process alive (attempt $i)"
    break
  fi
  if [ "$i" -eq 18 ]; then
    echo "[entrypoint] ERROR: Valheim failed to start after 3 minutes"
    exit 1
  fi
  echo "[entrypoint] Waiting for Valheim to start (attempt $i/18)..."
  sleep 10
done

echo "ready" | gsutil cp - "gs://$BUCKET/status/ready.flag"
echo "[entrypoint] Ready flag written. Server is up."

# Keep container alive — stop.sh (triggered via /shutdown) will write done.flag,
# then the bot deletes the VM. Exiting here would kill stop.sh mid-cleanup.
sleep infinity
