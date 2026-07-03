# Product Packaging And Self-Host Positioning

## Purpose

This lane defines who the VPS control plane is for, what the product package
contains, and where the line sits between open-source self-hosting and hosted
convenience. It is a product contract for implementation tickets, not launch
copy.

## Target Users

The first users are builders who already pay for or have access to agent tools
such as Claude Code, Codex, Gemini, or similar coding/research subscriptions.
They want Chief Moa to coordinate that work from a stable gateway without
giving a remote service unrestricted access to their whole machine.

Primary user shape:

- owns one or more codebases and wants to start, inspect, and steer agent work
  from mobile and browser surfaces;
- already has provider accounts, model subscriptions, CLI harnesses, repo
  credentials, and deployment targets;
- can provision a small VPS or wants a managed VPS provided for them;
- wants a stable HTTPS gateway URL instead of a ZeroTier or localhost address;
- wants credentials and work history in one durable place;
- wants workers to be bounded by project, harness, token, and explicit
  capability;
- wants preview/deployment links they can review from mobile before promotion.

Non-target users for the first slice:

- people who want Chief Moa to create provider accounts, bypass subscription
  limits, or farm free tiers;
- people who want the VPS to SSH into a personal machine or run arbitrary shell
  commands sent from the gateway;
- people who need enterprise multi-tenant administration, SSO, audit export, or
  fleet policy on day one;
- people who only want a general chat app with no durable work graph.

## Product Package

Chief Moa packages three roles around one gateway URL.

| Role | What it owns | What it must not own |
| --- | --- | --- |
| VPS gateway | Auth, account connection state, provider/model routing, voice routing, Postgres work history, device tokens, worker tokens, queued runs, artifacts, deployment records. | Local repo edits, local shell authority, Android actions, browser page actions, active deployment promotion without approval. |
| Thin clients | Android and browser control surfaces, voice/text capture, local permissions, local UI opens, local action receipts. | Raw provider credentials, worker tokens, harness credentials, hidden execution. |
| Worker | Outbound claim loop, local allowlisted project paths, harness execution, before/after snapshots, verification, artifact production. | Creating runs, reading unrelated user data, applying active deployments, accepting arbitrary gateway shell commands. |

The product is a control plane plus bounded workers. It is not a hosted agent VM
and it is not a remote desktop tunnel.

## Mode Line

The gateway ships as one code path and one deployable image.

| Mode | Use | Store | Auth | Execution |
| --- | --- | --- | --- | --- |
| `local` | Developer QA and local device testing. | File fallback allowed; Postgres optional. | May be disabled or single-token. | Harness may run in-process for local tests. |
| `self-host` | User-owned VPS. | Postgres required; `DATA_DIR` on persistent volume. | Auth required; device and worker tokens. | Worker-pull only for harness work. |
| `hosted` | Managed convenience using the same image. | Postgres required; backups expected. | Better-auth user sessions plus device and worker tokens. | Worker-pull only; hosted gateway does not run user harnesses. |

Hosted mode is self-host mode plus operations. It must not fork the product
contract or hide behavior that a self-hoster cannot inspect.

## Open Source And Self-Hostable

The open-source/self-hostable package includes:

- gateway source, Docker image build, Compose stack, and `MOA_MODE` config;
- Postgres schema, migrations, and event/work-history storage contracts;
- `DATA_DIR` persistent-volume layout for OTA artifacts, retained voice audio,
  context packs, run artifacts, and deployment records;
- Android and browser client code that stores only gateway URL plus device
  token;
- worker registration, token, claim, heartbeat, event, cancellation, and result
  contracts;
- account connection APIs and policy that keep raw provider credentials inside
  the gateway-side credential boundary;
- voice/text control-plane behavior for creating tasks, asking status,
  attaching feedback, and opening relevant client UI;
- backup and restore procedure required before any active promotion.

A self-hoster is responsible for:

- provisioning the VPS, DNS, TLS/proxy, Postgres volume, and gateway env;
- entering or connecting their own provider credentials through gateway-owned
  flows;
- running at least one worker on an execution machine that has the local repos,
  harness CLIs, and harness credentials;
- keeping the VPS patched and monitoring disk, database, and certificate health
  unless they use hosted convenience;
- approving any active deployment promotion.

Self-host must remain usable without a hosted account. A self-hoster may still
choose hosted frontend assets or public docs, but the control plane must run
from the open repo and the user's own gateway URL.

## Hosted Convenience

Hosted convenience may provide:

- managed VPS provisioning for the gateway image;
- managed DNS/TLS and a stable API URL such as `https://api.agee.app` or a
  user-owned domain;
- managed Postgres, persistent blob storage, backups, restore checks, and
  upgrade rollout;
- hosted better-auth sign-in, passkey/email recovery, and device approval UI;
- credential-health scheduling, reauth prompts, and mobile/browser
  notifications;
- hosted status pages, runtime diagnostics, and support for gateway upgrade
  failures;
- prebuilt Android and browser client packages that point at a configured
  gateway URL.

Hosted convenience must not provide:

- model/provider subscriptions on behalf of the user unless a later commercial
  contract explicitly says so;
- account creation, subscription-limit evasion, or provider portal scraping;
- raw provider credentials in Android, browser, or worker registration payloads;
- harness execution on the hosted gateway;
- unrestricted access to the user's local machine;
- active deployment apply, URL switching, or service restart without a current
  user promotion request and backup/restore evidence.

## Product Primitives

Implementation tickets should attach to these primitives instead of inventing
new nouns:

| Primitive | Ticket use |
| --- | --- |
| `user` | Better-auth identity and event actor. |
| `device_token` | Android/browser credential bound to user, device id, and surface type. |
| `worker_token` | Execution-machine credential scoped to claim/report on allowlisted projects and harnesses. |
| `account_connection` | User-owned provider account, credential kind, status, refresh, reauth, and audit events. |
| `broker_event` | Canonical stored user message before routing. |
| `route_decision` | Inspectable broker decision with workflow, target, confidence, and cancellation policy. |
| `work_task` | User-facing durable unit of intent. |
| `agent_run` | Gateway-created queued run that a worker may claim. |
| `repo_snapshot_ref` | Before, after, or checkpoint state recorded by a worker. |
| `diff_ref` | Link between snapshots and inspectable patch artifact. |
| `verification_artifact` | Command or manual QA evidence for a run. |
| `deployment_record` | Preview, artifact-only, or applied deployment state. |
| `user_feedback` | Follow-up voice/text evidence attached to a task, run, verification, or deployment. |
| `tool_request` | Client-local request such as opening a run page or deployment preview. |
| `receipt` | Client or worker proof that a claimed proposal was handled or rejected. |

## First Implementation Slices

These are ticket boundaries that should be independently verifiable.

### Slice 1: Self-Host Gateway Starts Safely

Deliverable:

- Docker/Compose path starts the gateway with `MOA_MODE=self-host`, Postgres,
  and persistent `DATA_DIR`.
- Remote mode refuses startup without auth and `DATABASE_URL`.
- `/health` distinguishes process health from authenticated route access.

Acceptance:

- `docker compose --env-file <env> config` resolves required services and
  volumes.
- self-host mode without `DATABASE_URL` fails fast.
- a scratch gateway reports healthy without mutating the active deployment.

### Slice 2: Owner, Device, And Client Onboarding

Deliverable:

- owner can authenticate through better-auth or the migration token path;
- Android and browser register against one stable HTTPS gateway URL;
- clients replace bootstrap credentials with per-device tokens.

Acceptance:

- stale ZeroTier/local URLs produce specific diagnostics;
- `/health` success is never treated as token success;
- protected route success proves the saved device token works;
- voice readiness is checked separately from gateway reachability.

### Slice 3: Account Connections And Credential Health

Deliverable:

- user can list provider catalog, start a connection, inspect status, refresh,
  and reauth;
- raw provider credentials never leave the gateway-side credential boundary;
- account health can queue a user-facing reauth prompt.

Acceptance:

- connection records expose labels, status, expiry, scopes, refresh state, and
  `needs_user_action`;
- API serializers cannot return raw credential fields;
- refresh failure moves the connection to an explicit action-required state.

### Slice 4: Worker Registration And Pull Loop

Deliverable:

- owner creates a short-lived worker registration code;
- execution machine registers outbound and receives a scoped worker token;
- worker long-polls for one claim, streams events, heartbeats, and reports a
  terminal result.

Acceptance:

- claim payload includes run linkage and excludes `command`, `shell`, `env`,
  raw credentials, and absolute untrusted paths;
- gateway records queued, claimed, started, event, and completed states;
- stale claims cannot overwrite terminal results.

### Slice 5: Work History, Deployment Link, And Mobile Feedback

Deliverable:

- voice/text can create a task/run, ask status, request latest deployment link,
  ask a client to open the relevant UI, and attach feedback;
- worker-produced preview or artifact links are stored as deployment records;
- active promotion remains gated.

Acceptance:

- status answers come from stored events/projections, not provider memory;
- deployment link queries distinguish preview, artifact-only, applied, failed,
  and superseded records;
- feedback attaches to the intended task/run without canceling work unless
  cancellation is explicit;
- mobile UI open uses `tool_request` plus client receipt.

## Pricing And Packaging Rules For Later

These rules are implementation constraints even before pricing exists:

- Hosted billing can charge for managed gateway operations, storage, backups,
  alerts, and support, not for undisclosed use of the user's provider
  subscriptions.
- BYOK and connected-account flows must be first-class in hosted mode.
- Self-host must not be a crippled edition. Hosted can automate operations, but
  self-host must keep the core control-plane features.
- A hosted gateway can be multi-user later, but the first hosted package may be
  one owner per deployment if the data model keeps user ids and event actors.
- Any packaged client must remain configurable for a self-hosted gateway URL.

## Failure Modes To Test

- User points one client at a local/ZeroTier gateway and another at the VPS.
- `/health` passes but the device token is missing, expired, or belongs to a
  different gateway.
- Gateway starts remote mode with file fallback and loses multi-client state.
- Worker token can read sessions, provider credentials, or deployment apply
  endpoints outside its claim/report scope.
- Claim payload gives the worker an arbitrary shell command instead of a named
  harness and project alias.
- Hosted copy implies Chief Moa provides agent subscriptions or bypasses
  provider limits.
- A preview deployment link is treated as active promotion.
- A voice feedback turn cancels or overwrites active work without explicit
  cancellation language.
