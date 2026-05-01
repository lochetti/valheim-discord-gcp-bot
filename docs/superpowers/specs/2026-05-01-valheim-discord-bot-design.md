# Valheim Discord Bot — Design Spec

**Date:** 2026-05-01  
**Stack:** Bun + TypeScript + discord.js + @google-cloud/compute + @google-cloud/storage  
**Auth:** Application Default Credentials (ADC)

---

## Overview

A Discord bot that manages an on-demand Valheim game server on GCP. Two slash commands — `/valheim start` and `/valheim stop` — create and destroy a Compute Engine VM on demand. The VM is created from a custom image with Steam and Valheim pre-installed. The world save is persisted in a GCS bucket between sessions.

---

## Architecture

Single long-running Bun process. discord.js connects via WebSocket gateway. Both commands call `deferReply()` immediately, then drive an async polling loop that edits the same Discord message at each status change.

```
Discord User
    │
    │  /valheim start|stop
    ▼
discord.js (WebSocket gateway)
    │
    ├─ commands/start.ts ──► gcp/vm.ts (createVM)
    │                   ──► gcp/storage.ts (waitForFlag "status/ready.flag")
    │                   ──► editReply at each step
    │
    └─ commands/stop.ts ──► gcp/vm.ts (getVM → ip)
                        ──► HTTP POST <ip>:8080/shutdown
                        ──► gcp/storage.ts (waitForFlag "status/done.flag")
                        ──► gcp/vm.ts (deleteVM)
                        ──► editReply at each step
```

---

## File Structure

```
gserver/
├── src/
│   ├── index.ts              # Entry: load env, init discord.js, register commands, start gateway
│   ├── commands/
│   │   ├── start.ts          # /valheim start handler + polling loop
│   │   └── stop.ts           # /valheim stop handler + polling loop
│   └── gcp/
│       ├── vm.ts             # createVM(), deleteVM(), getVM() → { status, ip } | null
│       └── storage.ts        # waitForFlag(path, timeoutMs), deleteFlag(path)
├── scripts/
│   ├── startup.sh            # Runs on VM boot via metadata startup-script key
│   ├── stop.sh               # SIGTERM Valheim → wait → gsutil sync → write done.flag
│   └── shutdown-server.py    # HTTP server on :8080; POST /shutdown triggers stop.sh
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Data Flow

### `/valheim start`

1. `deferReply()`
2. `getVM("valheim-server")` — if exists: `editReply("⚠️ Server already running! IP: x.x.x.x")` → done
3. `editReply("🟡 Creating VM...")`
4. `createVM("valheim-server")` — injects `startup.sh` content as `startup-script` metadata key; also sets `bucket-name` metadata key so the script can read it via the GCP metadata endpoint
5. `editReply("🟡 VM created. Waiting for Valheim to start...")`
6. `waitForFlag("status/ready.flag", 10min)` — polls GCS every 10s
   - Timeout: `editReply("❌ Timed out. Check GCP console.")` → done (VM not force-deleted)
7. `deleteFlag("status/ready.flag")`
8. `getVM("valheim-server")` → ip
9. `editReply("✅ Server is up! Connect to: <ip>:2456")`

### `/valheim stop`

1. `deferReply()`
2. `getVM("valheim-server")` — if not found: `editReply("⚠️ No server running")` → done
3. `editReply("🟡 Sending shutdown signal...")`
4. `POST http://<ip>:8080/shutdown` — VM handles graceful stop asynchronously
   - HTTP failure: `editReply("❌ Could not reach VM. Check GCP console.")` → done
5. `editReply("🟡 Saving world & uploading to GCS...")`
6. `waitForFlag("status/done.flag", 5min)` — polls GCS every 10s
   - Timeout: `editReply("❌ Timed out. VM may still be running.")` → done (VM not deleted)
7. `deleteFlag("status/done.flag")`
8. `editReply("🟡 Deleting VM...")`
9. `deleteVM("valheim-server")`
10. `editReply("✅ Server stopped and VM deleted. World saved.")`

### VM startup sequence (`startup.sh`)

1. Read `BUCKET` from instance metadata: `curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/bucket-name`
2. Delete any stale `status/ready.flag` and `status/done.flag` from GCS
3. `gsutil -m rsync gs://$BUCKET/saves/ /opt/valheim/worlds/`
4. Start `shutdown-server.py` in the background (passing `$BUCKET` as env var)
5. Start Valheim headless as `valheim` user
6. Poll until Valheim PID is alive (`/proc/$PID/status`)
7. `echo "ready" | gsutil cp - gs://$BUCKET/status/ready.flag`

### VM stop sequence (`stop.sh`, triggered by `shutdown-server.py`)

1. Send `SIGTERM` to the Valheim process
2. Wait for Valheim to exit (`wait $PID`)
3. `gsutil -m rsync /opt/valheim/worlds/ gs://$BUCKET/saves/`
4. `echo "done" | gsutil cp - gs://$BUCKET/status/done.flag`

---

## Components

### `gcp/vm.ts`

- `createVM(name)` — creates `e2-standard-2` in `ZONE` from `IMAGE_NAME`; sets `startup-script` metadata key (content of `scripts/startup.sh` read from disk) and `bucket-name` metadata key (from `BUCKET_NAME` env var)
- `deleteVM(name)` — deletes the instance
- `getVM(name)` — queries GCP live; returns `{ status: string, ip: string }` or `null` if not found

VM is identified by a fixed name (`valheim-server`), eliminating the need for local state.

### `gcp/storage.ts`

- `waitForFlag(path, timeoutMs, intervalMs = 10000)` — resolves when the file exists in GCS, rejects on timeout
- `deleteFlag(path)` — deletes the flag file

### `scripts/shutdown-server.py`

Minimal Python HTTP server baked into the custom image at `/opt/valheim/shutdown-server.py`. Listens on `:8080`. `POST /shutdown` returns 202 immediately and runs `stop.sh` in a background thread.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `/start` while VM exists | Report existing IP, no-op |
| `/stop` with no VM | Report "no server running", no-op |
| `createVM` throws | Report GCP error, no orphaned resources |
| `waitForFlag("ready")` timeout | Warn user; do NOT force-delete VM |
| `POST /shutdown` fails | Report error; skip `done.flag` wait; warn user to check GCP |
| `waitForFlag("done")` timeout | Warn user; do NOT force-delete VM |
| Unhandled exception in handler | `editReply("❌ Unexpected error: <message>")` |
| Stale flag from crashed run | `startup.sh` deletes both flags at boot |

---

## Configuration

### `.env` variables

```
DISCORD_TOKEN=          # Bot token
DISCORD_APP_ID=         # Application ID
DISCORD_GUILD_ID=       # Guild ID (guild-scoped = instant command registration)
PROJECT_ID=             # GCP project ID
ZONE=southamerica-east1-b
BUCKET_NAME=            # GCS bucket name
IMAGE_NAME=             # Custom image name (e.g., valheim-base-v1)
MACHINE_TYPE=e2-standard-2
VM_NAME=valheim-server
SHUTDOWN_PORT=8080
```

### GCP firewall rules (manual setup, documented in README)

- `tcp:8080` — bot host → VM (shutdown endpoint)
- `udp:2456-2458` — players → VM (Valheim game ports)

### Command registration

Commands are registered on bot startup via Discord REST API. `DISCORD_GUILD_ID` scopes them to a single server for instant propagation (vs up to 1h for global commands).

---

## Custom Image Prerequisites (README)

Steps to build the base GCP image:

1. Create a Debian 12 VM in `southamerica-east1`
2. Install `steamcmd` and download Valheim dedicated server app (AppID 896660)
3. Create a `valheim` system user; chown `/opt/valheim/`
4. Copy `scripts/stop.sh` and `scripts/shutdown-server.py` to `/opt/valheim/`
5. Install Python 3 (for `shutdown-server.py`)
6. Install `google-cloud-storage` CLI (`gsutil` via `google-cloud-sdk`)
7. Snapshot the VM disk and create a custom image (`IMAGE_NAME`)

The `startup.sh` script is **not** baked into the image — it is injected via instance metadata on each VM creation, allowing updates without rebuilding the image. `stop.sh` and `shutdown-server.py` are baked in since they need to be available before the startup script completes.
