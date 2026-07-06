# Railway Self-Host Runbook

Last reviewed: 2026-07-03.

This runbook describes a Railway or one-image PaaS preview path for the Chief
Moa gateway. It uses the same gateway image built from `gateway/Dockerfile`, a
managed Postgres service, and a persistent volume for `DATA_DIR`. It is a
preview candidate path, not an active promotion approval.

## Target Shape

```text
Railway project
  gateway service from pinned Docker image
  managed PostgreSQL service
  persistent volume mounted at /data
  public HTTPS domain for API and voice WebSocket

Clients
  https://<gateway-domain>
  wss://<gateway-domain>/v1/voice/sessions
```

Railway replaces the droplet reverse proxy and Compose Postgres service. The
product boundary does not change: Android and the browser store only gateway
URL plus token, provider keys stay server-side, and harness execution stays off
the gateway.

## Image

Build the same image used by the VPS path:

```sh
git checkout <approved-sha>
docker build -t ghcr.io/<owner>/chief-moa-gateway:<approved-sha> gateway
docker push ghcr.io/<owner>/chief-moa-gateway:<approved-sha>
```

Deploy a pinned tag or digest. Do not use `latest` for a promotion candidate.

Railway can also build from a Dockerfile, but the repo's Dockerfile lives under
`gateway/` and expects that directory as its build context. The lowest-risk PaaS
path is therefore a prebuilt image from Docker Hub, GHCR, GitLab Registry, or
Quay. Private registry pulls may require a paid Railway plan.

## Create Railway Services

1. Create a new Railway project for the preview.
2. Add a PostgreSQL database service.
3. Add a gateway service from the pinned Docker image:

```text
ghcr.io/<owner>/chief-moa-gateway:<approved-sha>
```

4. Add a Railway volume to the gateway service and mount it at:

```text
/data
```

5. Set the gateway service healthcheck path to:

```text
/health
```

Railway injects `PORT`; the gateway image reads `PORT` and binds `HOST`. Do not
hardcode a public port in Railway.

## Environment Shape

Set these on the gateway service:

```env
MOA_MODE=self-host
HOST=0.0.0.0
DATA_DIR=/data
ANDROID_OTA_DIR=/data/android-ota

DATABASE_URL=${{Postgres.DATABASE_URL}}
MOA_GATEWAY_TOKEN=<long-random-owner-token>
ALLOW_AGENT_WITHOUT_TOKEN=0

DEFAULT_AGENT_HARNESS=echo
VOICE_MULTI_AGENT_HARNESSES=echo

MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_ID=gpt-4o-mini
MODEL_API_KEY=<provider-key-if-model-calls-are-enabled>

VOICE_PROVIDER=loopback
VOICE_STT_PROVIDER=loopback
VOICE_LLM_PROVIDER=loopback
VOICE_TTS_PROVIDER=loopback
```

Railway volume permission note:

```env
RAILWAY_RUN_UID=0
```

The current gateway image runs as the `node` user, while Railway volumes are
mounted as root. Set `RAILWAY_RUN_UID=0` for this preview unless the image has
been changed to prepare writable volume ownership before dropping privileges.

Do not place provider credential JSON directly into source or image layers. If
a selected provider needs file credentials, use the PaaS secret/file mechanism
or choose a key-based provider for the preview.

## Deploy And Healthcheck

Deploy the staged Railway changes.

Pass criteria in Railway:

- PostgreSQL service is running.
- Gateway service deploy passes `/health`.
- Gateway logs do not report missing `DATABASE_URL`.
- Gateway logs do not report missing `MOA_GATEWAY_TOKEN`.
- The mounted `/data` path is writable by the gateway.

External health:

```sh
curl -fsS https://<railway-gateway-domain>/health
```

Token gate:

```sh
curl -i https://<railway-gateway-domain>/v1/agent/runs
```

Expected unauthenticated result is `401` during the single-token stage.

Voice ticket smoke:

```sh
curl -fsS \
  -X POST \
  -H "authorization: Bearer $MOA_GATEWAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"source":"railway-smoke"}' \
  https://<railway-gateway-domain>/v1/voice/session-ticket
```

The response `ws_url` must begin with `wss://<railway-gateway-domain>/`.

Direct WebSocket smoke from this repo:

```sh
node gateway/deploy/main-machine/smoke-voice-session.js \
  wss://<railway-gateway-domain>/v1/voice/sessions \
  "$MOA_GATEWAY_TOKEN"
```

Full gateway smoke when OTA and real voice are intentionally configured:

```sh
cd gateway
MOA_GATEWAY_TOKEN="$MOA_GATEWAY_TOKEN" \
  npm run smoke:main-machine -- https://<railway-gateway-domain>
```

## Domain

For preview, use the Railway-provided domain first. After health and voice smoke
pass, add a Railway custom domain such as `api-preview.<domain>`.

Keep the Cloudflare Pages split from `cloudflare-dns-tls-runbook.md`:

- frontend remains on Cloudflare Pages;
- gateway API and voice use the Railway gateway domain;
- clients are configured with the exact gateway base URL.

Do not repoint the active `api.<domain>` hostname to Railway without the backup
gate, smoke evidence, and explicit user approval.

## Persistent Data

The gateway volume mounted at `/data` holds:

- Android OTA artifacts under `/data/android-ota`;
- local fallback files for any route not yet moved to Postgres;
- voice/session artifacts when retention is enabled.

Postgres is managed by Railway and is the production store for remote modes.
Do not depend on local JSON/JSONL fallback for a Railway remote deployment.

Railway volume caveats that matter here:

- A service can have only one mounted volume.
- Replicas cannot be used with a volume.
- Deployments with attached volumes may have brief downtime even when
  healthchecks are configured.
- The volume is mounted at runtime, not at build time.

These caveats match the current single sticky voice instance plan.

## Backup Gate

Run before any active URL change, active-service restart, or promotion.

Database backup options:

- Use Railway's native Postgres backup feature when available for the plan.
- Or run `pg_dump` against the Railway Postgres connection string from a trusted
  operator machine without printing the URL.

Data volume backup options:

- Use Railway volume backups if enabled for the service.
- Or export `/data` contents through Railway volume file tooling into an
  operator-controlled archive.

Restore check:

1. Create a scratch Railway project or scratch environment.
2. Restore the Postgres backup into scratch Postgres.
3. Restore the `/data` backup into a scratch gateway volume.
4. Deploy the same gateway image with scratch `MOA_GATEWAY_TOKEN`.
5. Verify `/health` and one core read path such as `GET /v1/agent/runs` with
   the scratch token.

Promotion is blocked if the backup or scratch restore check is missing or
fails.

## Rollback

Image rollback:

1. In Railway, select the previous successful deployment for the gateway
   service or repin the service source to the previous image tag/digest.
2. Deploy the staged rollback.
3. Verify `/health`.
4. Run the voice smoke if the rollback touches voice behavior.

State rollback:

- Prefer image rollback first; do not restore database or volume state unless a
  state migration caused the incident.
- Restore Postgres and `/data` only from a backup that already passed the
  scratch restore check.
- Restore active state only after the active-promotion gate passes and the
  operator has a tested restore target.

## External References

- Railway Docker image deploy:
  https://docs.railway.com/quick-start
- Railway services and image sources:
  https://docs.railway.com/services
- Railway PostgreSQL:
  https://docs.railway.com/databases/postgresql
- Railway healthchecks:
  https://docs.railway.com/deployments/healthchecks
- Railway volumes:
  https://docs.railway.com/volumes
- Railway domains:
  https://docs.railway.com/networking/domains
