# VPS Gateway Deployment

This is the remote deployment path for the gateway: one Docker image, a
compose stack with Postgres, and Caddy for TLS. The same image runs hosted and
self-host; only env differs (`MOA_MODE`, see
`reference/openspec/changes/remote-hosted-gateway`). The default target is a
DigitalOcean droplet, but any Ubuntu VPS with SSH works.

Default target:

```text
Provider: DigitalOcean Droplet
Region:   sfo3
Size:     s-2vcpu-4gb first, resize down only after observing memory
Image:    Ubuntu 24.04 LTS
DNS:      api.agee.app proxied through Cloudflare
Host dir: /opt/chief-moa/app
```

Cloudflare Pages can continue serving static surfaces. The API and voice
WebSocket live on the VPS:

- HTTP API: `https://api.agee.app`
- Voice WebSocket: `wss://api.agee.app/v1/voice/sessions`

What stays off the VPS:

- Agent harnesses (Codex, Claude, Gemini) and their credentials. The VPS
  default harness is `echo`. Harness execution belongs to the user's execution
  machine (worker-pull model, separate change).
- Raw client secrets. Android and the extension hold only the gateway URL and
  the gateway token.

## Layout On The VPS

```text
/opt/chief-moa/app          git checkout (compose files, scripts)
/opt/chief-moa/gateway.env  compose env file (token, passwords, domain)
volumes: chief-moa_moa-gateway-data     DATA_DIR blobs (OTA APKs, voice audio)
         chief-moa_moa-postgres-data    Postgres data
         chief-moa_moa-caddy-data       TLS certificates
```

The named volumes are the shared event store. They survive image rebuilds,
gateway restarts, and git updates. A preview stack uses a different compose
project name (`-p moa-preview-x`), which gives it fresh volumes; that is a
preview path, never a rollback of the active store.

## Fresh Droplet To Running Gateway

1. Create the droplet: Ubuntu 24.04 LTS, 2 GB RAM minimum, SSH key enabled.

2. Point DNS before first launch so certificate issuance succeeds:
   an A record `api.<your-domain>` to the droplet IP. Cloudflare-proxied is
   fine; the proxy passes WebSocket and the Let's Encrypt HTTP challenge.

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

`mode` should read `self-host`, `ok` should be true, and
`gateway_mode.remote` should be true.

5. Add model credentials (BYOK) by editing `/opt/chief-moa/gateway.env`
   (`MODEL_API_KEY`, or the Vertex/Gemini variables from
   `gateway/.env.example`), then:

```sh
cd /opt/chief-moa/app
docker compose -p chief-moa -f docker-compose.yml -f docker-compose.vps.yml \
  --env-file /opt/chief-moa/gateway.env up -d --no-deps gateway
```

## Point The Clients At The VPS

Both clients support a custom gateway URL and token.

Browser extension: open the extension settings and set the engine URL plus the
`MOA_GATEWAY_TOKEN` value (stored as `ageeGatewayUrl` / `ageeGatewayToken`). A
packaged build can bake the URL with:

```sh
cd browser_extension
AGEE_GATEWAY_URL=https://api.example.com \
AGEE_GATEWAY_TOKEN=<gateway-token> \
npm run configure
```

Android app: open the full app's gateway settings and set the gateway URL plus
the token. The voice socket derives `wss://.../v1/voice/sessions` from the
`https://` URL automatically (`MoaVoiceGatewaySocket.voiceSocketUrl`). A
packaged Android build can set the default with:

```sh
MOA_DEFAULT_GATEWAY_URL=https://api.example.com bash scripts/deploy.sh android
```

The current default client endpoint is `https://api.agee.app`; stale LAN
defaults are migrated only when no token has been stored.

## Update The Running Gateway

One-time promotion-worker setup generates distinct scoped credentials without
printing them, writes the root-only worker environment, and installs the
systemd environment drop-in. It does not restart the gateway; run backup and
restore-check and verify the live drain before recreating the gateway once to
load the new role credentials:

```sh
scripts/vps/install-promotion-control-plane.sh --install
```

After that bootstrap, CI advances only the verified `vps-deploy` ref. The VPS
timer runs `scripts/vps/promote-candidate.sh`, which creates an isolated
candidate checkout and Compose stack, checks the candidate against a restored
active backup, records the M4 chain, then delegates the active mutation to the
guarded updater. Missing credentials or an active voice turn safely defer the
timer instead of weakening the gate.

Install the timer with `scripts/vps/install-auto-update.sh`. It polls 90 seconds
after boot, then waits until each one-shot worker has finished before starting
the next 120-second delay. The installer removes the retired
`chief-moa-auto-update.timer.d/interval.conf` activation-relative override; do
not restore an `OnUnitActiveSec` trigger for this long-running worker.

```sh
/opt/chief-moa/app/scripts/vps/update.sh --ref master
```

Order of operations: backup (`pg_dump` + `DATA_DIR` snapshot), restore check
against a scratch stack, move the checkout, rebuild the gateway image,
recreate only the gateway container. Postgres, Caddy, and all volumes stay up
and untouched; schema changes apply on gateway boot (`schema.sql` is
idempotent). If the backup or restore check fails, the update stops before
touching the active service. After the checkout begins to move, failures through
checkout, build, final evidence validation, container recreation, health, and
Caddy reload idempotently restore the previous checkout, gateway, edge config,
and prior local receipt.

The M4 effect is the point of no blind return. Immediately before sending it,
the promoter atomically writes a durable phase journal. If the effect request
may have been accepted, the candidate remains active even when the client sees
an error: rolling it back would contradict immutable M4 state. The failed
command preserves its original exit code and prints the recovery command. Run:

```sh
scripts/vps/recover-promotion.sh \
  --journal /opt/chief-moa/app/.deploy-markers/gateway-promotion-journal.json
```

Recovery queries M4 and never reapplies or restarts the gateway. It receipts an
existing effect using the original live claim, or—after claim expiry—requires a
current scoped apply credential and explicit `MOA_RECOVERY_WORKER_ID` and
`MOA_RECOVERY_CLAIM_ID` for audited adoption. If M4 already has the receipt, it
only recreates the verified local mirror. The journal and retained prior receipt
backup are cleared after effect, immutable receipt, and local mirror all agree.

The rollback/recovery boundary has a no-I/O adversarial harness:

```sh
bash scripts/vps/test-update-rollback.sh
```

It replaces Git, Docker, Caddy, health checks, evidence validation, and receipt
recording with temporary fakes; it does not contact or mutate a live service.

## Promote A New Version From Your Workstation

After the exact candidate is committed locally and ready to become the active
VPS gateway, run the local-first release entrypoint:

```sh
bash scripts/deploy.sh gateway \
  --direct-deploy --target chief-moa-production
```

The tracked target record supplies the verified identity and host. The wrapper
runs the exact local gate, pins the full candidate SHA, publishes an immutable
SHA-named ref, then SSHes to the VPS candidate promoter. The promoter creates
and validates release evidence before the guarded updater runs.

This is a promotion of the active gateway. Run it only when an operator has
explicitly approved deploy/promote for the current turn. Promotion builds and
smokes an isolated preview, waits for a drained active gateway, preserves the
mounted Postgres and data volumes, and rolls code back if active health fails.
It does not create a full-state backup. Destructive state migrations require a
separate explicit plan and are not eligible for this path.

## Modes And Required Env

| Env | local | self-host | hosted |
| --- | --- | --- | --- |
| `MOA_GATEWAY_TOKEN` | optional | required at boot | required at boot |
| `DATABASE_URL` | optional (file fallback) | required at boot | required at boot |
| bind default | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| proxy headers trusted | no | yes | yes |

`HOST` and `MOA_TRUST_PROXY` override the mode defaults.
`PUBLIC_GATEWAY_URL` or `MOA_PUBLIC_ORIGIN` overrides URL generation for OTA
download URLs and voice WebSocket tickets. Minimum env for a self-host run:
`MOA_MODE`, `MOA_GATEWAY_TOKEN`, `POSTGRES_PASSWORD` (or an external
`DATABASE_URL`), `MOA_DOMAIN`, `ACME_EMAIL`, and one model provider's
credentials. Full reference: `gateway/deploy/vps/gateway.env.example`.

## One-Image PaaS

The same image runs on any one-image PaaS with managed Postgres: deploy
`gateway/Dockerfile`, attach a persistent volume at `/data`, set
`MOA_MODE=self-host`, `MOA_GATEWAY_TOKEN`, and `DATABASE_URL` from the managed
database, and let the platform terminate TLS (skip the Caddy overlay). The
gateway refuses to boot if `DATABASE_URL` or the token is missing, so a
misconfigured deploy fails loudly instead of writing to container-local files.

## Local Smoke Of The Exact VPS Stack

```sh
cat > /tmp/gateway.env <<EOF
MOA_MODE=self-host
MOA_GATEWAY_TOKEN=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 32)
GATEWAY_PORT=18787
PUBLIC_GATEWAY_URL=http://127.0.0.1:18787
EOF
docker compose -p moa-local --env-file /tmp/gateway.env up -d --build
curl -fsS http://127.0.0.1:18787/health
docker compose -p moa-local --env-file /tmp/gateway.env down -v
```
