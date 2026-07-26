# Operational Intent Authority

## Decision

The Intent Management System is a standalone hosted service with one stable,
agent-neutral API, Postgres authority, and one chronological message stream.
Chief MOA uses that service as a client/integration; it does not own the data
model. The Agent Switchboard, Intent Launcher, CLI, SDK, coding execution
services, and future conversational clients are separate consumers. Local and
remote surfaces write through the same authenticated API.
Projects, companies, personal domains, and workspaces are logical scopes in
that authority. They are not separate databases until isolation, compliance,
or measured scale requires it.

The user does not manage sessions, tabs, launch commands, or conversation
bindings. Every ordinary message is ingested once with its exact source,
ordering, workspace, surface, and provenance. When a message is spoken, the
audio and transcript are separate immutable source objects linked to the same
message receipt.

The product sequence is:

1. The Intent Management System is the canonical authority.
2. Coding execution services consume code-modifying intents, launch fenced
   runs, carry addressed steering, and write progress, evidence, commits, pull
   requests, deployments, and independent evaluation back as Product
   revisions. They are never another source of truth.
3. Chief MOA is the cross-service conversational client.
4. Page- or artifact-affixed mode supplies the current page, repository,
   document, selection, application state, and exact ProductRevision as
   routing context.

The Agent Switchboard is the mandatory front door for every multimodal message
envelope. An envelope may contain speech, text, artifact identity and version,
screen recording, annotations, pointer movement, clicks, and current
page/application/device state. It preserves the raw chronological envelope,
decomposes it, searches intent, agent, and Product state, then records visible
and reversible routing. Independent intents can launch without blocking prior
work.

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

An intent can also be an observation or insight with no immediate external
action. Intent kinds select canonical nurture workflows: increase
informational density, aggressively falsify claims with evidence, extract or
fork durable branches, and return to the core thread. A hidden execution graph
may run many bounded researchers or workers under one user-level intent,
retain candidates, evidence, and rejections, then use an independent
synthesizer to produce a provenance-linked top-K Product. Worker count does
not create additional user-level intents unless genuinely independent goals
emerge.

## Product model

Product is the durable semantic object. Product identity is separate from an
immutable ProductRevision, content hash, blob or external reference, format,
MIME type, schema, processor, storage location, destination/publication
policy, and provenance. An intent consumes zero or more input revisions and
produces zero or more output revisions.

The text MVP supports:

- documents, notes, and essays;
- short messages and posts, where draft revision, channel policy, publish
  action, and external publication receipt are separate;
- code repositories, where an exact commit/tree is the revision and GitHub is
  an integration with Git-specific diff, branch, PR, test, and deploy
  semantics.

External Products may remain referenced rather than copied. The storage
boundary to evaluate is Postgres for owner-scoped intent/Product/revision and
provenance metadata plus CAS, Git for code and appropriate text, object
storage for bytes, and a derived search index. Audio and video remain future
Product types behind a processor registry and content-addressed revision
contract.

## Scheduling and attention

Recurring routines are scheduled intents over the same plane: morning brief,
nightly evidence-based achieved-versus-planned review and tomorrow plan,
weekly project review, and monthly/yearly/five-year/ten-year planning and
retrospective phases. A routine records schedule, timezone, input query,
template/output Product, attention policy, last/next run, missed-run/backfill
policy, and versioned results. A nightly review never invents achievement.

Work queues and attention queues are distinct. A durable Attention Inbox
contains decisions, blockers, independently evaluated completions, and review
items. An attention broker uses importance, urgency, decision need,
confidence, evidence threshold, user cadence, budget, and digest policy to
choose interruption, scheduled review, or on-demand presentation. The same
conversational surface presents selected items, while Switchboard routing,
Inbox state, and announcement remain separate responsibilities. Operational
logs remain inspectable but are not pushed.

Skills turn repeatable manual workflows into provider-agnostic Product
mechanisms and manage agents to evidenced completion. A compatibility
distribution such as Vercel skills may be used without owning the
architecture. The browser is one execution capability, not the product
center.

## MVP trust boundary

The first hosted authority has exactly one server-derived authenticated owner.
Caller-supplied owner or cross-owner workspace claims are rejected. Workspace,
project, company, and sphere are routing metadata inside that owner boundary,
not authorization boundaries. Multi-user tenancy is explicitly deferred.

## API

The `/v1/intent-runtime` paths below are the current compatibility mount for
the standalone service contract. Clients depend on request/response schemas
and opaque identities, not gateway internals. Moving the mount into its own
process must not change Product, intent, claim, fencing, message, or attention
semantics.

- `POST /v1/intent-runtime/messages` ingests one ordinary message and records
  its routing receipt.
- `GET /v1/intent-runtime/intents/:id/context-packet` returns a cited,
  versioned continuation packet.
- `POST /v1/intent-runtime/intents/:id/claim` claims a bounded run with CAS.
- `POST /v1/intent-runtime/intents/:id/progress` appends meaningful progress,
  evidence, artifacts, blockers, and next action with CAS.
- `GET /v1/intent-runtime/neglected` returns bounded reconciliation candidates.
- `POST /v1/intent-runtime/products` creates an owner-scoped Product.
- `POST /v1/intent-runtime/products/:id/revisions` appends an immutable
  ProductRevision and updates its head with CAS.
- `POST /v1/intent-runtime/intents/:id/products` links an exact input or output
  ProductRevision.
- `POST /v1/intent-runtime/intents/:id/attention` appends a deduplicated
  attention item.

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
10. exclusive claims reject live competitors, expired recovery uses explicit
    authority and a new fencing token, and stale workers cannot write;
11. document and Git commit revisions retain immutable history and CAS heads;
12. one intent can cite multiple outputs and externally referenced Products;
13. forged or truncated continuation packets fail signature and derived
    completeness checks;
14. evidence-based completion creates a separate attention item.

## Preserved clarification provenance

This revision incorporates the user’s canonical clarification delivered to
the implementation owner on 2026-07-26: Intent is supreme; the Switchboard is
the mandatory multimodal front door; agents are configured per intent and
progress concurrently; attention is brokered rather than manually managed;
scheduled reviews produce evidence-based Product revisions; skills are
provider-agnostic; and browser reliability repair is a separate later intent,
not part of this implementation.
