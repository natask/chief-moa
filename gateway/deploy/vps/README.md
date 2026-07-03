# VPS Gateway Deployment

This is the remote deployment path for the gateway: one Docker image, a
compose stack with Postgres, and Caddy for TLS. The same image runs hosted and
self-host; only env differs (`MOA_MODE`, see
`reference/openspec/changes/remote-hosted-gateway`). The target is a
DigitalOcean droplet, but any Ubuntu VPS with SSH works.

What stays off the VPS:

- Agent harnesses (Codex, Claude, Gemini) and their credentials. The VPS
  default harness is `echo`. Harness execution belongs to the user's execution
  machine (worker-pull model, separate change).
- Raw client secrets. Android and the extension hold only the gateway URL and
  the gateway token.

## Layout on the VPS

```text
/opt/chief-moa/app          git checkout (compose files, scripts)
/opt/chief-moa/gateway.env  compose env file (token, passwords, domain)
/opt/chief-moa/backups/     pg dumps + DATA_DIR snapshots
volumes: chief-moa_moa-gateway-data     DATA_DIR blobs (OTA APKs, voice audio)
         chief-moa_moa-postgres-data    Postgres data
         chief-moa_moa-caddy-data       TLS certificates
```

The named volumes are the shared event store. They survive image rebuilds,
gateway restarts, and git updates. A preview stack uses a different compose
project name (`-p moa-preview-x`), which gives it fresh volumes; that is a
preview path, never a rollback of the active store.

## Fresh droplet to running gateway

1. Create the droplet: Ubuntu 24.04 LTS, 2 GB RAM is enough to start, add your
   SSH key. Note the public IP.

2. Point DNS before first launch so certificate issuance succeeds:
   an A record `api.<your-domain>` to the droplet IP. Cloudflare-proxied is
   fine (the proxy passes WebSocket and the Let's Encrypt HTTP challenge). Per
   the remote-hosted-gateway design, the static frontend stays on Cloudflare
   Pages; only the API + voice WebSocket live here.

3. Bootstrap over SSH as root:

```sh
apt-get update && apt-get install -y git
git clone https://github.com/natask/chief-moa.git /opt/chief-moa/app
/opt/chief-moa/app/scripts/vps/bootstrap.sh \
  --domain api.example.com --email you@example.com
```

The script installs Docker, writes `/opt/chief-moa/gateway.env` with a
generated `MOA_GATEWAY_TOKEN` and Postgres password, opens 80/443 when ufw is
active, builds the image, starts gateway + Postgres + Caddy, and waits for the
healthcheck. Rerunning is safe: it never rewrites an existing env file and
never drops volumes.

4. Verify from anywhere:

```sh
curl -fsS https://api.example.com/health
```

`mode` should read `self-host` and `ok` should be true. The voice WebSocket is
`wss://api.example.com/v1/voice/sessions`.

5. Add model credentials (BYOK) by editing `/opt/chief-moa/gateway.env`
   (`MODEL_API_KEY`, or the Vertex/Gemini variables from
   `gateway/.env.example`), then:

```sh
cd /opt/chief-moa/app
docker compose -p chief-moa -f docker-compose.yml -f docker-compose.vps.yml \
  --env-file /opt/chief-moa/gateway.env up -d --no-deps gateway
```

## Point the clients at the VPS

Both clients already support a custom gateway URL; only their compiled
defaults still point at the old ZeroTier main machine.

Browser extension: open the extension settings and set the engine URL to
`https://api.example.com` plus the `MOA_GATEWAY_TOKEN` value (stored as
`ageeGatewayUrl` / `ageeGatewayToken`; a packaged build can bake the URL via
`agee.config.json`).

Android app: open the full app's gateway settings and set the gateway URL to
`https://api.example.com` plus the token. The voice socket derives
`wss://.../v1/voice/sessions` from the `https://` URL automatically
(`MoaVoiceGatewaySocket.voiceSocketUrl`).

Known stale-default (recorded, not fixed here — the voice agent owns Android):
`MoaPrefs.DEFAULT_GATEWAY_URL` and `MoaVoiceGatewaySocket.DEFAULT_URL` compile
in `http://10.147.17.10:8788` / `ws://10.147.17.10:8788/v1/voice/sessions`, and
`browser_extension/extension/config.js` bakes the same LAN default. A fresh
install therefore points at a LAN IP until the user sets the URL. Requirement:
defaults must move to a config-time value (or an explicit first-run setup
screen) when the VPS URL becomes the primary target.

## Update the running gateway

```sh
/opt/chief-moa/app/scripts/vps/update.sh --ref master
```

Order of operations: backup (`pg_dump` + `DATA_DIR` snapshot), restore check
against a scratch stack, move the checkout, rebuild the gateway image,
recreate only the gateway container. Postgres, Caddy, and all volumes stay up
and untouched; schema changes apply on gateway boot (`schema.sql` is
idempotent). If the backup or restore check fails, the update stops before
touching the active service.

## Promote a new version from your workstation

After the target branch is committed locally and ready to become the active VPS
gateway, run the local promotion wrapper from the repo checkout:

```sh
scripts/vps/push.sh --host root@203.0.113.7 --ref master
# or:
MOA_VPS_SSH=root@vps scripts/vps/push.sh --ref master
```

The script never guesses the host. It refuses uncommitted VPS deploy-path
changes, pushes the named local branch to `origin` only when origin is missing
that branch or is behind it, then SSHes to the VPS and runs
`/opt/chief-moa/app/scripts/vps/update.sh --ref <branch>`. For a non-default
checkout path, set `MOA_VPS_APP_DIR=/path/to/app`.

This is a promotion of the active gateway. Run it only when an operator has
explicitly approved deploy/promote for the current turn. The backup and restore
gate remains on the VPS inside `update.sh`, so the active service is not rebuilt
or restarted until the fresh backup and scratch restore check pass.

## Backup and restore check

```sh
/opt/chief-moa/app/scripts/vps/backup.sh
/opt/chief-moa/app/scripts/vps/restore-check.sh /opt/chief-moa/backups/<timestamp>
```

Run both before any promotion: an update, an active URL change, or an
active-service restart. The restore check rebuilds a scratch gateway from the
backup under its own compose project and port, verifies `/health` and a
Postgres-backed read, then removes itself. Copy backups off the droplet on a
schedule; they are plain files.

## Modes and required env

| Env | local | self-host | hosted |
| --- | --- | --- | --- |
| `MOA_GATEWAY_TOKEN` | optional | required at boot | required at boot |
| `DATABASE_URL` | optional (file fallback) | required at boot | required at boot |
| bind default | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| proxy headers trusted | no | yes | yes |

`HOST` and `MOA_TRUST_PROXY` override the mode defaults. `hosted` is
`self-host` plus per-user accounts and backup expectations as they land
(better-auth is a separate task in the same change). Minimum env for a
self-host run: `MOA_MODE`, `MOA_GATEWAY_TOKEN`, `POSTGRES_PASSWORD` (or an
external `DATABASE_URL`), `MOA_DOMAIN`, `ACME_EMAIL`, and one model provider's
credentials. Full reference: `gateway/deploy/vps/gateway.env.example`.

## One-image PaaS (Railway or similar)

The same image runs on any one-image PaaS with managed Postgres: deploy
`gateway/Dockerfile`, attach a persistent volume at `/data`, set
`MOA_MODE=self-host`, `MOA_GATEWAY_TOKEN`, and `DATABASE_URL` from the managed
database, and let the platform terminate TLS (skip the Caddy overlay). The
gateway refuses to boot if `DATABASE_URL` or the token is missing, so a
misconfigured deploy fails loudly instead of writing to container-local files.

## Local smoke of the exact VPS stack

```sh
cat > /tmp/gateway.env <<EOF
MOA_MODE=self-host
MOA_GATEWAY_TOKEN=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 32)
GATEWAY_PORT=18787
EOF
docker compose -p moa-local --env-file /tmp/gateway.env up -d --build
curl -fsS http://127.0.0.1:18787/health
docker compose -p moa-local --env-file /tmp/gateway.env down -v
```
