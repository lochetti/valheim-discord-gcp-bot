# gserver — Valheim Discord Bot

Discord bot that manages an on-demand Valheim dedicated server on GCP. The server only runs while you're playing — no idle costs.

- `/valheim start` — creates a COS VM, pulls the Docker image, loads the world from GCS, starts Valheim. Reports the IP when the server is accepting connections.
- `/valheim stop` — gracefully stops Valheim, saves the world to GCS, deletes the VM.

## How it works

```
Discord → Bot (Bun) → GCP Compute (COS VM)
                          └── Docker container (Valheim)
                                ├── world save ↔ GCS bucket
                                └── status flags → GCS bucket (ready.flag / done.flag)
```

**Start flow:** bot creates a COS VM with a container declaration pointing to the Docker image in Artifact Registry. The container syncs the world save from GCS, starts Valheim, and polls the log for `Opened Steam server`. Once found, it writes `status/ready.flag` to the bucket. The bot polls for the flag, then reports the IP to Discord.

**Stop flow:** bot sends `POST /shutdown` to port 8080 on the VM. The in-container HTTP server runs `stop.sh`, which gracefully stops Valheim, rsyncs the world back to GCS, then writes `status/done.flag`. The bot polls for the flag, then deletes the VM.

## Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated
- Docker or Podman (to build and push the image)
- Bun ([bun.sh](https://bun.sh))
- A Discord application with a bot token

## Setup

### 1. GCS bucket

```bash
gsutil mb -l southamerica-east1 gs://YOUR_BUCKET_NAME
```

Grant the VM's default service account access:

```bash
gsutil iam ch \
  serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com:roles/storage.objectAdmin \
  gs://YOUR_BUCKET_NAME
```

### 2. Artifact Registry repository

```bash
gcloud artifacts repositories create valheim \
  --repository-format=docker \
  --location=southamerica-east1
```

Grant the VM's default service account read access:

```bash
gcloud artifacts repositories add-iam-policy-binding valheim \
  --location=southamerica-east1 \
  --member="serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

### 3. Build and push the Docker image

```bash
# Authenticate (once per session)
gcloud auth print-access-token | \
  podman login -u oauth2accesstoken --password-stdin southamerica-east1-docker.pkg.dev

podman build -t southamerica-east1-docker.pkg.dev/YOUR_PROJECT/valheim/server:latest .
podman push southamerica-east1-docker.pkg.dev/YOUR_PROJECT/valheim/server:latest
```

The image includes: Ubuntu 22.04, SteamCMD, Valheim dedicated server, Google Cloud CLI. Rebuild and push whenever you change any file in `scripts/`.

### 4. Firewall rules

```bash
gcloud compute firewall-rules create valheim-game \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=udp:2456-2458

gcloud compute firewall-rules create valheim-shutdown \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:8080
```

### 5. Environment

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_APP_ID` | Application ID |
| `DISCORD_GUILD_ID` | Guild (server) ID to register commands to |
| `PROJECT_ID` | GCP project ID |
| `ZONE` | GCP zone (e.g. `southamerica-east1-b`) |
| `BUCKET_NAME` | GCS bucket name |
| `DOCKER_IMAGE` | Full image path in Artifact Registry |
| `MACHINE_TYPE` | GCP machine type (e.g. `e2-standard-2`) |
| `VM_NAME` | Name for the GCP VM (e.g. `valheim-server`) |
| `SHUTDOWN_PORT` | Port for the in-container shutdown server (`8080`) |
| `SERVER_PASSWORD` | Valheim server password |

### 6. Run the bot

```bash
bun install
bun run src/index.ts
```

The bot registers slash commands on startup and listens for interactions.

## Development

```bash
bun test        # run tests
bun --hot src/index.ts  # hot reload
```
