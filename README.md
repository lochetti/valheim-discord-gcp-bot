# gserver — Valheim Discord Bot

Discord bot that manages an on-demand Valheim dedicated server on GCP.
`/valheim start` — spins up a VM, downloads the world save, starts Valheim.
`/valheim stop` — saves the world to GCS, shuts down Valheim, deletes the VM.

## Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated (`gcloud auth login`)
- Application Default Credentials configured (`gcloud auth application-default login`)
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- Bun installed ([bun.sh](https://bun.sh))

---

## 1. Create the GCS Bucket

```bash
gsutil mb -l southamerica-east1 gs://YOUR_BUCKET_NAME
gsutil mb gs://YOUR_BUCKET_NAME/saves/
gsutil mb gs://YOUR_BUCKET_NAME/status/
```

Grant the VM's service account access:

```bash
gsutil iam ch serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com:roles/storage.objectAdmings://YOUR_BUCKET_NAME
```

---

## 2. Build the Custom GCP Image

The custom image has Steam, SteamCMD, and Valheim pre-installed so VM boot time is fast.

**2a. Create a base VM:**

```bash
gcloud compute instances create valheim-image-builder \
  --zone=southamerica-east1-b \
  --machine-type=e2-standard-2 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=50GB
```

**2b. SSH in and set up Valheim:**

```bash
gcloud compute ssh valheim-image-builder --zone=southamerica-east1-b
```

Inside the VM:

```bash
# Install dependencies
sudo apt-get update && sudo apt-get install -y lib32gcc-s1 python3 curl

# Install Google Cloud SDK (for gsutil)
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
sudo apt-get update && sudo apt-get install -y google-cloud-cli

# Create valheim user and directories
sudo useradd -r -s /bin/bash -d /opt/valheim valheim
sudo mkdir -p /opt/valheim/worlds
sudo chown -R valheim:valheim /opt/valheim

# Install SteamCMD
cd /tmp
curl -sqL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar xvz
sudo mv steamcmd.sh /usr/local/bin/steamcmd

# Download Valheim dedicated server (AppID 896660)
sudo -u valheim /usr/local/bin/steamcmd \
  +@sSteamCmdForcePlatformType linux \
  +force_install_dir /opt/valheim \
  +login anonymous \
  +app_update 896660 validate \
  +quit
```

**2c. Copy scripts to the VM:**

```bash
# From your local machine:
gcloud compute scp scripts/stop.sh valheim-image-builder:/tmp/ --zone=southamerica-east1-b
gcloud compute scp scripts/shutdown-server.py valheim-image-builder:/tmp/ --zone=southamerica-east1-b

# Back in the VM SSH session:
sudo mv /tmp/stop.sh /opt/valheim/stop.sh
sudo mv /tmp/shutdown-server.py /opt/valheim/shutdown-server.py
sudo chmod +x /opt/valheim/stop.sh
sudo chown valheim:valheim /opt/valheim/stop.sh /opt/valheim/shutdown-server.py
```

**2d. Create the image:**

```bash
# Stop the VM first
gcloud compute instances stop valheim-image-builder --zone=southamerica-east1-b

# Create image from disk
gcloud compute images create valheim-base-v1 \
  --source-disk=valheim-image-builder \
  --source-disk-zone=southamerica-east1-b \
  --description="Valheim dedicated server base image"

# Clean up the builder VM
gcloud compute instances delete valheim-image-builder --zone=southamerica-east1-b
```

---

## 3. Set Up Firewall Rules

```bash
# Valheim game ports (UDP) — open to all players
gcloud compute firewall-rules create valheim-game \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=udp:2456-2458 \
  --target-tags=valheim-server

# Shutdown endpoint (TCP 8080) — restrict to your bot host's IP
gcloud compute firewall-rules create valheim-shutdown \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:8080 \
  --source-ranges=YOUR_BOT_HOST_IP/32 \
  --target-tags=valheim-server
```

> To apply these tags to VMs created by the bot, add `tags: { items: ["valheim-server"] }` to the `instanceResource` in `src/gcp/vm.ts`.

---

## 4. Configure the Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → add a bot
3. Copy the **Bot Token** and **Application ID**
4. Invite the bot to your server with `applications.commands` scope

---

## 5. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

---

## 6. Run the Bot

```bash
bun install
bun run src/index.ts
```

The bot registers slash commands on startup and then listens for interactions. Use `/valheim start` and `/valheim stop` in your Discord server.

---

## Updating `startup.sh` Without Rebuilding the Image

`startup.sh` is injected as VM metadata on each `/valheim start` — edit `scripts/startup.sh` and restart the bot. No image rebuild needed.

To update `stop.sh` or `shutdown-server.py`, rebuild the image (step 2).
