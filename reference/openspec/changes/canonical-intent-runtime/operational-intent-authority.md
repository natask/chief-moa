# Operational Intent Authority

## Decision

Chief MOA uses one hosted intent authority and one chronological message
stream. Local and remote surfaces write through the same authenticated API.
Projects, companies, personal domains, and workspaces are logical scopes in
that authority. They are not separate databases until isolation, compliance,
or measured scale requires it.

The user does not manage sessions, tabs, launch commands, or conversation
bindings. Every ordinary message is ingested once with its exact source,
ordering, workspace, surface, and provenance. When a message is spoken, the
audio and transcript are separate immutable source objects linked to the same
message receipt.

A message can also arrive while an explicit artifact and version is open.
That artifact context is first-class routing evidence. A message in the
general stream can infer an artifact, resolve to an existing artifact, or
remain unbound.

## Routing contract

After ingestion, a router records one visible and reversible decision:

- observation or note;
- update an existing intent;
- create, fork, or merge an intent;
- steer an existing agent or launch a new agent;
- request a user decision;
- update an explicit artifact and version.

The routing receipt records its evidence, confidence, target identities, and
the prior routing receipt it supersedes. Correcting a route appends a new
receipt; it never rewrites the original message or erases provenance.

`intent launch` may be accepted as compatibility input, but it is not the
canonical interaction. Ordinary speech and text use the same ingestion path.

## Durable ownership

The existing `intent.*` event stream remains the canonical intent identity and
projection. It owns objective, constraints, decisions, acceptance criteria,
blockers, next action, source revisions, run claims, evidence, artifacts, and
lifecycle. The `message.*` stream owns chronological input and routing
receipts. A message-to-intent link cites both event identities.

An agent claims an intent with an agent identity, run identity, bounded lease,
and expected intent version. It receives a versioned context packet containing
only the objective, prohibitions, decisions, acceptance criteria, blockers,
next action, and current artifact heads, with citations to source events. It
appends progress, evidence, artifact versions, blockers, and next action using
compare-and-append. A stale writer must reload; it cannot silently overwrite.

Agents continue bounded work until the acceptance criteria are met and an
independent evaluator records completion. A reconciler finds active intents
with no current lease, expired leases, missing next actions, or overdue
decisions and schedules bounded advancement. It does not authorize
irreversible external actions.

## API

- `POST /v1/intent-runtime/messages` ingests one ordinary message and records
  its routing receipt.
- `GET /v1/intent-runtime/intents/:id/context-packet` returns a cited,
  versioned continuation packet.
- `POST /v1/intent-runtime/intents/:id/claim` claims a bounded run with CAS.
- `POST /v1/intent-runtime/intents/:id/progress` appends meaningful progress,
  evidence, artifacts, blockers, and next action with CAS.
- `GET /v1/intent-runtime/neglected` returns bounded reconciliation candidates.

Offline clients keep an encrypted outbox of immutable requests and stable
idempotency keys. The outbox is a retry mechanism, not another authority.

## Consolidation

The `intent_plane.intent.*` records introduced by the global-intent branch are
a compatibility and migration surface only. They must not become a second
intent truth. Existing records map into canonical `intent.*` events and retain
their source identities. The Codex local adapter writes to the hosted message
and intent APIs; its local store remains an outbox and read cache.

## Notification policy

Notify only when an intent completes independent evaluation, needs a user
decision, becomes genuinely blocked, violates a lease or deadline, or produces
a material artifact revision. Do not notify for heartbeats or routine internal
steps.

## Acceptance evidence

Completion requires deterministic tests proving:

1. a long ordinary message is preserved exactly and routed once;
2. artifact identity and version survive routing;
3. a fresh runtime continues from a smaller cited packet after restart;
4. mandatory prohibitions cannot disappear without packet validation failing;
5. stale, concurrent, wrongly routed, and conflicting artifact updates fail
   closed;
6. user corrections append and supersede routing instead of rewriting history;
7. a claimed agent can append evidence and a next action;
8. a neglected active intent is surfaced for reconciliation;
9. an independent verifier evaluates the implementation and acceptance tests.
