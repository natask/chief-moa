## Context

The gateway owns model routing, provider credentials, conversation and agent-run
storage, voice routing, and OTA artifacts. Android and the browser extension are
thin clients pointed at a gateway URL plus a token. The execution machine owns
harness runs. That boundary does not change here. What changes is where the
gateway runs, how it authenticates users, where blobs live, and how the
execution machine reaches queued runs.

The `self-hostable-event-substrate` change already sets the storage direction:
Postgres is the production store, a file fallback stays for local dev, and auth
depends on deployment mode. This change makes that concrete for a remote VPS and
maps the auth step onto better-auth.

Committed lane artifacts now fill in the surrounding contracts for this change:
`vps-deploy-mode-contract.md` for the preview image/Compose scaffold,
`worker-pull-contract.md` for execution-machine claiming,
`client-onboarding-contract.md` for Android/browser setup,
`account-connection-policy.md` for connected provider accounts,
`voice-work-history-control-plane.md` for work evidence and feedback,
`backup-restore-runbook.md` for the promotion gate, the Cloudflare,
DigitalOcean, and Railway runbooks for operations, and
`product-packaging.md` plus `self-host-user-journey.md` for product boundaries.

## Decisions

### Decision: one image, three modes

The gateway ships as one Docker image. A `MOA_MODE` env value selects behavior:

```text
local      no auth, file fallback allowed, bind 127.0.0.1, harness may run in-process
self-host  auth required, Postgres required, bind 0.0.0.0, trust proxy, worker-pull harness
hosted     self-host plus per-user accounts, backups expected, DigitalOcean droplet
```

There is no separate hosted build. Hosted is self-host plus multi-user accounts
and operational expectations. This keeps one code path so a self-hoster runs the
same server the hosted product runs.

Mode is config, not a fork. Reading `MOA_MODE` sets defaults for auth, bind
address, proxy trust, and store selection, and each default stays overridable by
its own env var for edge cases.

### Decision: better-auth in the same Node process

better-auth is Postgres-native and runs inside the gateway's Node process, so it
does not add a service. It owns users, sessions, and the account tables. The
gateway keeps owning device tokens, voice tickets, and event attribution.

Auth progression:

```text
stage 0  single MOA_GATEWAY_TOKEN, one owner (today)
stage 1  better-auth tables exist; token still works; token maps to a seeded owner user
stage 2  users sign in (email or passkey); sessions issue per-user
stage 3  each device registers and gets a per-device token bound to a user
stage 4  single-token path is optional and off by default in hosted mode
```

Concrete mapping onto better-auth primitives:

- Email/passkey sign-in uses better-auth's email and passkey plugins. Passkey is
  the target for the account owner; email is the fallback and recovery path.
- A browser session cookie comes from better-auth for the gateway-served UI.
- A device token is a gateway-minted credential linked to a better-auth user id.
  The device registration flow issues it; the token carries the user id so event
  attribution stays per-user.
- The voice WebSocket ticket flow stays. The ticket becomes user-scoped: the
  gateway mints a one-use ticket only for an authenticated session or a valid
  device token, and the ticket carries the user id for the voice session.

The single token maps to a seeded owner user so existing writes keep one stable
owner id through the migration. Nothing loses its author.

### Decision: account connections stay gateway-owned

Connected provider accounts are modeled as `account_connection` records scoped
to a better-auth user. The gateway owns OAuth callbacks, manual secret-entry
forms, refresh, reauth, credential-health state, non-secret summaries, and audit
events. Android and the browser may display labels, status, expiry, action
URLs/codes, and reauth prompts, but they never receive raw provider
credentials, provider cookies, refresh tokens, API keys, PATs, service-account
material, or worker tokens.

The detailed endpoint, data, refresh, reauth, notification, and audit contract
lives in `account-connection-policy.md`; implementation slices live in
`account-connection-tasks.md`.

### Decision: device registration flow

Android and the extension already store a gateway URL and a token. Registration
turns that token into a per-device, per-user credential without changing what the
client stores.

```text
device shows a short code or opens a registration URL
  -> user approves the device against their account in the gateway UI
  -> gateway mints a per-device token bound to the user id and device id
  -> device replaces its bootstrap token with the per-device token
  -> device keeps calling the same endpoints with the new token
```

The client still holds only a URL and a token. It never holds provider keys or
account passwords. Registration is the only new step, and it is one approval.

### Decision: client onboarding proves URL, auth, and voice separately

Remote onboarding uses one stable HTTPS gateway origin such as
`https://api.agee.app` or `https://api.<domain>`. The clients keep the same
storage shape, but setup must classify stale ZeroTier/local URLs, malformed
origins, endpoint paths, DNS/TLS failures, token failures, missing voice routes,
provider voice unavailability, microphone permission failures, and
WebSocket/TLS/proxy failures as separate states. A passing `/health` proves
reachability only; a protected lightweight route proves token validity; voice
readiness is a third check.

The shared contract is in `client-onboarding-contract.md`, with Android/browser
source follow-ups in `client-onboarding-tasks.md` and the client docs under
`android_app/docs/` and `browser_extension/docs/`.

### Decision: Postgres required for remote modes

`self-host` and `hosted` require `DATABASE_URL`. The gateway refuses to start in
those modes without it, rather than silently falling back to files where a
multi-client remote deployment would corrupt or lose state. `local` mode keeps
the JSON/JSONL fallback so a first run needs no database.

better-auth tables and the event substrate tables live in the same Postgres.
One database, one dump, one restore.

### Decision: blobs on a persistent volume now, object storage later

`DATA_DIR` holds OTA APKs and, when retention is on, voice audio. On the VPS this
maps to a mounted persistent volume so a container rebuild does not drop
artifacts. The path stays `DATA_DIR` so nothing in the app changes.

S3-compatible object storage is the later step for blobs, named here so the
volume is understood as a stage, not the end state. This change does not
implement it.

### Decision: harness stays off the VPS via a worker-pull model

Harness execution cannot move to the VPS. Codex, Claude, and Gemini runs happen
on the user's execution machine, which has the repos, credentials, and tools.
The problem is reaching that machine from a public VPS without opening an inbound
port on it.

The answer is a pull model. The execution machine connects out to the gateway
and claims runs:

```text
gateway (VPS)
  stores agent runs with status queued
execution machine (user's box)
  authenticates outbound to the gateway with a worker token
  long-polls or holds a WebSocket for claimable runs
  claims a queued run, runs the named harness locally
  streams status and result events back to the gateway
  gateway records lifecycle and marks the run done or failed
```

No inbound port opens on the user's machine. The gateway never executes the
harness and never holds a shell. Harness output stays a proposal. This reuses the
existing agent-run store and lifecycle events; it adds a claim step and a worker
token, not a new execution authority.

The worker token is a distinct credential from device tokens. It authorizes
claiming and reporting on runs, nothing else.

The bounded endpoint and event contract is `worker-pull-contract.md`. Its
implementation ledger is `worker-pull-tasks.md`. The first runtime slice should
prove an outbound-only `echo` worker before enabling Codex, Claude, Gemini, or
other local harness profiles.

### Decision: voice drives the control plane, not hidden execution

Voice and text can create durable tasks, ask status, attach feedback, ask for
deployment links, and request that a client open a UI route. Those operations
write or query gateway records and proposals. Harness execution, browser/page
actions, Android actions, local UI opens, and active deployment promotion still
require the owning worker or client to claim, validate, execute or reject, and
post a receipt.

The evidence model for `work_task`, `repo_snapshot_ref`, `diff_ref`,
`verification_artifact`, `deployment_record`, `user_feedback`, and `ui.open`
request/receipt records is in `voice-work-history-control-plane.md`; staged
smoke tasks are in `voice-work-history-tasks.md`.

### Decision: Cloudflare split

The static frontend and marketing site go on Cloudflare Pages, where agee.app
already lives on the `agee-app` project. The gateway API and voice WebSocket stay
on the VPS behind a proxied Cloudflare DNS record.

```text
Cloudflare Pages     agee.app marketing, static app shell
Cloudflare DNS       api.<domain> proxied -> VPS gateway HTTP + WS
VPS                  gateway Node process, Postgres, DATA_DIR volume
```

Cloudflare's proxy supports WebSocket, so the voice socket can sit behind the
proxied record. The gateway itself does not run in Workers: Workers cannot hold
the long-lived voice socket or the Node harness-worker boundary. Pages serves
data-only surfaces; the extension keeps loading customizations as data per the
Manifest V3 rule, not as hosted privileged code.

`cloudflare-dns-tls-runbook.md` is the operational checklist for this split.
`digitalocean-self-host-runbook.md` and `railway-self-host-runbook.md` cover
the first droplet and one-image PaaS preview paths from the same image.

### Decision: single sticky voice instance first

Voice runs as one instance. A user's WebSocket must land on the instance holding
its session, so multi-instance voice needs session affinity or shared session
state. That is deferred per the saved strategy. One droplet, one gateway process,
one voice instance is the target for this change. Scaling is a later change.

### Decision: secrets and backups

Secrets stay in an env file on the VPS for now, read by the container at start.
Harness credentials are never host-mounted into the gateway container: the
gateway does not run harnesses, so it has no reason to hold those credentials,
and the worker-pull model keeps them on the execution machine.

Before any promotion that changes the active URL or restarts the active service,
take a Postgres dump and a `DATA_DIR` snapshot, and run a read-only restore check
against a scratch target. This matches the versioned-state rule: the shared event
store must survive version churn, and a restore path must be proven before a
mutation.

The concrete promotion gate is `backup-restore-runbook.md` plus
`scripts/vps-backup.sh` and `scripts/vps-restore-check.sh`. The scripts are
preview/promotion tooling only; this change does not claim that any active
backup, restore, deploy, apply, service restart, client cutover, OTA publish, or
browser reload has happened.

### Decision: product package is a control plane plus bounded workers

The first package is for builders who already have provider accounts, model or
agent subscriptions, local repos, local harness CLIs, and deployment targets.
The gateway is the control plane and durable state boundary; thin clients are
control surfaces; workers are outbound-only local executors. Hosted convenience
may automate VPS operations, DNS/TLS, backups, restore checks, and package
configuration, but it must not turn the hosted gateway into a harness host, a
provider-account creator, a subscription-limit bypasser, or an active-deploy
authority.

The packaging line and first journey are recorded in `product-packaging.md` and
`self-host-user-journey.md`.

## Boundary summary

```text
stays on VPS gateway     routing, provider creds, Postgres, event store, voice WS,
                         OTA artifacts, better-auth, device/worker tokens, run queue
stays on execution box   harness runs, repo edits, build/test, harness creds
                         (connects OUT to the gateway; no inbound port)
stays on Cloudflare      Pages static frontend + marketing; proxied DNS to the VPS
stays on the client      gateway URL + token only; no provider keys, no passwords
```

## Open questions

- Whether the worker-pull transport should be long-poll or a held WebSocket for
  the first slice, and how to bound claim latency.
- Whether passkey or email is the first sign-in method to ship, given the account
  owner is usually one person during early hosted use.
- Whether device registration approval should happen in the gateway UI, the
  phone app, or both.
- When to cut over blobs from the persistent volume to S3-compatible storage, and
  whether OTA APKs or voice audio moves first.
- Whether hosted mode needs tenant isolation in this change or whether single-
  owner-per-deployment is enough until multi-tenant hosting is real.
