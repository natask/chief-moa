# VPS Gateway Deployment

This path deploys the gateway as a Docker Compose stack on a VPS. Use it when
mobile or browser clients need a stable public HTTPS/WSS endpoint instead of a
local or ZeroTier-only machine.

## Target Shape

```text
Android / browser extension
  -> https://api.<domain>
  -> Cloudflare proxied DNS record
  -> VPS Docker Compose stack
  -> gateway container + Postgres + DATA_DIR volume
```

Cloudflare Pages can continue serving `agee.app` or other static frontend
surfaces. The API and voice WebSocket stay on the VPS:

- HTTP API: `https://api.<domain>`
- Voice WebSocket: `wss://api.<domain>/v1/voice/sessions`

## VPS Prep

1. Create a droplet or VPS with Docker Engine and the Docker Compose plugin.
2. Attach or provision persistent storage for `/opt/chief-moa`.
3. Create the app directory:

```sh
sudo mkdir -p /opt/chief-moa
sudo chown "$USER:$USER" /opt/chief-moa
```

4. Copy [env.example](env.example) to `/opt/chief-moa/.env` on the VPS and fill
   the secrets there. Do not commit the filled file.

Minimum remote-mode env:

```env
MOA_MODE=self-host
TRUST_PROXY=1
PUBLIC_GATEWAY_URL=https://api.<domain>
GATEWAY_HOST_PORT=8787
GATEWAY_PORT=8787
MOA_GATEWAY_TOKEN=<long-random-token>
POSTGRES_DB=moa_gateway
POSTGRES_USER=moa
POSTGRES_PASSWORD=<long-random-password>
DEFAULT_AGENT_HARNESS=echo
ALLOW_AGENT_WITHOUT_TOKEN=0
```

Start with loopback voice for transport smoke. Switch to `vertex-live` or
`gemini-live` only after public HTTPS and WSS transport pass.

## Cloudflare DNS And TLS

Create a proxied DNS record:

```text
type: A
name: api
value: <VPS public IPv4>
proxy: enabled
```

Cloudflare supports WebSocket proxying on normal proxied records. The reverse
proxy or direct container ingress must preserve:

```text
Host
X-Forwarded-Host
X-Forwarded-Proto
```

The gateway uses `PUBLIC_GATEWAY_URL` first. If it is unset, it uses trusted
forwarded headers only when `TRUST_PROXY=1`.

Use Cloudflare edge TLS plus either an origin certificate or a trusted TLS
terminator on the VPS. If the VPS exposes the container directly for the first
smoke, keep it firewalled to Cloudflare or move behind a local reverse proxy
before real use.

## Deploy

From a verified, committed checkout:

```sh
VPS_REMOTE=root@203.0.113.10 \
VPS_DIR=/opt/chief-moa \
VPS_GATEWAY_URL=https://api.<domain> \
bash scripts/deploy.sh vps
```

`VPS_REMOTE` is required. The script syncs `docker-compose.yml` and `gateway/`,
verifies the remote compose config, rebuilds, starts, checks local health on the
VPS, and optionally checks public `/health` via `VPS_GATEWAY_URL`.

## Client Packaging

Android OTA build:

```sh
MOA_DEFAULT_GATEWAY_URL=https://api.<domain> \
bash scripts/deploy.sh android
```

Browser extension config:

```sh
cd browser_extension
AGEE_GATEWAY_URL=https://api.<domain> \
AGEE_GATEWAY_TOKEN=<gateway-token> \
npm run configure
```

The Android app and browser extension store only the gateway URL and a gateway
token. They must not store provider API keys.

## Smoke Checks

Remote mode guardrails:

```sh
cd gateway
npm run smoke:remote-mode
```

Local compose smoke without colliding with a live local gateway:

```sh
GATEWAY_HOST_PORT=18787 \
MOA_GATEWAY_TOKEN=compose-smoke-token \
POSTGRES_PASSWORD=compose-smoke-password \
docker compose -p chief-moa-vps-smoke up -d --build

curl -fsS http://127.0.0.1:18787/health
docker compose -p chief-moa-vps-smoke down -v
```

Public gateway smoke after DNS/TLS is live:

```sh
MOA_GATEWAY_URL=https://api.<domain> \
MOA_GATEWAY_TOKEN=<gateway-token> \
cd gateway && npm run smoke:gateway
```

The full gateway smoke expects OTA and streaming voice to be configured. Before
that, use `/health` plus `npm run smoke:remote-mode` to prove remote-mode URL
generation and WSS ticket formation.

## Promotion Safety

Do not point active clients at a new VPS before a backup and restore path exists
for the current active data. For deployments that already hold recordings,
transcripts, archives, databases, or OTA artifacts, take a Postgres dump and a
`DATA_DIR` snapshot, then verify a read-only restore against a scratch target
before switching DNS or client defaults.
