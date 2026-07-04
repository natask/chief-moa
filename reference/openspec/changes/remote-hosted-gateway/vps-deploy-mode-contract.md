# VPS Deploy Mode Contract

This artifact defines the current VPS scaffold for the gateway image and
Compose stack. It is a preview candidate path, not an active-deploy approval.

## Launch Command

Create a VPS-local compose env file with the required values, then launch from
the repository root:

```sh
docker compose --env-file /opt/chief-moa/gateway.env up -d --build
```

For local config validation without secrets, pass placeholder values from the
shell and an empty compose env file:

```sh
MOA_GATEWAY_TOKEN=change-me POSTGRES_PASSWORD=change-me docker compose --env-file /dev/null config
```

The image starts the gateway with:

```sh
node --env-file-if-exists=.env server.js
```

Compose-provided environment is the preferred VPS path. A mounted `/app/.env`
also works because the Node command keeps env-file support.

## Volumes

- `moa-gateway-data` mounts at `/data` and backs `DATA_DIR`.
- `ANDROID_OTA_DIR` is `/data/android-ota` inside the gateway container.
- `moa-postgres-data` mounts at `/var/lib/postgresql/data` for Postgres.

Both named volumes are production state. Rebuilding or replacing the gateway
container must not delete them.

## Required Environment

- `MOA_GATEWAY_TOKEN`: long random bearer token for current gateway auth.
- `POSTGRES_PASSWORD`: Postgres password used by the compose Postgres service.
- `DATABASE_URL`: optional override. If omitted, Compose builds
  `postgres://moa:<POSTGRES_PASSWORD>@postgres:5432/moa_gateway`.
- `MOA_MODE`: defaults to `self-host` for the scaffold.
- `MODEL_PROVIDER`, `MODEL_BASE_URL`, `MODEL_ID`, and provider credentials when
  real model calls are enabled.
- `VOICE_PROVIDER`, `VOICE_STT_PROVIDER`, `VOICE_LLM_PROVIDER`, and
  `VOICE_TTS_PROVIDER` when using non-loopback streaming voice.

Provider API keys and Google credential JSON files must not be baked into the
image. Mount credential files at runtime only when a selected provider requires
file credentials.

## Healthcheck

The image and Compose service both check:

```text
GET http://127.0.0.1:8787/health
```

The healthcheck uses Node's built-in `fetch`; the image does not install `curl`
only for health probing.

## Backup And Restore Expectation

Before any promotion that changes the active URL, restarts the active service,
or points clients at this VPS stack:

1. Take a Postgres dump from the active database.
2. Snapshot the active `DATA_DIR` volume.
3. Restore both into a scratch Postgres and scratch data volume.
4. Start a scratch gateway against the restored state.
5. Verify `/health` and one core read path without touching the active service.

Promotion is blocked if the restore check is missing or fails.

## Active-Deploy Blocker

Do not apply this scaffold to the active user URL yet. This ticket only adds
the Docker image, Compose shape, and deploy-mode contract. Active promotion is
blocked until the user explicitly approves a maintenance window, backup/restore
evidence exists, and the remaining remote-hosted gateway tasks for remote-mode
hardening and worker-pull execution have passed their acceptance checks.
