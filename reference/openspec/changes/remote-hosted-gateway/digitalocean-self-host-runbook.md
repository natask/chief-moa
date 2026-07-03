# DigitalOcean Self-Host Runbook

Last reviewed: 2026-07-03.

This is the DigitalOcean droplet path for a self-hosted Chief Moa gateway
preview. It uses the same gateway image built from `gateway/Dockerfile`, a
Postgres container, and a persistent block-storage volume for both Postgres and
`DATA_DIR`. It is not an active deployment approval.

## Target Shape

```text
DigitalOcean Droplet
  Docker or Ubuntu with Docker Engine and Compose
  Caddy/nginx on 443 -> 127.0.0.1:8787

DigitalOcean volume
  /mnt/moa-gateway-state/gateway-data   -> gateway DATA_DIR
  /mnt/moa-gateway-state/postgres-data  -> Postgres PGDATA

Cloudflare
  api.<domain> proxied to droplet public IP
```

The VPS gateway stores routing, provider credentials, Postgres state, voice
sessions, OTA artifacts, device/worker tokens, and queued runs. It does not run
Codex, Claude, Gemini, or other local harnesses. Harness work stays on the
execution machine and connects outbound through the worker-pull contract.

## Provision Droplet

1. Create a droplet in the intended region.
2. Use the DigitalOcean Docker Marketplace image, or install Docker Engine and
   the Compose plugin on Ubuntu.
3. Add an SSH key. Disable password SSH if this is more than a throwaway
   preview.
4. Create a cloud firewall:
   - allow SSH only from operator IPs or a trusted admin network;
   - allow `80` and `443`;
   - deny public `5432`;
   - deny public `8787`.
5. Install Caddy or nginx for origin TLS and reverse proxying.

After SSH:

```sh
docker version
docker compose version
```

## Attach And Mount The Volume

Create a DigitalOcean block storage volume in the same region as the droplet.
Attach it to the droplet and mount it at:

```text
/mnt/moa-gateway-state
```

If DigitalOcean automatic format/mount is not used, the manual shape is:

```sh
sudo mkdir -p /mnt/moa-gateway-state
sudo mount -o defaults,nofail,discard,noatime \
  /dev/disk/by-id/<digitalocean-volume-id> \
  /mnt/moa-gateway-state
findmnt /mnt/moa-gateway-state
```

Make the mount persistent with `/etc/fstab` and verify it before reboot:

```text
/dev/disk/by-id/<digitalocean-volume-id> /mnt/moa-gateway-state ext4 defaults,nofail,discard,noatime 0 2
```

```sh
sudo findmnt --verify --verbose
```

Create state directories:

```sh
sudo install -d -m 0750 /mnt/moa-gateway-state/gateway-data
sudo install -d -m 0700 /mnt/moa-gateway-state/postgres-data
sudo chown 1000:1000 /mnt/moa-gateway-state/gateway-data
```

Do not delete this volume during image rebuilds or rollback.

## Build Or Pull The Gateway Image

Build from a reviewed commit:

```sh
sudo install -d -m 0755 /opt/chief-moa
cd /opt/chief-moa
git clone <repo-url> source
cd source
git checkout <approved-sha>
docker build -t chief-moa-gateway:<approved-sha> gateway
```

If a registry is available, pull the same reviewed image instead:

```sh
docker pull <registry>/chief-moa-gateway:<approved-sha>
docker tag <registry>/chief-moa-gateway:<approved-sha> chief-moa-gateway:<approved-sha>
```

Use immutable tags or digests for promotion candidates. Do not deploy `latest`
as the active target.

## Environment Shape

Create a VPS-local env file. Do not commit it and do not print it in logs.

```sh
sudo install -m 0600 -o root -g root /dev/null /opt/chief-moa/gateway.env
sudo editor /opt/chief-moa/gateway.env
```

Required shape:

```env
MOA_GATEWAY_IMAGE_TAG=<approved-sha>
MOA_MODE=self-host
MOA_GATEWAY_TOKEN=<long-random-owner-token>
POSTGRES_PASSWORD=<long-random-postgres-password>

GATEWAY_BIND=127.0.0.1
GATEWAY_PORT=8787

DEFAULT_AGENT_HARNESS=echo
VOICE_MULTI_AGENT_HARNESSES=echo
ALLOW_AGENT_WITHOUT_TOKEN=0

MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_ID=gpt-4o-mini
MODEL_API_KEY=<provider-key-if-model-calls-are-enabled>

VOICE_PROVIDER=loopback
VOICE_STT_PROVIDER=loopback
VOICE_LLM_PROVIDER=loopback
VOICE_TTS_PROVIDER=loopback
```

Notes:

- Remote modes require auth and Postgres. Do not omit
  `MOA_GATEWAY_TOKEN` or `DATABASE_URL`.
- The compose file below builds `DATABASE_URL` from `POSTGRES_PASSWORD`.
- Start with loopback voice to prove transport before enabling Gemini Live,
  Vertex Live, or Chirp.
- Provider credential files, if needed later, are mounted at runtime. They are
  never baked into the image.

## Compose File

Save this VPS-local file as `/opt/chief-moa/docker-compose.yml`:

```yaml
services:
  gateway:
    image: chief-moa-gateway:${MOA_GATEWAY_IMAGE_TAG:?set MOA_GATEWAY_IMAGE_TAG}
    init: true
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "${GATEWAY_BIND:-127.0.0.1}:${GATEWAY_PORT:-8787}:8787"
    environment:
      MOA_MODE: ${MOA_MODE:-self-host}
      HOST: 0.0.0.0
      PORT: 8787
      DATA_DIR: /data
      ANDROID_OTA_DIR: /data/android-ota
      DATABASE_URL: postgres://moa:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/moa_gateway
      MOA_GATEWAY_TOKEN: ${MOA_GATEWAY_TOKEN:?set MOA_GATEWAY_TOKEN}
      ALLOW_AGENT_WITHOUT_TOKEN: "0"
      DEFAULT_AGENT_HARNESS: ${DEFAULT_AGENT_HARNESS:-echo}
      VOICE_MULTI_AGENT_HARNESSES: ${VOICE_MULTI_AGENT_HARNESSES:-echo}
      MODEL_PROVIDER: ${MODEL_PROVIDER:-openai-compatible}
      MODEL_BASE_URL: ${MODEL_BASE_URL:-https://api.openai.com/v1}
      MODEL_ID: ${MODEL_ID:-gpt-4o-mini}
      MODEL_API_KEY: ${MODEL_API_KEY:-}
      VOICE_PROVIDER: ${VOICE_PROVIDER:-loopback}
      VOICE_STT_PROVIDER: ${VOICE_STT_PROVIDER:-loopback}
      VOICE_LLM_PROVIDER: ${VOICE_LLM_PROVIDER:-loopback}
      VOICE_TTS_PROVIDER: ${VOICE_TTS_PROVIDER:-loopback}
      VERTEX_PROJECT: ${VERTEX_PROJECT:-}
      VERTEX_LOCATION: ${VERTEX_LOCATION:-global}
      GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT:-}
      GOOGLE_CLOUD_LOCATION: ${GOOGLE_CLOUD_LOCATION:-global}
      GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS:-}
      VERTEX_EXPRESS_API_KEY: ${VERTEX_EXPRESS_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      GCP_PROJECT_ID: ${GCP_PROJECT_ID:-}
      GCP_LOCATION: ${GCP_LOCATION:-us}
      CHIRP_MODEL: ${CHIRP_MODEL:-chirp_3}
      CHIRP_LANGUAGE_CODES: ${CHIRP_LANGUAGE_CODES:-en-US}
    volumes:
      - /mnt/moa-gateway-state/gateway-data:/data
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e "const port = process.env.PORT || '8787'; fetch('http://127.0.0.1:' + port + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
    stop_grace_period: 30s

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: moa_gateway
      POSTGRES_USER: moa
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    volumes:
      - /mnt/moa-gateway-state/postgres-data:/var/lib/postgresql/data
    healthcheck:
      test:
        - CMD-SHELL
        - pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    stop_grace_period: 30s
```

Validate config without printing secrets:

```sh
cd /opt/chief-moa
docker compose --env-file /opt/chief-moa/gateway.env config --quiet
```

Start:

```sh
cd /opt/chief-moa
docker compose --env-file /opt/chief-moa/gateway.env up -d
docker compose --env-file /opt/chief-moa/gateway.env ps
```

## Healthcheck And Local Smoke

From the droplet:

```sh
curl -fsS http://127.0.0.1:8787/health
docker compose --env-file /opt/chief-moa/gateway.env logs --since 10m gateway
```

From the repository checkout on an operator machine:

```sh
node gateway/deploy/main-machine/smoke-voice-session.js \
  wss://api.<domain>/v1/voice/sessions \
  "$MOA_GATEWAY_TOKEN"
```

If OTA and real voice are intentionally configured:

```sh
cd gateway
MOA_GATEWAY_TOKEN="$MOA_GATEWAY_TOKEN" \
  npm run smoke:main-machine -- https://api.<domain>
```

Pass criteria:

- Docker reports both services healthy.
- `/health` returns `ok: true`.
- `event_substrate` reports Postgres configured when remote-mode hardening is
  in place.
- Voice smoke reaches `turn_done`.
- No public connection is possible to `:5432` or `:8787`.

## DNS And TLS

Use `cloudflare-dns-tls-runbook.md` for the Cloudflare record and origin TLS
steps. The droplet should expose only the reverse proxy on `443` to clients.

Minimal Caddy shape:

```caddyfile
api.<domain> {
  reverse_proxy 127.0.0.1:8787
}
```

After Caddy/nginx is active:

```sh
curl -fsS https://api.<domain>/health
```

## Backup Gate

Run before any active URL change, active-service restart, or promotion.

Create a backup directory:

```sh
sudo install -d -m 0700 /mnt/moa-gateway-state/backups
backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
```

Dump Postgres:

```sh
cd /opt/chief-moa
docker compose --env-file /opt/chief-moa/gateway.env exec -T postgres \
  pg_dump -U moa -d moa_gateway -Fc \
  > "/mnt/moa-gateway-state/backups/moa_gateway_${backup_id}.dump"
```

Archive `DATA_DIR`:

```sh
sudo tar -C /mnt/moa-gateway-state \
  -czf "/mnt/moa-gateway-state/backups/gateway_data_${backup_id}.tgz" \
  gateway-data
```

Flush filesystem writes before a DigitalOcean volume snapshot:

```sh
sync
```

Then take a DigitalOcean snapshot of the volume from the control panel or
`doctl`. Volume snapshots are crash-consistent at the block layer; the Postgres
dump is the database-consistent artifact. Do not treat a volume snapshot alone
as sufficient for database promotion.

Restore check:

1. Copy the dump and data archive to a scratch droplet or scratch Compose
   project.
2. Restore the dump into a scratch Postgres service.
3. Extract the data archive into a scratch `gateway-data` directory.
4. Start a scratch gateway with `MOA_MODE=self-host`, scratch `DATABASE_URL`,
   scratch `DATA_DIR`, and loopback voice.
5. Verify `/health` and one core read path, such as `GET /v1/agent/runs` with
   the scratch token.

Promotion is blocked if this restore check is missing or fails.

## Rollback

Image rollback:

1. Keep the previous image tag or digest recorded before every change.
2. Set `MOA_GATEWAY_IMAGE_TAG=<previous-sha>` in `/opt/chief-moa/gateway.env`.
3. Run:

```sh
cd /opt/chief-moa
docker compose --env-file /opt/chief-moa/gateway.env up -d gateway
curl -fsS http://127.0.0.1:8787/health
```

State rollback:

- Never delete or recreate `/mnt/moa-gateway-state` during image rollback.
- If a schema or state migration makes image rollback unsafe, restore the
  Postgres dump and `DATA_DIR` archive into a scratch target first.
- Restore active state only inside an approved maintenance window.

## External References

- DigitalOcean Droplets:
  https://docs.digitalocean.com/products/droplets/how-to/create/
- DigitalOcean Docker image:
  https://docs.digitalocean.com/products/marketplace/catalog/docker/
- DigitalOcean volumes:
  https://docs.digitalocean.com/products/volumes/how-to/create/
- DigitalOcean mount and fstab:
  https://docs.digitalocean.com/products/volumes/how-to/mount-unmount/
- DigitalOcean volume snapshots:
  https://docs.digitalocean.com/products/snapshots/how-to/snapshot-volumes/
