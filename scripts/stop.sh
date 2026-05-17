#!/bin/bash
set -euo pipefail

# BUCKET must be set in the environment before calling this script
: "${BUCKET:?BUCKET env var is required}"
: "${SERVER_NAME:?SERVER_NAME env var is required}"

echo "[stop] Stopping Valheim..."

VALHEIM_PID=$(pgrep -f "valheim_server.x86_64" || true)

if [ -n "$VALHEIM_PID" ]; then
  echo "[stop] Sending SIGTERM to PID $VALHEIM_PID..."
  kill -TERM "$VALHEIM_PID"

  # Wait up to 60 seconds for graceful exit
  for i in $(seq 1 12); do
    if ! kill -0 "$VALHEIM_PID" 2>/dev/null; then
      echo "[stop] Valheim exited cleanly"
      break
    fi
    echo "[stop] Waiting for Valheim to exit (attempt $i/12)..."
    sleep 5
  done

  # Force kill if still running after 60 seconds
  if kill -0 "$VALHEIM_PID" 2>/dev/null; then
    echo "[stop] Force killing Valheim..."
    kill -9 "$VALHEIM_PID" || true
    sleep 2
  fi
else
  echo "[stop] No Valheim process found, continuing with save upload..."
fi

# Upload world save to GCS
echo "[stop] Uploading world save to GCS..."
gsutil -m rsync -r /opt/valheim/worlds/ "gs://$BUCKET/saves/"

# Write done flag — Discord bot is polling for this
echo "done" | gsutil cp - "gs://$BUCKET/status/$SERVER_NAME/done.flag"
echo "[stop] Done flag written. Shutdown complete."
