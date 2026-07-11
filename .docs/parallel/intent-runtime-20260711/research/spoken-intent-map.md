# Spoken intent map: what the user is actually building

Captured and resolved: 2026-07-11. This map separates the user's rapid spoken
statements into bounded product objects. It is a navigation aid, not a claim
that every node belongs in one release.

## Governing objective

The user wants to externalize cognition into a trusted system:

```text
thought or observation
  -> durable intent
  -> project and related intents
  -> enrichment and decision
  -> execution attempts
  -> exact evidence and outcome
  -> concise rehydration
  -> next intent
```

The system must permit many simultaneous intents and cheap context switching.
It should remember the higher-order conclusions, not force the user to search
files or reread raw conversations.

## Bounded nodes

### A. Capture and command surface

**Need:** speak a thought or command from mobile/desktop and make it durable
without an unwanted model response.

**Interaction contract:** release sends; left pauses locally; up parks durably;
down discards; operating-system/browser cancellation always discards. A new-root
gesture creates a clean intent; ordinary capture continues the current one.

**Boundary:** this surface proposes intent and action. It does not own provider
credentials, execute unapproved server proposals, or silently choose history.

### B. Intent authority

**Need:** manage capture, correlation, enrichment, execution, completion, and
return-to-parent across projects.

**Canonical object:** one desired outcome with lifecycle, typed relations,
focus, attempts, blockers, evidence, result, lessons, and next step. Sessions,
chat threads, worktrees, agent runs, tasks, and files are containers or linked
execution evidence—not substitutes for the intent.

**First delivered substrate:** event-sourced intent state, focus push/pop for a
temporary preference command, and bounded project/intent rehydration.

### C. Voice/conversation transaction history

**Need:** own exact admitted input audio, transcript provenance, LLM/tool
exchange, response audio, intent/action/approval/receipt links, and deletion
state.

**Boundary:** this is product history and memory. It is not disposable
observability, and no trace vendor is its authority. A `voice_draft` is
pre-execution user input; an `audio_note` is storage-only; a canonical turn
exists only after explicit SEND.

### D. Pipeline instrumentation and telemetry

**Need:** locate failures and latency across capture, transport, endpointing,
STT, reasoning, tools, TTS, playback, queues, releases, and resources.

**Artifact:** bounded spans, timings, errors, counts, percentiles, and release/
code correlation. Raw audio or transcript content must never become a metric
label. OpenTelemetry is a useful export vocabulary here, not the schema for
nodes B or C.

### E. Agent-produced operations knowledge

**Need:** every morning, learn what newly failed, what keeps recurring, what is
getting worse, what now matters, and the best next action—grounded in code,
deployments, CI, priorities, and prior findings.

**Artifact:** a versioned brief and incident/failure signature with evidence,
confidence, novelty/recurrence, affected intents/releases, proposed repair, and
repair outcome. This is neither a raw dashboard nor an ungrounded summary.

### F. Software-factory executor

**Need:** launch and supervise parallel coding agents in isolated worktrees,
review their diffs, run verification, and manage attention across projects.

**Reference:** Superset is the forgotten local reference; Emdash is its direct
local/YC-backed competitor. Chief Moa should integrate with this category as an
execution adapter. Their workspace/task database does not own Chief Moa intent.

### G. CI execution and optimization

**Need:** understand CI failure/cost/latency, optimize workflows, and produce
reviewable changes without surrendering release authority.

**Reference:** StarSling validates the self-driving CI concept. An optimizer's
PR and measurements are evidence/proposals; the repository verification and
deployment safety gates remain authoritative.

### H. Automatic instrumentation and diagnosis

**Need:** decide what should be logged, add or revise useful instrumentation as
code changes, deduplicate failures, and correlate runtime evidence with code.

**Reference:** Superlog validates this direction. Sazabi is adjacent but its
closed-alpha/integrated-storage posture does not currently meet the maturity and
owned-data preference.

### I. Reusable trace and evaluation plane

**Need:** inspect LLM/tool traces, annotate failures, run evals, and compare
releases without rebuilding commodity trace UI.

**Candidates:** self-hosted Langfuse or Phoenix as optional projections. LiveKit
is the best inspected voice-timeline product reference but its unified Insights
store is cloud-only. Pipecat is the best inspected open voice-pipeline metrics
reference. None becomes canonical voice or intent storage.

### J. General dashboards and infrastructure telemetry

**Need:** query infrastructure logs, metrics, and traces when detailed diagnosis
requires them.

**Candidates:** Grafana/OTel or an existing hosted system. Replacing Datadog or
Grafana is not the initial problem. The differentiator is closing the loop from
owned domain evidence to a prioritized finding and verified action.

## Important edges

```text
A capture surface -> B intent authority
An explicit SEND -> C canonical voice transaction
C transaction -> D derived stage telemetry
B priorities + C history + D signals + code/CI/deploy evidence -> E brief
B intent -> F software-factory execution -> receipts back to B
F code/release -> G CI evidence -> E finding -> proposed repair -> B outcome
D may export -> I trace/eval plane and J infrastructure dashboards
H may propose instrumentation changes -> normal code review/verification -> D
```

No reverse edge grants an adapter authority over intent, raw conversation
history, action approval, or deployment.

## Resolved product decisions

- This is an application the user wants to operate, not a request to start a
  company or build a generic observability vendor.
- Data ownership and inspectable/open boundaries are requirements; hosted
  components may be used only deliberately.
- Specialized domain stores and views are preferable to one universal log
  schema. A shared interface may federate them without collapsing authority.
- The first product wedge is intent + explicit voice-draft/transaction
  authority. Telemetry and the daily brief build on that evidence.
- Superset's most important lesson is operational completeness: migrations,
  isolated previews, releases, rollback, docs, contribution paths, and a
  disciplined upstream-fork lifecycle are part of the product.

## Deferred choices, with crisp boundaries

- Full project/intent UI and command palette: after the canonical read model is
  integrated; it must not invent state locally.
- Langfuse versus Phoenix versus direct OTel only: decide after owned trace
  export exists and can be evaluated with real Chief Moa data.
- Notification channel and schedule for the daily brief: separate preference;
  the brief record should be durable independently of delivery.
- Audio retention, encryption, and backup policy: must be explicit before any
  active promotion that stores sensitive recordings.
- External software-factory and CI adapter: select by an isolated proof using
  non-sensitive test data; no silent handoff of repository or user authority.

## Current Peter run

This run is implementing the minimum coherent foundation across isolated
lanes: canonical intent runtime, durable pre-execution voice drafts, exact
Android/browser gesture and protocol behavior, gateway admission and SEND
integration, independent audits, and preview/release evidence. The broader
nodes above are preserved as explicit adapters and follow-on intents rather
than being lost or collapsed into the current patch.
