## Context

chief-moa's gateway owns routing, provider credentials, durable state, agent-run
storage, voice routing, and OTA artifacts. Android and the extension are thin
clients holding a gateway URL plus a token. The execution machine owns harness
runs. That boundary holds here; this change adds a real database as the source of
truth, per-user auth, per-user key management, a billing seam, hosted deployment,
and an agent-driven self-host path.

Two prior changes set the direction and are extended, not replaced:

- `self-hostable-event-substrate`: Postgres event log (`product_events`) with a
  `product-events.jsonl` local fallback; projections are rebuildable views over
  events. Today the gateway dual-writes to this log but still reads flat files.
- `remote-hosted-gateway`: one image, `MOA_MODE` (`local`/`self-host`/`hosted`),
  better-auth progression, worker-pull execution, account-connection store,
  Cloudflare split, VPS backup/restore. Its worker-pull and account-connection
  contracts and its Docker/MOA_MODE code live on the stranded branches
  (`codex/vps-agent-control-plane`, `worktree-agent-af6a296e02865afd2`).

This change closes the gaps those two leave: the read-path migration, the
anonymous-first account flow, the BYOK virtual-key layer, the billing seam, and
the agent-driven self-host capability.

## Decision: one image, internal service boundaries (reconciling microservices)

USER DECISION 1. The recorded strategy (`deploy-auth-strategy.md`,
five-wants research) is one deployable gateway with modular internals, extracting
only stateless adapters later. This change keeps that and states why microservices
lose here specifically:

- The headline feature is agent-driven self-host: the model provisions **one**
  VPS and the user gets a working engine URL. A microservice mesh means the agent
  must stand up and wire N services, N health checks, N backup targets, and a
  restore check across all of them. One container is one bootstrap, one dump, one
  restore.
- Self-hosters are the first-class audience. A solo self-hoster running `docker
  compose up` on a droplet cannot be asked to operate a service mesh.
- The event substrate already gives the decoupling microservices are usually
  reached for: append-only events plus rebuildable projections let modules
  communicate through the log without a network hop.

So: auth, key-management, billing, event-store, routing, and provisioning are
**internal modules** in the one Node process, each behind a narrow interface
(`gateway/lib/*`), each individually testable, each extractable to a worker later
without changing Android or extension protocols. This is the same posture
`deploy-auth-strategy.md` already recorded: "keep the gateway modular internally
and extract only stateless adapters later."

Extract-later candidates, in order, if load demands it: (1) the transcription/STT
worker, (2) provider bridges, (3) the metering/billing aggregator. Auth and the
key vault stay in-process because they sit on the hot path of every call and
splitting them adds a network round trip to every model request.

## Decision: better-auth with an anonymous-first flow

USER DECISION 2. `remote-hosted-gateway` already chose better-auth. This change
adds the anonymous-first requirement and shows it maps cleanly:

```text
first visit         better-auth anonymous plugin issues an anonymous session
                    (a real user row flagged anonymous); the client stores the
                    session/device token and uses the product immediately
trial boundary      a soft limit (turns, days, or a feature gate) prompts
                    "create an account to continue"
account creation    email or passkey sign-up; better-auth account-linking moves
                    the anonymous user's events, connections, and keys to the
                    new identity (same user_id kept, promoted from anonymous)
device tokens       an authenticated session mints per-device tokens for the
                    extension and Android, each bound to the user_id + device_id
```

Why better-auth over alternatives:

- In-process, Postgres-native, no separate service to deploy or self-host. Ory
  (Kratos + Hydra) and Zitadel are separate services; they fight decision 1's
  one-image goal. SuperTokens can self-host but still runs a core service.
- Has first-party anonymous, email, and passkey plugins, so the whole
  anonymous-to-account flow is one library.
- The self-host operator gets auth with zero extra infrastructure, satisfying
  "the auth pipeline must be self-hostable too."

The anonymous boundary is a policy, not a hard wall: `local` mode can disable it
entirely (no auth), `self-host` can set a generous or disabled trial, `hosted`
sets the product's real trial. The boundary value is config.

Trial-state storage: the anonymous user row carries a `trial_started_at` and a
counter projected from the event log (turns used), so the trial cannot be reset
by clearing client storage; it is server-side per anonymous user.

## Decision: per-user model/key management (LiteLLM-style virtual keys)

USER DECISION 3 and 4. Lift LiteLLM's virtual-key model conceptually. A
`virtual_key` is the unit users and billing both see:

```text
virtual_key
  id              vk_...
  user_id         owner
  allowed_models  which models this key may call
  routing_policy  byok | hosted_pool | self_host_operator
  byok_ref        (when byok) a ref into the encrypted key store, never a raw key
  budget          optional spend cap
  spend           running total, projected from metering events
  status          active | over_budget | disabled | revoked
```

Routing policies:

- `byok`: the call uses the user's own provider key, stored encrypted. The user
  brought a key; the gateway decrypts it at call time, uses it, never logs it,
  never returns it, never places it in model-visible context. This reuses and
  generalizes the existing `account-connections` store (already on the stranded
  branch) which has secret-scrubbing and a provider catalog.
- `hosted_pool`: the call uses the hosted product's own provider credentials; the
  user is paying via subscription, so metering + budget apply against their plan.
  This is the "using their auth in this pipeline — they have a subscription" path.
- `self_host_operator`: the call uses the self-host operator's single configured
  key for all their users. A self-hoster sets one key in env and every virtual
  key on that deployment routes to it.

BYOK storage (decision 3): the default is envelope encryption inside the
gateway's own Postgres. A per-deployment master key (`MOA_KEY_MASTER`, env-only,
never in the DB) wraps a per-key data key; the encrypted blob and wrapped data
key live in Postgres. Zero extra services. An operator who already runs Nango or
Infisical (from the five-wants research) can set a vault backend env var and the
key store delegates to it instead. The interface is one `KeyVault` with `put`,
`getForCall`, `rotate`, `revoke` — the Postgres-envelope implementation and the
external-vault implementation both satisfy it.

The credential never crosses the model boundary. `getForCall` returns a handle
the routing layer uses to sign the outbound provider request; the raw secret is
resolved inside the provider bridge and dropped, matching the existing
account-connection scrubbing rules.

## Decision: billing/subscription seam (design only)

USER DECISION 4. Metering rides the event log. Each model call emits a
`usage_metered` product event (user_id, virtual_key, model, input/output tokens,
cost estimate). The virtual key's `spend` is a projection over those events. A
pre-call check reads the projected spend against `budget`; an over-budget key is
refused before the provider call.

The billing provider is an interface, not an integration:

```text
BillingProvider
  ensureCustomer(user)        -> external customer id
  reportUsage(user, meter)    -> push metered usage upstream (or no-op)
  checkEntitlement(user)      -> plan, limits, active/past_due
  webhook(event)              -> reconcile plan changes back into virtual keys
```

Stripe is the first intended implementation (metered billing + customer portal),
behind this seam. A `none` implementation (self-host, no billing) is the default
so a self-hoster runs with metering-for-visibility but no charging. No live
Stripe wiring in this change; the seam, the metering event, and the pre-call
budget check are the deliverables.

## Decision: hosted deployment topology

Reuse `remote-hosted-gateway`'s topology unchanged:

```text
Cloudflare Pages     marketing + static app shell (agee-app project already live)
Cloudflare DNS       api.<domain> proxied -> VPS gateway HTTP + voice WS
VPS (droplet)        one gateway container, Postgres, DATA_DIR volume, env file
execution machine    connects OUT via worker-pull; no inbound port
```

better-auth tables, the event substrate, the virtual-key store, and the metering
events all live in the same Postgres: one database, one dump, one restore. This
change adds no new deployed service to that picture — the point of decision 1.

## Decision: agent-driven self-host as a gateway capability

This is the feature that makes "hosting is just another question you ask the
model." It composes existing pieces:

```text
user (in extension): "configure and self-host this for me on my own VPS"
  -> gateway routes this as an agent run (existing run store, wait=false)
  -> the run targets a provision_self_host tool exposed to the worker
  -> the worker (execution machine) claims the run and runs the VPS scripts:
       vps/bootstrap.sh (create/prepare host, install the one image)
       apply the user's customizations (profile, page tweaks, model policy)
       vps/backup.sh + vps/restore-check.sh proven before cutover
  -> the worker reports the new engine URL + a freshly minted device token
  -> the gateway records the provisioning receipt against the run
  -> the extension shows "your self-hosted engine is ready" and, on human
     approval, re-points its engine URL + device token to the new gateway
```

Boundaries that hold (from AGENTS.md and the change freeze):

- The model **proposes** provisioning; it does not silently mutate a running
  deployment. Standing up a new VPS is a create; re-pointing the active client is
  a human-approved cutover.
- The worker runs the scripts inside its local execution boundary. The gateway
  queues and records; it does not SSH or hold a shell (worker-pull contract).
- Backup + restore-check run before any active-URL change (versioned-state rule).
- The self-host target runs the same one image, so "self-host" is a deployment
  mode, not a fork.

The provisioning tool is the agent-facing wrapper over the VPS scripts that
already exist on the stranded branches. The new work is exposing them as a
claimable worker tool with a bounded input (target host handle, mode, customization
pack ref) and a receipt, not writing the scripts from scratch.

## Decision: read-path migration off flat files

Today `server.js` reads `CONVERSATIONS_DIR`, `VOICE_TURNS_DIR`, `AGENT_RUNS_DIR`,
`BROWSER_TASKS_DIR`, `TOOL_REQUESTS_DIR`, `BROKER_EVENTS_DIR`, `DEVICE_CLIENTS_FILE`,
`PROJECTS_FILE`, and profile history from disk while dual-writing events. The
migration makes Postgres the read source in remote modes:

```text
stage A   projections built from the event log for each read surface
          (sessions, voice turns, runs, browser tasks, tool requests, profile)
stage B   read paths switch to the projection in remote modes; file reads stay
          the fallback only in local mode
stage C   a one-time importer replays existing DATA_DIR files into product_events
          so a live file-backed deployment migrates without losing history
stage D   file writes become local-mode-only; remote modes are Postgres-only
```

The importer is idempotent (events carry idempotency keys per the substrate spec),
so it can run twice safely. The migration is one-way: once on Postgres, the flat
files are a frozen backup, not a live store.

Sequencing constraint: the `server.js` history read paths are actively edited by
voice worktrees right now. Stage B must land after those worktrees merge, or must
be done on the consolidated tree. Stages A and C (new projection builders and a
standalone importer script) can be built first without touching the contested
read lines.

## Client boundary summary

```text
stays in the one gateway   routing, provider creds, Postgres event store +
                           projections, better-auth, virtual-key store, encrypted
                           BYOK vault, metering, billing seam, device/worker
                           tokens, run queue, provisioning capability
stays on the execution box  harness runs incl. the self-host provisioning scripts
                           (connects OUT; no inbound port)
stays on Cloudflare        Pages static frontend + marketing; proxied DNS to VPS
stays on the client        gateway URL + per-device token; login surface; NO
                           provider keys, NO passwords, NO raw BYOK secrets
Android keeps              approvals, permissions, local action execution, receipts
```

## Open questions

- Where the trial boundary sits (turn count, wall-clock days, or a specific
  feature gate) for hosted mode, and whether anonymous sessions expire.
- Whether `hosted_pool` metering is per-token cost or a simpler per-request or
  seat model for the first billing pass (feeds decision 4).
- Whether the BYOK master key is a single env value or comes from a KMS in hosted
  mode (envelope encryption supports both; which ships first).
- Whether the self-host provisioning tool targets only a pre-existing SSH-reachable
  host the user supplies, or also calls a cloud provider API to create the droplet
  (creating cloud resources spends money and touches the purchase boundary).
- Whether device-token registration approval happens in the extension, the phone,
  or the gateway UI (inherited open question from `remote-hosted-gateway`).
