# Open-source intent control-plane landscape

Date: 2026-07-25

## Decision

No existing product is the complete system.

The closest low-friction foundation is **Hatchet**. Adopt or fork its
self-hosted control plane for durable execution, scheduling, retries, remote
workers, run history, logs, and operational UI. Keep Chief MOA's intent,
agent, context, artifact, and user-facing semantics as a thin domain layer
above it.

Run a short proof of concept before committing:

1. Host Hatchet Lite locally, then its PostgreSQL Docker Compose deployment.
2. Register one local Codex adapter and one remote worker.
3. Model one intent reconciler as a scheduled durable workflow.
4. Pause a run for user input using a durable event wait.
5. Kill a worker mid-run and demonstrate recovery without duplicating the
   agent launch.
6. Link the Hatchet run to the existing Chief MOA intent and agent records.

Use **Gitea or ordinary Git repositories** for versioned text artifacts. Do
not put artifact contents or conversational memory into workflow history.

Consider **Temporal** instead if the proof of concept exposes a durability,
scale, or worker-versioning limitation that matters now. It is the strongest
execution substrate, but has more operational and programming-model cost.

Do not replace the Chief MOA domain with Letta, LangGraph, Mem0, Kestra, or
Dapr Agents. They can supply patterns or optional adapters, but each imposes
the wrong central abstraction.

## What must remain Chief MOA's domain

None of the candidates supplies all of these first-class records and
relationships:

- intent: desired outcome, state, priority, constraints, acceptance criteria,
  recap, next action, project/namespace, and supersession/fork links;
- launch specification: role/system prompt, model/provider, capabilities,
  tools, credentials policy, workspace, resource budget, and policy version;
- agent identity: stable ID independent of a process or chat session, current
  lease, heartbeat, owner, status, and recovery policy;
- provenance: human or agent launcher, ancestry as metadata, routed messages,
  decisions, approvals, and artifact mutations;
- context packs: selected source references, recap, unresolved questions,
  token budget, selection rationale, and the exact context actually sent;
- artifacts: typed logical identity, current version, immutable revisions,
  content-addressed blobs or Git commits, producer, intent, citations, and
  review state;
- full telemetry separate from compact operational state;
- a single cross-device inbox, search surface, and explanation of why a
  message was routed to an existing agent or a new one;
- a reconciler that enforces "every actionable intent has exactly one viable
  owner or an explicit blocked/paused reason."

The workflow engine should own execution state. Chief MOA should own meaning.
Store stable cross-references in both directions:

`intent_id -> agent_id -> execution_id -> artifact_revision_id`.

## Ranked candidates

### 1. Hatchet — adopt/fork as the execution substrate

**Fit:** highest. **Modification friction:** low to medium.

- License: MIT, verified in the repository
  [LICENSE](https://github.com/hatchet-dev/hatchet/blob/main/LICENSE).
- Hosting: fully self-hosted control plane. The documented deployment contains
  a REST API, gRPC engine, PostgreSQL, optional RabbitMQ, and dashboard.
  Workers connect to that control plane. Supported paths are one-command
  Hatchet Lite, Docker Compose, and Helm
  ([self-hosting guide](https://docs.hatchet.run/self-hosting)).
- Maintenance: active; the repository showed current releases in 2026 at the
  time of review
  ([repository](https://github.com/hatchet-dev/hatchet),
  [releases](https://github.com/hatchet-dev/hatchet/releases)).
- Durable primitives: durable queue, task and workflow run history, retries,
  timeouts, cancellations, scheduling/cron, concurrency and rate limits,
  child spawning, sleeps, event waits, task eviction, DAGs, streaming, worker
  affinity, logs, OpenTelemetry, Prometheus, and metadata. The project
  explicitly persists execution history and exposes it in the dashboard
  ([README](https://github.com/hatchet-dev/hatchet)).
- Local and remote work: workers are independent processes that connect to the
  hosted control plane. Python, TypeScript, Go, and Ruby SDKs are documented.
- Human interaction seam: a durable task can wait for an externally supplied
  event. Chief MOA must provide the approval/inbox semantics and UI
  ([events and event waits](https://docs.hatchet.run/v1/events)).
- Missing: intent semantics, a persistent agent registry, model/tool launch
  manifests, compact context selection, cross-session agent messaging,
  artifact identity/versioning, and a user-facing intent inbox.
- Integration seam: a Chief MOA reconciler workflow starts or resumes an
  adapter task. Hatchet's run ID is stored on the Chief MOA agent lease. The
  adapter reports heartbeats, transcript events, context-pack hashes, artifact
  revisions, and completion back to Chief MOA.

Why it ranks first: it supplies most of the expensive, failure-prone runtime
machinery while remaining one PostgreSQL-centered, permissively licensed
control plane. It does not require Chief MOA to become a Python-only agent
framework.

### 2. Temporal — build on if maximal durability outweighs complexity

**Fit:** high for execution, low for product semantics. **Modification
friction:** medium to high.

- License: MIT
  ([server LICENSE](https://github.com/temporalio/temporal/blob/main/LICENSE)).
- Hosting: self-hosted server and database, with official local CLI, Docker
  samples, and Helm charts
  ([server repository](https://github.com/temporalio/temporal),
  [server samples](https://github.com/temporalio/samples-server),
  [Helm chart](https://github.com/temporalio/helm-charts)).
- Maintenance: mature and active; v1.31.2 was the latest server release shown
  on 2026-07-08 during review
  ([releases](https://github.com/temporalio/temporal/releases)).
- Durable primitives: event-sourced workflow history, deterministic replay,
  timers, retries, signals, queries, updates, child workflows, schedules,
  task queues, visibility, and worker versioning. User code runs in
  user-controlled worker processes
  ([architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md)).
- Local and remote work: workers poll named task queues over the service API;
  supported SDKs include TypeScript, Python, Go, Java, and .NET.
- Human interaction seam: signals/updates can suspend and resume durable
  workflows. Chief MOA still needs the approval model and UI.
- Missing: the entire intent/agent/artifact/context product model. Workflow
  history retention is not a durable knowledge repository.
- Integration seam: one long-lived workflow per intent, or one reconciler
  workflow plus child workflow per agent lease. Activities invoke external
  agent adapters. Search attributes hold only indexable references.

Temporal has the strongest recovery semantics and the most mature execution
history, but adopting its deterministic workflow model creates more code and
operational surface than the first Chief MOA slice appears to need.

### 3. Dapr Agents — borrow patterns; do not make it the global plane yet

**Fit:** high agent-runtime feature match. **Modification friction:** high for
the existing heterogeneous system.

- License: Apache-2.0
  ([repository](https://github.com/dapr/dapr-agents)).
- Hosting: Dapr runs as a self-hosted binary, containers, or Kubernetes and
  supports pluggable state stores and pub/sub
  ([Dapr repository](https://github.com/dapr/dapr)).
- Maintenance: Dapr Agents v1.0 is documented as GA; v1.0.3 was released
  2026-05-19
  ([releases](https://github.com/dapr/dapr-agents/releases)).
- Durable primitives: `DurableAgent` stores LLM calls and tool executions as
  workflow activities; Dapr Workflow provides recovery, HTTP/gRPC management,
  events, state, service invocation, pub/sub, tracing, and long waits
  ([agent patterns](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-patterns/),
  [workflow overview](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/)).
- Human interaction: v1.0.3 added human-in-the-loop hooks; approval waits
  rehydrate through the workflow.
- Cross-service agents: agent tools can target another Dapr app and can name
  non-Dapr frameworks
  ([core concepts](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-core-concepts/)).
- Missing: global intent registry, artifact graph, context compaction policy,
  complete session telemetry product, and the desired launcher UX.
- Integration seam: useful reference implementation for durable agent calls,
  approval hooks, configuration hot reload, and cross-app routing.

It is the closest *agent framework*, but adopting it centrally would pull the
system toward Dapr sidecars, Python agent definitions, and Dapr's application
model. Chief MOA needs to persist and supervise Codex, Claude, Hermes, local
processes, and future runtimes without forcing them to become Dapr agents.

### 4. Letta — optional persistent-agent/memory adapter

**Fit:** medium. **Modification friction:** medium.

- License: Apache-2.0
  ([LICENSE](https://github.com/letta-ai/letta/blob/main/LICENSE)).
- Hosting: a Docker server persists its PostgreSQL data volume and exposes a
  REST API on port 8283; it can use an external PostgreSQL/pgvector database
  and a local Git-backed memory filesystem
  ([self-hosting guide](https://docs.letta.com/v1-sdk/docker)).
- Maintenance: v0.16.8 was the current release observed during review
  ([releases](https://github.com/letta-ai/letta/releases)).
- Useful primitives: stable stateful agents, model configuration, tools,
  message history, memory blocks, archival retrieval, REST clients, and
  Git-backed memory.
- Missing: deterministic workflow recovery, task ownership reconciliation,
  generic remote worker supervision, intent/project planning, ancestry across
  arbitrary runtimes, and artifact review/version semantics.
- Integration seam: wrap a Letta agent as one possible Chief MOA runtime. It
  should not own the global identity or intent record.

Letta is valuable evidence that agent state, behavior, and memory can live
behind a self-hosted API. It is not the missing orchestration plane.

### 5. LangGraph OSS — embed only inside a specialized adapter

**Fit:** medium as a library. **Modification friction:** low locally, high if
stretched into a multi-runtime control plane.

- License: MIT
  ([LICENSE](https://github.com/langchain-ai/langgraph/blob/main/LICENSE)).
- Persistence: checkpoints per graph step, thread state/history, pending
  writes, replay/fork, human interrupts, and fault recovery
  ([persistence](https://docs.langchain.com/oss/python/langgraph/persistence),
  [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)).
- Important boundary: the OSS graph/checkpointer library is not itself the
  hosted global agent registry and product surface. Do not assume the vendor's
  Agent Server or LangSmith is part of the permissively licensed substrate.
- Missing: heterogeneous worker control, global intent reconciliation,
  deployment supervision, artifacts, user-facing inbox, and cross-framework
  identity.

Use it only when an individual Chief MOA execution agent benefits from an
explicit graph. Do not make every user intent a LangGraph thread.

### 6. Kestra — viable operations-oriented alternative, not the agent plane

**Fit:** medium-low. **Modification friction:** medium.

- License: Apache-2.0
  ([repository](https://github.com/kestra-io/kestra)).
- Hosting and maintenance: a one-container local server and broader
  Docker/Kubernetes deployment options are documented; v1.3.20 was shown as
  current on 2026-05-26.
- Useful primitives: namespaces, labels, schedules, events, retries,
  timeouts, subflows, remote task runners, logs, artifacts, a strong UI, and
  Git-compatible YAML workflow definitions.
- Missing: persistent agent identity, dynamic model/tool manifests, compact
  conversational context, arbitrary ongoing agent messaging, and intent
  semantics.

Kestra is strongest when the future workload becomes declarative automation
and data pipelines. It is less natural for dynamic, conversational,
long-running agent ownership than Hatchet or Temporal.

## Components, not control planes

### Git/Gitea for text artifacts

Gitea is MIT-licensed, self-hosted, and provides Git hosting, review, issues,
projects, wiki, packages, and CI/CD
([repository](https://github.com/go-gitea/gitea)). It can host artifact
repositories and review surfaces, but Chief MOA must maintain logical artifact
identity across repositories and non-text blobs.

Initial artifact rule:

- keep metadata and immutable content hashes in PostgreSQL;
- keep text revisions in Git commits;
- keep audio/video/blob payloads in S3-compatible object storage;
- link each revision to the producing run, agent, intent, source evidence, and
  approval state.

### Mem0 for optional semantic recall

Mem0 is Apache-2.0 and now documents a self-hosted server with auth, API keys,
dashboard, and `docker compose`
([repository](https://github.com/mem0ai/mem0)). It is a recall/index layer,
not an authoritative intent, transcript, or artifact store. Its official MCP
repository was archived in 2026 in favor of a hosted MCP endpoint
([archived MCP repository](https://github.com/mem0ai/mem0-mcp)); therefore,
do not depend on that connector. Add semantic memory only after the
authoritative records and deterministic context-pack builder exist.

## Explicit rejects

- **Inngest server:** operationally attractive, but the server and CLI use
  SSPL plus delayed Apache publication rather than a currently permissive
  open-source license. This violates the requirement to freely fork and
  operate without license ambiguity
  ([repository and license statement](https://github.com/inngest/inngest)).
- **Vendor-hosted agent control planes:** reject any option whose durable
  server, observability, or UI requires a vendor account or proprietary
  service, even when its client SDK is open.
- **Issue trackers as the source of truth:** issues approximate intent, but do
  not represent leases, heartbeats, context packs, model/tool manifests,
  execution recovery, or session telemetry.
- **Memory databases as the source of truth:** retrieval quality is
  probabilistic. Intent ownership, approvals, launch identity, and artifact
  provenance must remain deterministic records.

## Minimal adopted architecture

```text
Mac / browser / phone / API
              |
        Chief MOA API
              |
  PostgreSQL intent domain + event outbox
       |             |              |
  Hatchet API    Git/Gitea      Object storage
       |
  scheduled intent reconciler
       |
  task queues selected by runtime/capability/location
       |
 Codex | Claude | Hermes | Letta | custom local/remote adapters
```

The first database should use logical `workspace_id`, `project_id`, and
`security_domain_id` fields rather than physical database-per-project
partitioning. Preserve an event/outbox stream and opaque stable IDs so a
future security domain can be moved to another database without changing
agent or artifact identity. Split databases only for a demonstrated isolation,
residency, ownership, reliability, or scale requirement.

## Two-hour proof-of-concept acceptance test

The proof is complete only if it demonstrates:

- one hosted plane and one user-facing API;
- local and remote workers visible in the same run inventory;
- an intent record with a launch specification, assigned stable agent ID, and
  external execution ID;
- lease/heartbeat expiration followed by deterministic restart;
- idempotent launch: crash recovery does not create a duplicate live agent;
- full append-only run events plus a separately updated compact recap;
- a context pack that cites selected prior event/artifact IDs rather than
  copying the full session;
- durable wait for user input and subsequent resume;
- one versioned text artifact linked to its producing execution;
- ancestry/provenance stored as queryable metadata, not access hierarchy;
- a completion notification and an explanation of what ran, why, and what
  changed.

## Uncertainty

This review reflects repositories and documentation available on 2026-07-25.
Fast-moving projects may change licensing, deployment boundaries, or feature
availability. Pin exact versions and retain a copy of every dependency license
before adoption. In particular, verify that every dashboard/API feature used
by the Hatchet proof of concept exists in the MIT-licensed self-hosted build,
not only Hatchet Cloud.
