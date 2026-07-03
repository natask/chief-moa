## 1. Container Image And Compose

- [x] 1.1 Add a gateway `Dockerfile` that installs deps, copies the gateway, and starts `node --env-file-if-exists=.env server.js`.
- [x] 1.2 Add a `docker-compose.yml` with the gateway, a Postgres service, a named `DATA_DIR` volume, and a healthcheck on `GET /health`.
- [x] 1.3 Add a `HEALTHCHECK` and verify `docker compose up` reaches a healthy gateway with Postgres attached.

Acceptance: `docker compose up` brings up a gateway whose `/health` passes with `DATABASE_URL` pointed at the compose Postgres and blobs written to the mounted volume.

Done: `gateway/Dockerfile`, `docker-compose.yml`, and the `docker-compose.vps.yml`
Caddy TLS overlay. Verified locally under an isolated compose project: gateway
healthy on the compose Postgres, `/v1/supervisor/status` served from Postgres,
401 without the token, `DATA_DIR` blob written to the named volume.

## 2. Config-Mode Hardening

- [x] 2.1 Add `MOA_MODE` (`local` | `self-host` | `hosted`) that sets defaults for auth, bind address, and store selection.
- [x] 2.2 In `self-host` and `hosted`, refuse to start without `MOA_GATEWAY_TOKEN` (or better-auth enabled) and without `DATABASE_URL`.
- [x] 2.3 Default bind to `0.0.0.0` and enable trust-proxy in remote modes so Cloudflare-forwarded client IPs and protocol are read correctly.

Acceptance: starting in `self-host` mode without `DATABASE_URL` exits with a clear error; starting with it binds `0.0.0.0` and reports the active mode.

Done in `gateway/server.js`: `MOA_MODE` defaults (local binds loopback; remote
modes bind `0.0.0.0`, require token + `DATABASE_URL` at boot, and honor
`x-forwarded-proto` behind the proxy). `HOST` and `MOA_TRUST_PROXY` override
mode defaults. `/health` and the startup log report the active mode. Since
better-auth has not landed, remote modes require the token unconditionally.

## 3. Better-auth Integration Behind A Flag

- [ ] 3.1 Add better-auth with its Postgres tables behind `MOA_AUTH=better-auth`, keeping `MOA_GATEWAY_TOKEN` working when the flag is off.
- [ ] 3.2 Seed an owner user and map the existing single token to that owner so pre-auth events keep one stable author.
- [ ] 3.3 Add email and passkey sign-in for the gateway-served UI session.
- [ ] 3.4 Add a device registration flow that mints a per-device token bound to a user id and device id.
- [ ] 3.5 Make the voice WebSocket ticket user-scoped: mint a one-use ticket only for an authenticated session or a valid device token.

Acceptance: with the flag on, a user signs in, registers a device, receives a per-device token, and that token authenticates a chat turn and a voice ticket attributed to the user.

## 4. Run-Claim Worker Pull Loop

- [ ] 4.1 Add a worker token credential distinct from device tokens, authorizing run claim and report only.
- [ ] 4.2 Add an outbound-friendly claim endpoint the execution machine polls or holds open for queued runs.
- [ ] 4.3 Add a claim step that moves a queued run to claimed for one worker and streams status/result events back into the existing run lifecycle.
- [ ] 4.4 Confirm no inbound port is required on the execution machine: it only connects out to the gateway.

Acceptance: a run created on the gateway is claimed by an execution machine that only connects outbound, runs the named harness locally, and reports completion recorded against the run.

## 5. DNS, Cloudflare, And TLS Runbook

- [x] 5.1 Write a runbook for a proxied Cloudflare DNS record `api.<domain>` pointing at the VPS, with WebSocket enabled.
- [x] 5.2 Document TLS termination (Cloudflare edge plus origin cert or origin TLS) and the voice WS URL clients use.
- [x] 5.3 Keep the static frontend on Cloudflare Pages (`agee-app` project) and document the API/WS split from Pages.

Acceptance: the runbook takes a fresh domain to a working proxied `api.<domain>` serving gateway HTTP and voice WS, with Pages serving the frontend.

Done: `gateway/deploy/vps/README.md`. TLS terminates at Caddy on the VPS with an
automatic Let's Encrypt origin certificate, so the Cloudflare record can run
proxied (Full strict) or DNS-only. Clients use
`wss://api.<domain>/v1/voice/sessions`.

## 6. Railway And DigitalOcean Self-Host Docs

- [x] 6.1 Write a DigitalOcean droplet runbook: create droplet, attach volume, run the image with an env file, point DNS.
- [x] 6.2 Write a Railway (or equivalent one-image PaaS) quickstart using the same image and env, with managed Postgres.
- [x] 6.3 List the minimum env for a self-host run and the modes each value affects.

Acceptance: a reader can bring up a self-hosted gateway on a DigitalOcean droplet and on Railway from the same image using only the documented env.

Done: `gateway/deploy/vps/README.md` (droplet runbook, one-image PaaS section,
mode/env matrix) plus `gateway/deploy/vps/gateway.env.example`. The droplet path
uses named Docker volumes instead of a separate block-storage volume; attaching
block storage stays an operator option, not a requirement.

## 7. Backup And Restore Scripts

- [x] 7.1 Add a backup script that dumps Postgres and snapshots `DATA_DIR` before promotion.
- [x] 7.2 Add a read-only restore check that restores the dump and snapshot into a scratch target and verifies core reads.
- [x] 7.3 Document that promotion (active URL change or active-service restart) runs the backup and restore check first.

Acceptance: the backup script produces a dump plus snapshot, and the restore check rebuilds a scratch gateway that answers `/health` and a core query without touching the active deployment.

Done: `scripts/vps/backup.sh` and `scripts/vps/restore-check.sh` (scratch compose
project + scratch port, `down -v` on exit). `scripts/vps/update.sh` runs both
before mutating the active gateway; the promotion rule is documented in
`gateway/deploy/vps/README.md` and `ARCHITECTURE.md`.

## 8. Verification

- [x] 8.1 Gateway: `cd gateway && npm run check`.
- [x] 8.2 Compose smoke: `docker compose up` reaches a healthy gateway on Postgres with a mounted volume.
- [ ] 8.3 Auth smoke: sign-in, device registration, per-device token, and user-scoped voice ticket with the flag on.
- [ ] 8.4 Worker smoke: outbound claim of a queued run and reported completion with no inbound port on the worker.
- [x] 8.5 Backup smoke: dump plus snapshot plus scratch restore check pass before any promotion.

8.1, 8.2, and 8.5 verified locally (isolated compose projects; the live LAN
gateway was not touched). 8.3 and 8.4 wait on tasks 3 and 4. Real-droplet
provisioning is intentionally not run yet: the handoff is
`scripts/vps/bootstrap.sh --domain api.<domain> --email <email>` on a fresh
Ubuntu droplet.
