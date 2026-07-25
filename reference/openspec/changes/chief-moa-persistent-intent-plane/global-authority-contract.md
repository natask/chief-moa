# Global Intent Authority Contract

## Problem and non-goals

Chats, process IDs, local worktrees, and harness sessions are transient
containers. None answers which durable outcome exists, who owns it, whether its
attempt is alive, what it produced, or what should happen next. A local agent
must be able to disappear without taking the user's intent with it.

This contract does not make the gateway an execution harness, infer and launch
every thought without review, expose gateway credentials to untrusted clients,
or physically isolate labels before a security or operational need exists.

## Principles

1. Intent is the durable outcome; a run is a leased attempt.
2. Events append; projections describe current state.
3. One hosted authority serves every local and remote surface.
4. Flat ownership is canonical; ancestry is provenance.
5. Logical placement is reversible and does not imply isolation.
6. Raw telemetry remains evidence; curated compact state drives the next cycle.
7. Capabilities advertise; credentials and policy authorize.
8. Stale evidence triggers reconciliation, never an automatic duplicate.
9. Completion points to durable output and independent evidence.

## Terminology

- **intent**: one desired outcome and its acceptance criteria.
- **agent**: a stable registered actor.
- **run**: one bounded, leased execution attempt.
- **launcher**: a client that routes a message and starts or steers a run.
- **reconciler**: a singleton-by-claim process that repairs stale state.
- **recap**: curated compact state derived from source-bounded evidence.
- **artifact**: durable versioned output.
- **session telemetry**: append-only runtime observations.
- **placement**: tenant/namespace/sphere/project routing metadata.

## Decision

Chief Moa's hosted gateway is the single authoritative entry point for intent
state. Local and remote launchers are clients of that authority. They do not
create private intent databases and later attempt to merge them.

The first deployment uses one physical event substrate and one authenticated
principal. `tenant_id`, `namespace_id`, `sphere`, and `project_id` are logical
routing and policy metadata inside that substrate. They are not separate
databases and, in this release, are not authorization boundaries.

This keeps one entry point, makes reclassification an additive update instead
of a data move, and keeps agent identity stable when a project changes. Later
physical partitioning can copy complete event streams and verify them before a
routing cutover.

## Architecture

```text
Mac / browser / phone / remote service
             |
             v
       api.agee.app intent API
             |
       append-only product_events
             |
     deterministic projections
       /          |          \
 intents       agents/runs   artifacts/messages/notifications
     ^             |
     |             v
 launcher adapters and execution runtimes
```

The hosted API is authoritative. Adapters cache delivery/retry state only and
reconcile it with server receipts. Execution runtimes never become alternate
intent databases.

## Canonical identities and placement

Identifiers are opaque stable strings. Names, paths, hostnames, chat thread
names, and bearer tokens are not identities.

| Object | Stable identity | Ownership |
| --- | --- | --- |
| tenant | `tenant_id` | account authority |
| namespace | `(tenant_id, namespace_id)` | tenant |
| project | `(tenant_id, namespace_id, project_id)` | namespace |
| intent | `intent_id` | tenant; classified by namespace/sphere/project |
| agent | `agent_id` | exactly one intent |
| run | `current_run_id` until a run aggregate exists | agent |
| artifact | immutable reference plus version/digest | intent or run |
| notification | `notification_id` | intent |

`namespace_id` describes an operating context such as personal, work, or a
company. `sphere` is a routing label. `project_id` is the durable portfolio
group. Defaults are
`tenant_global/namespace_default/personal/project_unfiled`, so uncertain
classification does not lose capture. A later update can refile the intent
without changing intent, agent, run, or artifact identity.

No implementation may describe these labels as isolation until per-principal
authorization is enforced before every read and mutation.

## Normative data model

| Aggregate | Required state |
| --- | --- |
| `Intent` | identity, placement, objective/acceptance, status, owner, next action, sensitivity, provenance |
| `Agent` | identity, intent, runtime/location/endpoint, capabilities, authority, launcher/parent, recovery |
| `Run` | identity, intent/agent, launch spec, status, lease/claim, budget, times, result |
| `Message` | identity, source, sender, target, type, delivery/receipt, content reference |
| `Recap` | identity/version, objective, decisions, constraints, questions, next action, source bounds |
| `Artifact` | identity/version, intent/run, locator, digest, media type, parent, creator/provenance |
| `Relation` | identity, typed source/target intent, provenance |
| `Notification` | identity, intent, reason, channel attempts, receipt |
| `SessionEvent` | identity, session/run, kind, payload reference, token/cost/timing |

The current implementation materializes Intent, Agent, opaque artifact
references, and Notification. Run remains a field on Agent until its aggregate
exists.

## Append-only events and projections

Commands validate authorization, idempotency, and expected stream version,
then append immutable events. Corrections append supersession events.
Deterministic reducers rebuild intent lists/detail, agent/run liveness,
ownership, steering, notifications, recap heads, and artifact heads.

No projection field may exist without source events. Multi-stream operations
use one transaction or a durable saga with a repairable intermediate state.

## Intent and lifecycle

An intent represents one desired outcome. It durably records its title,
objective, stable identity, lifecycle, owner, next action, placement,
sensitivity, provenance, artifacts, and timestamps.

Current lifecycle values are `admitted`, `active`, `blocked`, `needs_user`,
`completed`, and `cancelled`. Completion and cancellation are terminal in the
normative model. The current implementation still needs a strict transition
graph.

Every mutation carries an idempotency key and expected stream version.
Conflicting key reuse fails visibly.

Normative intent state machine:

```text
draft -> admitted -> active
admitted -> blocked | cancelled
active -> blocked | needs_user | completed | cancelled
blocked | needs_user -> active | cancelled
completed | cancelled -> terminal
```

`draft` is needed for automatically extracted but unconfirmed thoughts. Current
v1 starts at admitted and requires `user_confirmed=true`; whether automatic
capture may create drafts is a human decision.

Normative run state machine:

```text
registered -> queued -> claimed -> running
running -> blocked | succeeded | failed | cancelled
blocked -> running | failed | cancelled
claimed | running -> stale
stale -> reclaimed -> running
stale -> failed
```

Only succeeded, failed, and cancelled are terminal. Run success does not
complete the intent until acceptance evidence passes.

## Launch-spec schema

Every run references an immutable launch-spec version:

| Field | Meaning |
| --- | --- |
| `prompt_ref` | immutable instruction artifact |
| `model_policy` | allowed providers/models, fallback, reasoning/quality class |
| `tools` | allowlisted tools and connector scopes |
| `capabilities_required` | routing requirements, not permissions |
| `environment` | repo/worktree, runtime image, directory, region |
| `permissions` | filesystem/network/mutation boundaries and approvals |
| `budgets` | token, money, time, tool-call, child-agent limits |
| `completion` | acceptance checks, evidence, verifier requirement |
| `recovery` | heartbeat, lease, retry, reconnect/relaunch policy |
| `output_contract` | recap, artifact, progress, terminal receipt schemas |

Launch specs contain secret-store references, never secret values.

## Agent provenance, capabilities, and recovery

A launcher registers an agent after allocating its stable identity and before
substantive work. Registration records:

- owning intent, launch reason, launcher provenance, and optional parent;
- runtime type, execution location, and a non-secret endpoint reference;
- capabilities and human-readable authority summary;
- registration mode, current run, recovery policy, and recap.

Capabilities advertise suitability; they do not grant authority. Raw
credentials, cookies, authorization headers, and signed callback URLs never
enter intent metadata.

While working, a non-terminal agent sends an authenticated heartbeat before its
lease expires. Projections derive:

- `unleased`: no heartbeat established liveness;
- `healthy`: the latest lease remains valid;
- `stale`: the lease expired without terminal result;
- `terminal`: completed, failed, or cancelled.

Stale is evidence, not authority to launch a duplicate. A future reconciler
must acquire an exclusive recovery claim, apply the agent's recovery policy,
and then reconnect, resume, or relaunch. This slice detects stale agents but
does not autonomously recover them.

Progress is a meaningful durable recap. A heartbeat is temporary liveness and
may carry the current bounded recap. Terminal work links durable output and
verification before its owning intent completes.

## Leases, heartbeats, idempotency, and reconciliation

Heartbeats use unique idempotency keys. Exact replay returns the same durable
lease; different reuse fails. Lease duration is server-bounded.

The reconciler:

1. queries non-terminal runs with expired leases;
2. acquires an atomic compare-and-set recovery claim with owner and expiry;
3. checks terminal receipts and runtime endpoint identity;
4. finalizes a valid terminal receipt, otherwise reconnects when possible;
5. relaunches only when policy, budget, and user authority permit;
6. appends its decision and replacement run link;
7. releases or expires the claim.

A replacement receives a new run ID but retains the intent and appropriate
agent identity. At most one live recovery claim may exist per run.

## Routing, steering, and context compaction

The intent plane is authoritative for where work belongs, not for executing
work. For each incoming message, a launcher:

1. reads a bounded projection using placement, status, capability, and
   liveness;
2. chooses an existing owner or admits a user-confirmed intent;
3. records the routing decision and source turn;
4. sends the message through a runtime-specific adapter;
5. records acknowledgement, progress, and outcome.

Steering is a durable addressed message with an idempotency key, sender,
target, source turn, delivery state, and receipt. It must not overwrite a recap.
The current API has no addressed-message aggregate, so adapters cannot claim
durable steering yet.

Each work cycle should persist a compact state bundle rather than replay an
unbounded chat:

- objective and acceptance criteria;
- current decisions, constraints, and unresolved questions;
- current owner, run, liveness, and next action;
- latest recap plus source-linked artifact and evidence references;
- a bounded set of relevant messages with truncation metadata.

Raw chat and telemetry remain auditable evidence. They are not the default
working context and cannot silently replace the curated state bundle. A recap
must name source event/version bounds so later compaction can supersede it
without erasing history.

## Message steering and ownership

Messages target an intent, agent, or run. The router may choose an existing
owner or a new run. Ownership changes use expected-version compare-and-set. If
a target is busy, policy chooses interrupt, enqueue, or parallel child intent.
Receipts distinguish accepted, queued, delivered, applied, and rejected.
Transport success never implies the runtime applied a message.

## Session telemetry

Each invocation records bounded input/output references, model/provider,
prompt/tool versions, token counts, cost, latency, tool calls, environment,
exit/interrupt reason, and source surface. Sensitive raw content may live in a
separate store with retention policy. Telemetry explains and evaluates work but
cannot mutate canonical intent state without a validated command.

## Relationships, artifacts, and versions

Intent relationships are typed directed edges: `related_to`, `depends_on`,
`blocks`, `corrects`, `supersedes`, and `evidence_for`. They carry provenance
and idempotency. The current plane has no relation endpoint.

An artifact is durable output, not chat text. A complete link contains:

- stable artifact identity and owning intent/run;
- media type, storage locator, immutable digest or version/commit;
- creator, timestamp, provenance, and optional predecessor version.

Text artifacts should use a Git-compatible version model: immutable content
versions, parent version, authoring agent, change reason, and source intent/run.
Current `artifact_refs` are only bounded opaque strings. Callers should prefer
stable references such as `git:<repo>@<commit>:<path>` or
`blob:sha256:<digest>`, but the server does not yet enforce them.

## Notifications, security, and audit

`completed` and `needs_user` create durable notifications. Delivery attempts
and user receipts are separate. The current slice records pending and received
but not per-channel retries or dead letters.

Production routes require TLS and gateway authentication. The current shared
gateway token represents one owner and must not be placed in public browser
JavaScript. Multi-user or multi-company use requires stable user/service
identities, short-lived device and launcher credentials, scoped roles,
revocation, rotation, and tenant authorization on every event.

The append-only event log is the audit authority. It records actor, authority,
correlation, idempotency, time, stream, version, and payload. Projections are
rebuildable. Intent, provenance, lifecycle, artifact, and notification receipt
events retain indefinitely by default. Heartbeat compaction is allowed only
after a retained checkpoint proves the last lease and audit interval.

## Export and reversible physical partitioning

A portable export is ordered events plus a manifest with schema versions,
stream/version bounds, counts, and content digest. The current bounded
projection is useful for inspection but is not a complete export.

Physical partitioning needs an authorization, residency, availability,
backup/restore, or measured scale reason. A future move:

1. selects streams by tenant and placement history;
2. exports ordered events and verifies counts/digests;
3. dual-writes with idempotency preserved;
4. rebuilds and compares projections;
5. switches a directory/router entry;
6. retains a read-only source and rollback pointer;
7. stops dual-write after backup/restore and reconciliation pass.

IDs never encode a database, so identities survive the move.

## Acceptance, evidence, and completion

An intent carries explicit acceptance criteria. A run result links checks,
artifacts, and receipts. Material work requires a verifier that is independent
of its producer. The system may mark a run succeeded before verification, but
marks the intent completed only after required evidence passes. Unsupported
claims remain blockers or human decisions.

## Human decisions

The system emits `needs_user` with a bounded question when authority, ambiguous
placement, acceptance, recovery after side effects, budget increase, or a
material product choice is missing. Non-blocking uncertainty defaults to
`project_unfiled` and a documented assumption. The immediate unresolved choice
is whether automatic thought extraction may create non-executing `draft`
intents without per-item confirmation.

## Concurrency, conflicts, cancellation, and runaway controls

Every mutable stream uses expected versions. Same-key same-command retries
return the original result; same-key different-command requests fail.
Ownership and recovery claims are compare-and-set. Cross-stream invariants use
transactions or visible sagas.

Cancellation is requested, acknowledged, and finalized separately. The runtime
stops accepting new work, receipts partial artifacts, and reports whether an
external side effect may remain. Intent cancellation never deletes evidence.

Each launch spec enforces token, money, wall-clock, tool-call, retry, parallel
run, and child-agent budgets. The gateway rejects or pauses work that exceeds a
budget and notifies the user. Reconciliation cannot silently reset budgets.

## Failure recovery

- Gateway restart: rebuild projections from ordered events.
- Lost response: retry the same idempotency key.
- Agent disappearance: lease becomes stale; reconciler claims recovery.
- Conflicting writers: reject expected-version conflict and reread.
- Partial multi-stream command: saga repair completes or compensates it.
- Corrupt projection: rebuild and compare event bounds/digests.
- Database outage: adapters queue bounded commands locally as `remote_pending`;
  they never claim hosted persistence until a receipt arrives.
- Partition migration failure: return directory routing to the retained source.

## API and surface contract

The existing hosted entry point is `https://api.agee.app/v1/intent-plane`.
The gateway bearer token belongs in a local secret store and is injected into
the client process.

```sh
curl -sS https://api.agee.app/v1/intent-plane \
  -H "Authorization: Bearer $MOA_INTENT_PLANE_TOKEN"
```

Admit a confirmed intent:

```sh
curl -sS https://api.agee.app/v1/intent-plane/intents \
  -H "Authorization: Bearer $MOA_INTENT_PLANE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "intent_id":"intent_example",
    "title":"Ship the global intent plane",
    "objective":"Make hosted state authoritative for local and remote agents",
    "tenant_id":"tenant_global",
    "namespace_id":"namespace_default",
    "sphere":"personal",
    "project_id":"chief-moa",
    "user_confirmed":true,
    "idempotency_key":"intent-example-create-v1"
  }'
```

Register and heartbeat a local agent:

```sh
curl -sS https://api.agee.app/v1/intent-plane/intents/intent_example/agents \
  -H "Authorization: Bearer $MOA_INTENT_PLANE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id":"agent_example",
    "launch_reason":"Implement the hosted intent contract",
    "runtime_type":"codex",
    "execution_location":"local-mac",
    "endpoint_ref":"codex://thread/example",
    "recovery_policy":"manual",
    "capabilities":["gateway","tests"],
    "authority_summary":"May edit and test an isolated worktree",
    "idempotency_key":"agent-example-register-v1"
  }'

curl -sS https://api.agee.app/v1/intent-plane/agents/agent_example/heartbeat \
  -H "Authorization: Bearer $MOA_INTENT_PLANE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "progress":"Implementing the server slice",
    "current_run_id":"run_example",
    "lease_duration_ms":120000,
    "idempotency_key":"agent-example-heartbeat-0001"
  }'
```

The new placement fields and heartbeat route exist only after this candidate is
deployed. Existing clients keep using original v1 fields and progress.

The minimum user surface lists intents grouped by namespace/project, shows
owner and liveness, opens the curated recap/artifacts, accepts steering, and
surfaces pending notifications. It should not require choosing a database.

## Local and remote integration

Local and remote adapters use the same HTTPS API. They register an agent before
work, heartbeat while active, append meaningful progress, and send a terminal
receipt. `endpoint_ref` is a non-secret runtime handle. A rollout-aware adapter
feature-detects new endpoints and keeps unreceipted work `remote_pending`.
Offline caches are delivery queues, not authorities.

## Observability

Health reports the deployed commit and storage mode without secrets. Metrics
cover command latency/error/conflict, event append/reduction lag, active and
stale leases, reconciliation outcomes, notification age, adapter retry queues,
token/cost budgets, and projection rebuild integrity. Logs correlate tenant,
intent, agent, run, event, and request IDs with sensitive content redacted.

## Migration from current v1

1. Add default placement and runtime/lease fields without changing old routes.
2. Rehydrate old events with deterministic defaults.
3. Deploy readers before adapters send new fields.
4. Feature-detect heartbeat during rolling deployment.
5. Add run/message/artifact/recap aggregates beside opaque v1 fields.
6. Backfill links idempotently and compare projections.
7. Switch reads only after backup/restore and public commit-health evidence.
8. Retain v1 compatibility until every surface migrates.

## Alternatives

- **Database per project now:** rejected; adds routing, migrations, backups,
  credentials, and cross-project queries without measured value.
- **Agent-local SQLite as authority:** rejected; remote surfaces cannot reliably
  address or recover it.
- **Chat thread as intent:** rejected; threads are context containers and may
  fork, compact, or disappear.
- **Tree of agent registries:** rejected; ancestry harms direct addressing and
  cross-owner routing. Keep a flat plane with parent provenance.
- **KV cache as durable state:** rejected; it is runtime optimization, not
  portable, reviewable, versioned product state.

## Phased build and test plan

1. Preserve this contract and gap matrix.
2. Add placement fields, filters, and reversible updates.
3. Add agent runtime metadata, heartbeat leases, and stale projection.
4. Run unit, route, and full gateway checks.
5. Commit, create a guarded PR, and obtain independent verification.
6. Promote only after preview, rollback, compatibility, backup/restore, and
   public commit-health gates pass.
7. Next slices: exclusive reconciler claim; addressed steering; typed
   artifact/version records; compact context bundles; then first-class UI.

Tests cover restart rehydration, v1 defaults, reclassification without ID
changes, idempotent heartbeat replay/collision, lease expiry, terminal lease
rejection, auth, secret rejection, expected-version conflict, bounded listing,
adapter rollout fallback, and production backup/restore plus public smoke.
