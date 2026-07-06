## 0. Committed Lane Outputs

These items are committed artifacts from the VPS agent-control-plane lanes. They
do not mean active deployment, active URL promotion, live-service restart, or
client package publication happened.

- [x] 0.1 VPS gateway deploy scaffold: `gateway/Dockerfile`,
  `gateway/.dockerignore`, root `docker-compose.yml`, and
  `vps-deploy-mode-contract.md`.
- [x] 0.2 Worker-pull product/API contract and implementation ledger:
  `worker-pull-contract.md` and `worker-pull-tasks.md`.
- [x] 0.3 Voice work-history control-plane contract and implementation ledger:
  `voice-work-history-control-plane.md` and
  `voice-work-history-tasks.md`.
- [x] 0.4 Stable client onboarding contract, Android notes, and browser notes:
  `client-onboarding-contract.md`, `client-onboarding-tasks.md`,
  `android_app/docs/vps-gateway-onboarding.md`, and
  `browser_extension/docs/vps-gateway-onboarding.md`.
- [x] 0.5 Account connection and credential-health contract:
  `account-connection-policy.md` and `account-connection-tasks.md`.
- [x] 0.6 Product packaging and first self-host journey:
  `product-packaging.md` and `self-host-user-journey.md`.
- [x] 0.7 Backup/restore promotion gate scaffold:
  `backup-restore-runbook.md`, `scripts/vps-backup.sh`, and
  `scripts/vps-restore-check.sh`.
- [x] 0.8 VPS operations runbooks:
  `cloudflare-dns-tls-runbook.md`,
  `digitalocean-self-host-runbook.md`, and
  `railway-self-host-runbook.md`.
- [x] 0.9 Fabro control-plane workflow:
  `.fabro/workflows/vps-agent-control-plane/workflow.fabro` and
  `.fabro/workflows/vps-agent-control-plane/workflow.toml`.

Acceptance: a reviewer can find the committed lane artifacts above and see that
they are preview/spec/scaffold outputs only.

Verification:

- `fabro validate .fabro/workflows/vps-agent-control-plane/workflow.fabro`

## 1. Container Image And Compose

- [x] 1.1 Add a gateway `Dockerfile` that installs production deps, copies the
  gateway runtime files, creates `/data/android-ota`, and starts
  `node --env-file-if-exists=.env server.js`.
- [x] 1.2 Add a root `docker-compose.yml` with gateway, Postgres,
  `moa-gateway-data`, `moa-postgres-data`, and service healthchecks.
- [x] 1.3 Document the scaffold contract in `vps-deploy-mode-contract.md`,
  including required env, volume ownership, healthcheck, and active-promotion
  blocker.
- [x] 1.4 Run Compose config validation without secrets:
  `MOA_GATEWAY_TOKEN=change-me POSTGRES_PASSWORD=change-me docker compose --env-file /dev/null config --quiet`.
- [ ] 1.5 Run an isolated Compose smoke in a preview path and prove `/health`
  passes, privileged routes still require auth, Postgres is connected, and
  `DATA_DIR` writes land on the named volume.

Acceptance: `docker compose up` in an isolated preview brings up a gateway whose
`/health` passes with `DATABASE_URL` pointed at Compose Postgres and blobs
written to the mounted volume.

## 2. Remote Config-Mode Hardening

- [x] 2.1 Implement `MOA_MODE` (`local` | `self-host` | `hosted`) as the single
  mode selector for auth defaults, bind address, trust-proxy behavior, and store
  selection.
- [x] 2.2 In `self-host` and `hosted`, refuse startup without
  `MOA_GATEWAY_TOKEN` or better-auth, and without `DATABASE_URL`.
- [x] 2.3 Keep local mode developer-friendly: loopback bind by default, file
  fallback allowed, and no remote-mode auth assumptions.
- [x] 2.4 Add health/runtime fields that report mode, auth requirement,
  Postgres/event-store status, public base URL when configured, and voice
  runtime summary without leaking secrets.

Acceptance: starting in `self-host` mode without `DATABASE_URL` exits with a
clear error; starting with required remote env binds for the remote deployment
shape, trusts forwarded headers, and reports the active mode.

Verification:

- `cd gateway && npm run check`
- Startup smoke for local mode, missing-DB remote mode, and valid self-host mode.

## 3. Better-Auth, Owner, And Device Tokens

- [ ] 3.1 Add better-auth behind `MOA_AUTH=better-auth`, with Postgres-backed
  users and sessions in the gateway process.
- [ ] 3.2 Seed or resolve one owner user for the legacy
  `MOA_GATEWAY_TOKEN` migration path so existing events keep a stable author.
- [ ] 3.3 Add email/passkey sign-in for the gateway-served UI session.
- [ ] 3.4 Add device registration start/approval endpoints that mint
  per-device tokens bound to user id, device id, surface type, label,
  creation time, last-seen time, and revocation state.
- [ ] 3.5 Make the voice WebSocket ticket user-scoped: mint a one-use ticket
  only for an authenticated session or a valid device token.

Acceptance: with auth enabled, a user signs in, approves an Android or browser
device, receives a per-device token, and that token authenticates a chat/probe
route and voice ticket attributed to the user.

Verification:

- `cd gateway && npm run check`
- Auth smoke for sign-in, device registration, protected route, revoked token,
  and user-scoped voice ticket.

## 4. Account Connections And Credential Health

- [x] 4.1 Write the account connection trust boundary, provider catalog, data
  contract, endpoint list, refresh/reauth paths, device notification target,
  audit events, and store contract in `account-connection-policy.md`.
- [x] 4.2 Split follow-up gateway implementation tickets in
  `account-connection-tasks.md`.
- [x] 4.3 Implement `GET /v1/account-providers` with stable provider ids and no
  secret exposure.
- [x] 4.4 Implement account connection store, non-secret serializers, and
  per-user query scoping for list/detail/patch.
- [ ] 4.5 Complete full connection lifecycle beyond the current safe MVP:
  provider-specific OAuth callback handling, gateway-secret form UI,
  provider-backed refresh success paths, device notification delivery, and
  revocation audit across the future Postgres store. The current gateway slice
  implements non-secret create/list/detail/patch, manual reauth action
  generation, refresh-needed status, disable, and disconnect.

Acceptance: users can connect and inspect provider accounts while Android and
the browser receive only labels, statuses, action URLs/codes, and non-secret
diagnostics. Raw provider credentials remain inside the gateway credential
boundary.

Verification:

- `cd gateway && npm run check`
- Gateway account-connection smoke covering catalog, two same-provider
  connections, rejected secret-field patch, fake OAuth/manual secret fixtures,
  refresh success/failure, notification queue/skip, disable, and disconnect.

## 5. Worker-Pull Backend And Worker Runtime

- [x] 5.1 Write the bounded worker-pull contract with worker token scope,
  registration, long-poll claim, WebSocket envelope, heartbeat, event
  streaming, result reporting, cancellation, retry behavior, and first smoke
  criteria.
- [x] 5.2 Split follow-up gateway, worker, and smoke tickets in
  `worker-pull-tasks.md`.
- [x] 5.3 Implement owner-approved worker registration with one-use setup codes
  and hashed worker tokens distinct from device tokens.
- [x] 5.4 Extend queued agent runs with lease fields and explicit session,
  branch, work, artifact, and deployment references.
- [x] 5.5 Implement `POST /v1/agent/workers/claim` for outbound long-poll
  claiming with bounded payloads that exclude `command`, `args`, `shell`, raw
  env, raw credentials, and arbitrary absolute paths.
- [x] 5.6 Implement worker heartbeat, event append, terminal result, stale claim
  rejection, cancellation observation, lease expiry, and retry semantics.
- [x] 5.7 Build the local worker runtime pull loop for an allowlisted `echo`
  harness before enabling Codex/Claude/Gemini harness profiles.

Acceptance: a queued gateway run is claimed by an execution machine that only
connects outbound, runs an allowlisted harness locally, streams events, and
reports completion without opening an inbound worker port or giving the VPS a
shell.

Verification:

- `cd gateway && npm run check`
- Worker smoke: register one worker, claim one queued `echo` run, heartbeat,
  append one `stdout` event, complete it, read back lifecycle/linkage, and prove
  stale results cannot overwrite terminal state.

## 6. Client Onboarding And Diagnostics

- [x] 6.1 Write the stable URL, device token, bad URL/token, and voice readiness
  contract in `client-onboarding-contract.md`.
- [x] 6.2 Split Android, browser, gateway diagnostics, smoke, and promotion
  boundary tasks in `client-onboarding-tasks.md`.
- [x] 6.3 Add Android and browser onboarding notes under the client docs.
- [x] 6.4 Implement shared URL normalization and stale/local URL diagnostics
  for `https://api.agee.app`, `https://api.<domain>`, `10.147.17.10`,
  `10.147.17.6`, missing schemes, and endpoint paths.
- [ ] 6.5 Android: complete the gateway registration UI and authenticated probe
  once gateway device registration exists. The current Android slice derives
  voice from the configured gateway origin, migrates stale dev defaults, expands
  setup diagnostics, and verifies with unit tests plus `assembleDebug`.
- [ ] 6.6 Browser extension: complete package-version/release handling when the
  source change is promoted. The current browser slice updates hosted
  defaults/config examples, Options/doctor diagnostics, pre-open voice errors,
  and verification coverage.
- [ ] 6.7 Gateway: return structured diagnostics for health, protected auth
  probes, voice ticket denial, missing voice routes, and provider/runtime
  unavailability.

Acceptance: Android and browser setup can distinguish wrong URL, reachable
gateway with bad token, missing voice route, provider unavailable, microphone
permission, and WebSocket/TLS/proxy failure while still storing only gateway URL
plus device token.

Verification:

- `cd gateway && npm run check`
- `cd browser_extension && npm run verify && npm run smoke`
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
- VPS client smoke against preview/stable URL:
  `curl -fsS <gateway>/health`,
  `curl -fsS -H "authorization: Bearer <device-token>" <gateway>/v1/sessions`,
  browser gateway smoke, browser live voice smoke, and manual Android typed and
  voice turn checks.

## 7. Voice Work-History Control Plane

- [x] 7.1 Write the voice work-history control-plane contract covering spoken
  operations, durable evidence records, proposal/claim/receipt policy,
  acceptance criteria, and smoke checks.
- [x] 7.2 Split follow-up gateway, worker, client, deployment-control, and smoke
  tickets in `voice-work-history-tasks.md`.
- [ ] 7.3 Implement product-event payloads and projections for `work_task`,
  `repo_snapshot_ref`, `diff_ref`, `verification_artifact`,
  `deployment_record`, `user_feedback`, and `ui.open` request/receipt.
- [ ] 7.4 Route voice/text work requests through the broker into durable tasks
  and queued/proposed runs without starting a harness until worker claim.
- [ ] 7.5 Add status/history queries, feedback attachment, control requests,
  deployment link queries, and client `ui.open` requests backed by stored
  events and artifacts rather than provider memory.
- [ ] 7.6 Require worker evidence for code-changing runs: before snapshot,
  after snapshot, diff ref, verification artifact, redaction status, and
  completion/failure event.

Acceptance: voice can create work, ask status, attach feedback, ask for
deployment links, and ask a client to open the relevant UI while every mutating
operation remains proposal, claim, and receipt based.

Verification:

- Voice create smoke.
- Worker evidence smoke.
- Status/history smoke.
- Feedback smoke.
- Deployment-link smoke proving no implicit promotion.
- UI-open smoke proving client claim and receipt.

## 8. Backup, Restore, And Promotion Safety

- [x] 8.1 Add `scripts/vps-backup.sh` with explicit env/arg inputs, dry-run and
  execute modes, Postgres dump, `DATA_DIR` snapshot, checksums, and non-secret
  manifest output.
- [x] 8.2 Add `scripts/vps-restore-check.sh` with scratch-only guards, empty
  database check, restored `DATA_DIR`, scratch gateway health, and port `8787`
  rejection.
- [x] 8.3 Document the pre-promotion sequence and blockers in
  `backup-restore-runbook.md`.
- [ ] 8.4 Run backup dry-run and execute against the active source only after
  preview smoke, rollback, no-interruption, and state-compatibility checks pass,
  or inside an operator-controlled backup context.
- [ ] 8.5 Run restore-check dry-run and execute against scratch Postgres and
  scratch `DATA_DIR`, then record backup directory, restore scratch directory,
  health URL, and blockers in promotion notes.
- [x] 8.6 Add unattended backup automation scaffolding: atomic complete-only VPS
  backup directories, a latest-backup restore-check wrapper, VPS systemd timers
  for recurring backup/restore verification, and a macOS LaunchAgent plus rsync
  pull script for off-host backup copies. This does not mean the active timers
  were installed or an active backup was run.

Acceptance: before any active URL change, active-service restart, Master Orch
apply, or client cutover, a Postgres dump and `DATA_DIR` snapshot exist and a
read-only scratch restore proves `/health` plus one core read path.

Verification:

- `scripts/vps-backup.sh --dry-run`
- `scripts/vps-backup.sh --execute`
- `scripts/vps-restore-check.sh --dry-run`
- `scripts/vps-restore-check.sh --execute`
- `bash -n scripts/vps/backup.sh scripts/vps/restore-latest-backup.sh scripts/vps/pull-backups.sh scripts/vps/install-backup-timers.sh scripts/vps/install-backup-pull-launchagent.sh`
- `scripts/vps/install-backup-timers.sh --dry-run`
- `scripts/vps/install-backup-pull-launchagent.sh --dry-run --host root@example.com --dest /tmp/chief-moa-vps-backups`
- `scripts/vps/pull-backups.sh --dry-run --host root@example.com --dest /tmp/chief-moa-vps-backups`

## 9. Operations Runbooks And Product Packaging

- [x] 9.1 Document Cloudflare Pages plus proxied `api.<domain>` DNS/TLS and
  WebSocket behavior in `cloudflare-dns-tls-runbook.md`.
- [x] 9.2 Document the DigitalOcean droplet, volume, image, env, Compose,
  health, DNS/TLS, backup, and rollback path in
  `digitalocean-self-host-runbook.md`.
- [x] 9.3 Document the Railway/one-image PaaS preview path in
  `railway-self-host-runbook.md`.
- [x] 9.4 Document product packaging, hosted/self-host mode line, first
  implementation slices, and first self-host user journey.
- [ ] 9.5 Execute one isolated VPS or PaaS preview from a pinned commit/image
  and record health, auth-gate, voice-ticket, and WebSocket smoke evidence.
- [ ] 9.6 Confirm Cloudflare `api.<domain>` returns the public `wss://` voice
  URL from `/v1/voice/session-ticket` and that Pages does not serve the API
  subdomain.

Acceptance: a self-hoster can follow the runbooks from one image plus env to a
preview gateway, and hosted convenience remains the same product contract plus
managed operations.

## 10. Integrated Verification Gates

- [ ] 10.1 Workflow: `fabro validate .fabro/workflows/vps-agent-control-plane/workflow.fabro`.
- [ ] 10.2 Spec hygiene: `git diff --check -- reference/openspec/changes/remote-hosted-gateway/tasks.md reference/openspec/changes/remote-hosted-gateway/design.md reference/openspec/changes/remote-hosted-gateway/proposal.md`.
- [ ] 10.3 Gateway backend: `cd gateway && npm run check` plus route smokes
  named in the backend tickets above.
- [ ] 10.4 Compose/VPS: config validation, isolated Compose up, health,
  auth-gate, Postgres/event-store status, persistent `DATA_DIR`, and voice
  ticket/WebSocket smoke.
- [ ] 10.5 Clients: browser verify/smoke, browser gateway/live-voice smoke
  against the VPS URL, Android debug build, and manual Android typed/voice QA.
- [ ] 10.6 Worker: outbound-only registration/claim/heartbeat/event/result
  smoke with no inbound listener and no active deployment application.
- [ ] 10.7 Promotion: backup execute plus scratch restore execute before any
  active service restart, active URL switch, Master Orch apply, OTA publish, or
  browser package reload.

Current blocker: active promotion waits on missing evidence. This integration
task does not deploy, restart, apply, switch active URLs, publish OTA artifacts,
or reload browser packages. Active backup execution also waits until the
active-promotion gate passes or an operator-controlled backup context exists.
The unattended timer and off-host mirror installers are committed but not
installed.

## 11. Incoming Shipped VPS Stack Ledger

These incoming task entries are retained as the shipped-stack ledger from
`1394be4`. Some overlap the broader control-plane ledger above, but the checked
items are kept intact so the merge does not erase either side's task history.

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

8.1, 8.2, and 8.5 were reverified on the consolidation branch with isolated
local compose projects; the live LAN gateway was not touched. The compose
health payload reported `mode=self-host`, `trust_proxy=true`, and
`event_substrate.mode=postgres`; the restore check verified `/health`,
`/v1/supervisor/status`, and the restored `nodes` table. 8.3 and 8.4 wait on
tasks 3 and 4. Real-droplet provisioning is intentionally not run yet: the
handoff is
`scripts/vps/bootstrap.sh --domain api.<domain> --email <email>` on a fresh
Ubuntu droplet.
