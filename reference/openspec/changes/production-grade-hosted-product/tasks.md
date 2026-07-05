# Tasks

Legend for the tag on each ticket:
- `[ready]` — can start now; touches only new files, no contested lines.
- `[blocked: consolidation]` — waits on `codex/vps-agent-control-plane` and
  `worktree-agent-af6a296e02865afd2` landing to master (task #4).
- `[blocked: voice-worktrees]` — waits on the active voice worktrees that own the
  `server.js` history read paths and `gateway/lib/voice-providers.js`.
- `[decision: N]` — waits on USER DECISION N in proposal.md.

Every ticket has one observable acceptance check.

## Phase 0. User decisions and consolidation gate

- [x] 0.1 `[decision: 1-5]` Record the five USER DECISIONS as resolved at the top
  of proposal.md (one image vs microservices, auth engine, BYOK backend, billing
  model, multi-tenant timing).
  Acceptance: proposal.md's USER DECISIONS section shows a confirmed choice, not a
  recommendation, for each of the five.

- [x] 0.2 `[blocked: consolidation]` Land `codex/vps-agent-control-plane` and
  `worktree-agent-af6a296e02865afd2` to master so the MOA_MODE server changes, the
  Docker/compose stack, the worker-pull control plane, the account-connection
  store, and the VPS scripts are on the mainline this change builds on.
  Acceptance: master contains `gateway/Dockerfile`, `docker-compose.yml`, the
  `MOA_MODE` block in `server.js`, `gateway/lib/account-connections.js`, and
  `scripts/vps/*`, and `cd gateway && npm run check` passes on master.

## Phase 1. Postgres as source of truth

- [ ] 1.1 `[ready]` Add projection builders over `product_events` for each read
  surface (sessions, voice turns, agent runs, browser tasks, tool requests,
  profile history) as new modules under `gateway/lib/projections/`.
  Acceptance: given a seeded event log, each projection returns the same records
  the current file read returns for the same inputs, verified by a projection
  unit smoke.

- [ ] 1.2 `[ready]` Add a one-time importer script that replays existing
  `DATA_DIR` files into `product_events` with idempotency keys.
  Acceptance: running the importer twice against a sample `DATA_DIR` yields the
  same event count the first run produced (no duplicates) and the projections read
  back every imported record.

- [ ] 1.3 `[blocked: voice-worktrees]` Switch `server.js` read paths to the
  projections in remote modes, keeping file reads as the `local`-only fallback.
  Acceptance: with `MOA_MODE=self-host` and `DATABASE_URL` set, a sessions read, a
  voice-turn read, and an agent-run read return from Postgres with the flat-file
  store removed from the container, and the same reads in `local` mode still work
  from files.

- [ ] 1.4 `[blocked: consolidation]` Make remote modes refuse to start if a read
  path would fall back to files (fail fast rather than silently serve stale files).
  Acceptance: starting `MOA_MODE=hosted` with a projection unavailable exits with a
  clear error instead of serving a flat file.

## Phase 2. Auth service (anonymous-first, self-hostable)

- [ ] 2.1 `[ready]` `[decision: 2]` Add the better-auth module and its Postgres
  tables behind the existing `MOA_AUTH` flag, seeding the owner user so pre-auth
  events keep a stable author (extends `remote-hosted-gateway` task 3.1-3.2).
  Acceptance: with the flag on, the better-auth tables exist, the single token maps
  to the seeded owner, and existing writes keep one stable author id.

- [ ] 2.2 `[ready]` `[decision: 2]` Add the anonymous session plugin: a first
  visit gets an anonymous user row and a session/device token, usable immediately.
  Acceptance: a fresh client with no account receives an anonymous session and can
  complete a chat turn attributed to that anonymous user id.

- [ ] 2.3 `[ready]` `[decision: 2]` Add a server-side trial counter projected from
  the event log per anonymous user, with a configurable boundary.
  Acceptance: after the configured number of turns, the anonymous user's next
  billable turn is refused with a "create an account to continue" result, and
  clearing client storage and reconnecting does not reset the counter.

- [ ] 2.4 `[ready]` `[decision: 2]` Add email and passkey sign-up plus
  account-linking that promotes an anonymous user to a real account, keeping the
  same user id and its data.
  Acceptance: an anonymous user with prior turns creates an account and the prior
  turns remain attributed to them after promotion.

- [ ] 2.5 `[blocked: consolidation]` Add the extension device-registration login
  surface that mints a per-device token from an authenticated session.
  Acceptance: a user signs in from the extension, approves the device, and the
  extension authenticates a subsequent turn with a per-device token while storing
  only a gateway URL and that token.

## Phase 3. Model/key management service

- [ ] 3.1 `[ready]` `[decision: 3]` Add a `KeyVault` interface with a
  Postgres-envelope-encryption implementation (`MOA_KEY_MASTER` from env wraps a
  per-key data key) for BYOK storage.
  Acceptance: a submitted provider key is stored as ciphertext plus a wrapped data
  key in Postgres, the master key never appears in the database, and a get returns
  a usable secret only through `getForCall`, never to a client response.

- [ ] 3.2 `[ready]` `[decision: 3]` Add an optional external-vault backend behind
  the same `KeyVault` interface (Nango/Infisical adapter), selected by env.
  Acceptance: with the external-vault env set, put/get/rotate/revoke delegate to
  the backend and callers are unchanged; with it unset, the Postgres-envelope
  implementation is used.

- [ ] 3.3 `[ready]` `[decision: 4]` Add the `virtual_key` model: user id, allowed
  models, routing policy (`byok`/`hosted_pool`/`self_host_operator`), budget, and
  a spend projection.
  Acceptance: creating a virtual key for a user, then reading it back, returns the
  allowed model set, policy, budget, and a spend of zero.

- [ ] 3.4 `[blocked: voice-worktrees]` Wire the routing layer to resolve a virtual
  key and select the credential at call time by policy (BYOK decrypt, hosted pool,
  or self-host operator key).
  Acceptance: a call on a `byok` key uses the user's decrypted key, a call on a
  `hosted_pool` key uses the hosted credentials, and a call on a
  `self_host_operator` deployment uses the single operator key, each verified by
  the provider request's credential source without the raw secret appearing in
  logs or model context.

- [ ] 3.5 `[ready]` `[decision: 4]` Add a pre-call budget check that refuses an
  over-budget virtual key before the provider request.
  Acceptance: a virtual key whose projected spend meets its budget is refused
  before the provider call, with a budget-state result.

## Phase 4. Billing/subscription seam (design + metering only)

- [ ] 4.1 `[ready]` `[decision: 4]` Emit a `usage_metered` product event per model
  call (user id, virtual key, model, token counts, cost estimate).
  Acceptance: completing a model call appends one `usage_metered` event and the
  virtual key's spend projection increases by the metered cost.

- [ ] 4.2 `[ready]` `[decision: 4]` Add the `BillingProvider` interface
  (ensureCustomer, reportUsage, checkEntitlement, webhook) with a `none`
  default that meters without charging.
  Acceptance: with no provider configured, metering events accrue and no charge is
  attempted; the interface is importable and the `none` implementation satisfies it.

- [ ] 4.3 `[ready]` `[decision: 4]` Document the Stripe implementation shape
  (metered billing, customer portal, webhook reconciliation into virtual keys) as
  a design note without wiring it.
  Acceptance: a design note describes each `BillingProvider` method's Stripe
  mapping and the webhook-to-virtual-key reconciliation, with no live Stripe code.

## Phase 5. Hosted deployment topology

- [ ] 5.1 `[blocked: consolidation]` Confirm the one-image compose stack + MOA_MODE
  + Cloudflare split from the stranded branches serves a hosted gateway with
  better-auth tables, the virtual-key store, and metering in one Postgres.
  Acceptance: `docker compose up` reaches a healthy gateway whose Postgres holds
  the better-auth, event, virtual-key, and metering tables, with blobs on the
  mounted volume.

- [ ] 5.2 `[blocked: consolidation]` Extend the backup/restore-check scripts to
  cover the new tables (auth, virtual keys, metering) so one dump + one restore
  covers the whole product.
  Acceptance: the backup script dumps all product tables and the restore check
  rebuilds a scratch gateway that answers `/health` and a virtual-key read without
  touching the active deployment.

## Phase 6. Agent-driven self-host provisioning

- [ ] 6.1 `[blocked: consolidation]` Add a `provision_self_host` worker tool that
  wraps the existing `scripts/vps/*` (bootstrap, backup, restore-check) with a
  bounded input (target host handle, mode, customization pack ref) and a receipt.
  Acceptance: the worker claims a provisioning run, runs bootstrap + backup +
  restore-check against a target host, and posts a receipt with the new engine URL,
  with no inbound port on the worker and no shell handed to the gateway.

- [ ] 6.2 `[blocked: consolidation]` Route a "self-host this for me" turn to a
  provisioning agent run that returns a run id immediately (async, wait=false).
  Acceptance: a spoken or typed self-host request creates an agent run and returns
  a run id without blocking, and the run's status is inspectable.

- [ ] 6.3 `[blocked: consolidation]` Mint a new device token for the provisioned
  gateway and surface a human-approved re-point in the extension.
  Acceptance: on provisioning completion the extension shows the new engine URL and
  re-points only after explicit human approval, leaving the old deployment intact
  until then.

- [ ] 6.4 `[ready]` Define the customization pack format (profile, page tweaks,
  model policy) that provisioning applies to the new self-hosted gateway.
  Acceptance: a customization pack schema exists and a sample pack validates
  against it, covering agent profile, page tweaks, and virtual-key/model policy.

## Phase 7. Client login UX boundary

- [ ] 7.1 `[blocked: consolidation]` Add the extension login/settings surface
  (sign in, register device, show connection status) that stores only URL + token.
  Acceptance: the extension login surface signs a user in, registers the device,
  and shows connected status, and inspection confirms it stores only a gateway URL
  and a per-device token.

- [ ] 7.2 `[ready]` Document the Android boundary: Android keeps approvals,
  permissions, and local action execution; login never moves that authority.
  Acceptance: an ARCHITECTURE.md note (or OpenSpec spec delta) states that the
  login surface adds identity only and does not move Android's approval authority.

## Phase 8. Verification

- [ ] 8.1 Gateway: `cd gateway && npm run check`.
- [ ] 8.2 Migration smoke: importer replays a sample `DATA_DIR`, projections read
  every record, second run adds no duplicates.
- [ ] 8.3 Auth smoke: anonymous session -> trial refusal -> account creation with
  data linkage -> per-device token authenticates a turn.
- [ ] 8.4 Key smoke: BYOK key stored encrypted, resolved only via `getForCall`,
  never in a client response or log; over-budget key refused pre-call.
- [ ] 8.5 Metering smoke: a model call appends one `usage_metered` event and the
  spend projection reflects it.
- [ ] 8.6 Provisioning smoke: a self-host run is claimed by an outbound-only
  worker, runs bootstrap + restore-check, and reports a new engine URL as a receipt.
- [ ] 8.7 Deploy smoke: `docker compose up` reaches a healthy gateway holding all
  product tables in one Postgres; backup + restore-check pass before any promotion.
