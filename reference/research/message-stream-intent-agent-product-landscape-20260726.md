# Message-stream intent and durable-agent product landscape

Date: 2026-07-26

This is the corrected product search. It asks whether an existing,
modifiable, self-hosted product already implements this user experience:

1. The user writes or speaks into one chronological stream.
2. The system decides whether each message continues, steers, forks, or
   creates an intent.
3. It routes the message to an existing durable agent or launches a new one.
4. The user does not manage tabs, projects, sessions, or context windows.
5. Agents persist progress, provenance, recaps, and artifacts.
6. An artifact-affixed invocation makes a current document, code revision, or
   media artifact explicit context.
7. Work is evaluated against the intent before it is declared complete.

## Finding

**No reviewed product implements the complete model.**

The strongest product foundation is now **Block's Buzz**, released under
Apache-2.0. It is unusually close to the desired *shared substrate*: one
self-hosted relay, one identity system for humans and agents, one signed event
log, chat, agent jobs, workflow traces, approvals, canvases, media, Git repos,
search, ACP adapters for Codex/Claude Code/goose, MCP, and an agent-first CLI.

Buzz still does **not** implement the defining Chief MOA behavior:

- no semantic router that turns every inbound message into
  continue/new/fork/steer decisions;
- no first-class intent object with acceptance criteria and lifecycle;
- no durable agent lease or persistent ACP session (the ACP harness explicitly
  does not persist state);
- no artifact-general current-version context contract;
- no completion evaluator tied to the user's intent;
- its approval executor is not yet durable end to end.

Therefore the recommended direction is:

> **Fork or embed Buzz as the event, identity, collaboration, artifact, and
> agent-communication plane; add Chief MOA's intent router, durable-agent
> registry, context-pack builder, reconciler, and completion evaluator.**

Use **OpenClaw** as a reference or adapter for cross-service intake and
session delivery, **Entire CLI** as the reference implementation for
artifact-affixed code provenance, and **Hatchet or Temporal** behind Buzz for
durable execution until Buzz's workflow engine is demonstrably sufficient.

This is a materially better adoption path than building the entire surface
from a generic workflow engine.

## Exact-fit comparison

Legend: **yes** means implemented in the open-source product; **partial**
means a meaningful primitive exists but not the requested behavior.

| Product | Universal intake | Semantic intent routing | Durable agents | Direct steering | Artifacts + versions | Provenance | Durable recovery | Completion evaluation | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| Buzz | Partial: one event log, several channel/feed lenses | No | Partial: identities/jobs, non-persistent ACP harness | Yes, through channel messages and mentions | Partial: canvases, media, Git; branches become channels | Strong signed events + hash-chain audit | Partial; agent respawn, weak workflow durability | No | **Fork/adopt foundation** |
| OpenClaw | Strong cross-service message gateway | Deterministic bindings, not semantic intent routing | Partial; named agents and sessions, spawned subagents have durability gaps | Yes through the same channels | Weak: workspace files/canvas, no general artifact revision model | Session JSONL and logs, weaker artifact linkage | Partial: gateway supervision, cron, respawn patterns | No | **Component/reference** |
| Entire CLI | No | No | Captures sessions; does not supervise agents | Session resume only | **Strong for Git/code** | **Strong for code sessions** | Checkpoints and rewind, not task recovery | No | **Adopt component** |
| Memoh | Strong multi-channel intake | Routes to configured bots/sessions, not intents | Partial: persistent bots, isolated containers, subagents | Yes | Container filesystem snapshots, not logical artifact model | Partial | Cron/heartbeat and container lifecycle, not durable workflow proof | No | **Study/optional fork** |
| Khoj | Several capture surfaces | No | Persistent configured agents and automations | Chat continuation | Knowledge sources, not artifact lifecycle | Weak | Scheduled automation, not durable execution history | No | **Component/reject as core** |
| Hatchet | Event/API intake only | No | External workers/tasks, not agent identities | Events can resume work | Run outputs only | Strong execution history | **Strong** | Procedural success only | **Execution component** |
| Temporal | API/signal intake only | No | Workflow identity, not user-facing agents | Signals/updates | Payload references only | **Strong event history** | **Strongest** | Procedural success only | **Execution fallback** |

## 1. Buzz — closest product; fork/adopt

Repository: [block/buzz](https://github.com/block/buzz)  
License: [Apache-2.0](https://github.com/block/buzz/blob/main/LICENSE)  
Maintenance: active; Desktop v0.4.26 was released 2026-07-25
([releases](https://github.com/block/buzz/releases)).

### What is actually open source

The repository contains the Rust relay, PostgreSQL event store, Redis
pub/sub, search, hash-chain audit, workflow engine, Tauri desktop client,
browser repo surface, Git hosting, media service, ACP harness, MCP server,
agent CLI, personas, and deployment configuration. The documented
self-hosting path builds from source; a production Compose bundle uses
PostgreSQL, Redis, MinIO, and optional Caddy/TLS
([README](https://github.com/block/buzz)).

The open-source deployment is not merely a client for Block's service. Buzz
documents independently operated relays, and the relay URL is authoritative
for the workspace.

### Implemented fractions of the requested model

- **One substrate:** every message, reaction, workflow step, review approval,
  and Git event is a signed event in one log. Humans and agents use the same
  identity model and search index
  ([vision](https://github.com/block/buzz/blob/main/VISION.md)).
- **Several lenses over the substrate:** Home, Stream, Forum, DMs, Agents,
  Workflows, and Search. This is not yet the requested one linear intake UI,
  but the event model can support it.
- **Agents as first-class members:** cryptographic identities, profiles,
  channel memberships, jobs, DMs, presence, and permissions.
- **Existing agent integration:** `buzz-acp` launches 1–32 subprocesses and
  bridges relay mentions to ACP-compatible goose, Codex, and Claude Code.
  Messages queue per channel and are batched into a prompt. Agent crashes are
  detected and respawned.
- **Direct steering:** another channel message or mention enters the same
  per-channel queue instead of requiring the user to locate a hidden agent
  session.
- **Artifacts:** shared channel canvases; S3/MinIO-backed media; Git smart
  HTTP. Buzz's forge design makes branches into channels, so code, review,
  CI, discussion, and merge provenance share a workspace.
- **Provenance:** signed Nostr events, persistent workflow run traces,
  hash-chain audit, author identities, Git events, and soft-deletion audit.
- **Programmability:** REST, WebSocket/Nostr, MCP, `buzz-cli` JSON I/O, and
  typed event builders.
- **Automation:** message/reaction/schedule/webhook triggers, conditions,
  workflow run records, delays, and approval schema/UI/API.

### Critical gaps verified in Buzz's own architecture document

- `buzz-acp` **does not persist state**. It respawns crashed subprocesses but
  does not rehydrate a durable agent session
  ([architecture, buzz-acp](https://github.com/block/buzz/blob/main/ARCHITECTURE.md#buzz-acp--agent-communication-protocol-harness)).
- The bundled `buzz-agent` has concurrent sessions and summarizes history
  when context fills, but sessions are process-level ACP sessions, not
  globally durable intent owners
  ([agent vision](https://github.com/block/buzz/blob/main/VISION_AGENT.md)).
- Workflow approvals are only partially built. The executor does not persist
  the approval token or resume the run; an approval step currently fails the
  run.
- Workflow triggers and audit/search processing are spawned after event
  insertion; workflow trigger failure does not fail message submission.
  Chief MOA needs a transactional outbox/reconciler so no accepted intent is
  silently lost.
- Capacity overflow returns immediately rather than durably queuing workflow
  runs.
- The product uses channels and jobs, not semantic intents. Users still decide
  where a message goes.
- Canvases are shared documents, but the reviewed design does not expose the
  required logical artifact/revision/context contract for arbitrary text,
  audio, video, and generated outputs.

### Exact Chief MOA integration seam

Add new signed event kinds and projections rather than creating a parallel
chat database:

- `intent.declared`
- `intent.recap.updated`
- `intent.forked`
- `message.routed`
- `agent.launch.requested`
- `agent.registered`
- `agent.lease.renewed`
- `agent.progressed`
- `context.pack.created`
- `artifact.registered`
- `artifact.revision.created`
- `evaluation.requested`
- `evaluation.completed`
- `intent.completed`

Build one Chief MOA launcher/router member that subscribes to the universal
intake stream. For each inbound user message it emits a routing decision with
confidence and evidence:

`continue(intent, agent) | steer(agent) | fork(intent) | create(intent) |
capture_only | answer_inline`.

The relay remains the chronological source and direct interaction surface.
PostgreSQL projections provide current intent/agent/artifact state. A durable
execution engine consumes `agent.launch.requested`, while the resulting agent
joins Buzz with its own key and communicates directly in the same stream.

## 2. OpenClaw — adopt its intake/routing patterns, not its session ontology

Repository: [openclaw/openclaw](https://github.com/openclaw/openclaw)  
License: [MIT](https://github.com/openclaw/openclaw/blob/main/LICENSE)  
Maintenance: extremely active, with current 2026 releases
([releases](https://github.com/openclaw/openclaw/releases)).

### Relevant open-source behavior

OpenClaw is a self-hosted gateway and agent runtime for WhatsApp, Telegram,
Slack, Discord, Signal, iMessage, Matrix, Teams, Nostr, WebChat, and many
other channels. It includes macOS, iOS, Android, and web surfaces; model
routing; workspaces; memory; skills; cron; webhooks; sessions; spawned
subagents; and remote nodes.

Its inbound pipeline is directly relevant:

`message -> bindings/routing -> session key -> dedupe/debounce -> queue ->
agent run -> reply`

([message lifecycle](https://docs.openclaw.ai/concepts/messages)).

Multiple devices and channels can map to the same session. The gateway offers
`sessions_list`, `sessions_history`, and `sessions_send`. Transcripts persist
as JSONL under each agent's session directory, and context compaction and
memory files are built in
([session management](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md),
[memory](https://docs.openclaw.ai/concepts/memory)).

### Why it is not the product

- Routing is configured through channel/account/peer bindings. It does not
  infer whether a thought continues, creates, or forks an intent.
- The session remains the primary container. That is exactly what the user
  wants the system to manage invisibly.
- Persistent named spawned-agent sessions have been an explicit open feature
  request, so one cannot claim subagents are already durable first-class
  entities
  ([issue #19780](https://github.com/openclaw/openclaw/issues/19780)).
- It lacks a unified logical artifact/revision/provenance model and
  intent-bound completion evaluation.

### Integration seam

Either connect OpenClaw channels to Buzz through Nostr/webhooks, or reuse its
channel adapters behind Chief MOA's universal intake API. Replace
session-selection policy with the intent router. Store the returned
`intent_id`, `agent_id`, and `routing_decision_id` alongside the channel
message ID. Do not expose OpenClaw session keys as the user's organizational
model.

## 3. Entire CLI — adopt for code artifact provenance

Repository: [entireio/cli](https://github.com/entireio/cli)  
License: [MIT](https://github.com/entireio/cli/blob/main/LICENSE)  
Maintenance: active 2026 repository and releases.

Entire hooks into Codex, Claude Code, Gemini, Cursor, OpenCode, Copilot CLI,
and other coding agents. It captures full transcripts, prompts, tool calls,
token use, diffs, and attribution. Each checkpoint links the working state
and agent session to Git. Temporary checkpoints live on shadow branches;
committed checkpoints live on `entire/checkpoints/v1`. Sessions can be
rewound or resumed
([CLI repository](https://github.com/entireio/cli),
[overview](https://docs.entire.io/overview)).

This is the best concrete implementation reviewed of the
**artifact-affixed invocation**:

- the artifact is a Git repository/branch/commit;
- the exact code version and diff are known;
- the producing session is captured;
- provenance moves with Git;
- another supported agent can resume from the checkpoint;
- nested subagent checkpoints preserve launch ancestry
  ([technical description](https://entire.io/blog/the-entire-cli-how-it-works-and-where-its-headed)).

### Boundary

The CLI is genuinely open source. Do not assume the Entire.io hosted web
service or distributed Git network is self-hostable merely because the CLI
is. The desired integration should use the local CLI/checkpoint format and
ordinary self-hosted Git.

### Integration seam

For `artifact_type=code`, make the Chief MOA artifact revision reference:

- repository and branch;
- Git commit/tree;
- Entire checkpoint ID;
- agent session/run ID;
- prompt and context-pack hashes;
- parent checkpoint;
- evaluation results.

Generalize the same logical contract to documents and media without forcing
their bytes into Git.

## 4. Memoh — promising all-in-one reference, too young and not intent-based

Repository: [memohai/Memoh](https://github.com/memohai/Memoh)  
License: [AGPL-3.0](https://github.com/memohai/Memoh/blob/main/LICENSE)  
Maintenance: active; v0.16.0 was current during review
([releases](https://github.com/memohai/Memoh/releases)).

Memoh contains a meaningful fraction of the operational system:

- multi-user, multi-bot persistent agents;
- many chat and email channels plus a web UI;
- one PostgreSQL server and REST API;
- a dedicated container, filesystem, network, and tools per bot;
- snapshots, data export/import, and versioning;
- model and MCP configuration per bot;
- chat, discuss, schedule, heartbeat, and subagent sessions;
- automatic memory extraction, retrieval, and context compaction;
- cron and periodic heartbeat;
- session inspection and tool-call visualization.

This makes it a better implementation reference than a generic chatbot or
memory library. It still routes conversations to configured bots and sessions,
not autonomously maintained intents. Filesystem snapshots are not a logical
artifact lifecycle, and the public claims reviewed do not establish
event-sourced recovery, exactly-once launch, full provenance, or
intent-specific completion evaluation.

Disposition: run a code-level spike only if its container and bot registry
could be reused independently. Its AGPL license permits modification and
self-hosting but carries network-copyleft obligations for a modified hosted
service.

## 5. Khoj — useful personal-knowledge surface, not an intent plane

Repository: [khoj-ai/khoj](https://github.com/khoj-ai/khoj)  
License: [AGPL-3.0](https://github.com/khoj-ai/khoj/blob/master/LICENSE)  
Maintenance: active 2.0 beta releases during review
([releases](https://github.com/khoj-ai/khoj/releases)).

Khoj is self-hosted and reaches browser, desktop, phone, WhatsApp, Obsidian,
and Emacs. It supports custom agents with knowledge/persona/model/tools,
scheduled automations, notifications, semantic search, speech, documents,
and local or hosted models.

Its value is the personal capture/retrieval and automation UX. It does not
maintain first-class intents, route every thought among existing/new/forked
agents, supervise arbitrary external agent runtimes, version artifacts, or
evaluate completion. Use patterns or adapters only.

## 6. Hatchet and Temporal — execution components, not the user product

The prior durable-execution review remains valid:

- Hatchet is MIT, self-hostable with PostgreSQL, and provides queues,
  scheduling, retries, durable waits, child runs, remote workers, run history,
  logs, OpenTelemetry, and a dashboard
  ([repository](https://github.com/hatchet-dev/hatchet),
  [self-hosting](https://docs.hatchet.run/self-hosting)).
- Temporal is MIT, self-hostable, event-sourced, and supplies the strongest
  replay/recovery, signals, updates, timers, worker task queues, and versioning
  ([repository](https://github.com/temporalio/temporal),
  [architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md)).

Neither provides the desired chronological interface, semantic intent
routing, agent/product ontology, artifact context, or completion semantics.

With Buzz in view, these should sit **behind** the product, not define it.
Start with Hatchet for lower integration friction. Select Temporal only if
tests demonstrate Hatchet cannot meet recovery or long-lived versioning
requirements.

## Products rejected as the core

- **Chat/workspace products without semantic intent routing:** Open WebUI,
  LibreChat, AnythingLLM, Mattermost, and Matrix preserve conversations but
  leave users managing channels/workspaces/sessions.
- **Agent frameworks:** LangGraph, CrewAI, AutoGen, and Dapr Agents help an
  implementer construct executions. They are not the one-stream product and
  do not supply the requested intent/artifact ontology.
- **Memory systems:** Letta, Mem0, and Acontext can retain agent state,
  memories, or skills. Memory retrieval cannot be authoritative for intent
  ownership, launch identity, approvals, or artifact provenance.
- **Task/issue products:** Plane, Huly, and similar systems expose projects
  and issues the user must manually maintain. They do not eliminate session
  and project management.
- **Proprietary/cloud-only agent workspaces:** reject when the relevant server,
  orchestration, observability, or collaboration surface is absent from the
  licensed repository.

## Required Chief MOA layer

Even after adopting Buzz, Chief MOA needs five small but decisive services.

### 1. Universal intake projection

Every accepted human voice/text message gets a stable event ID, timestamp,
source, raw media/transcript references, identity, and optional explicit
artifact binding. The UI presents one personal chronological stream even
though the relay may also expose channels and projects as secondary views.

### 2. Ephemeral semantic router

The router receives:

- the new message;
- a compact inventory of active intents and agents;
- recent routing decisions;
- explicit surface/artifact context;
- candidate intents retrieved by metadata and semantic search.

It emits a structured, auditable decision. The router itself is not the
persistent conversational owner.

### 3. Durable intent and agent projections

An intent records outcome, acceptance criteria, recap, state, priority,
relationships, owner, current artifact bindings, and open questions.

An agent records immutable launch specification, capabilities, runtime,
stable identity, lease, heartbeat, progress recap, current execution, and
completion/blocker state. Launch ancestry is provenance, not a navigation
hierarchy.

### 4. Artifact context contract

Each invocation can bind zero or more explicit artifact revisions:

`artifact_id, revision_id, media_type, storage_uri, content_hash,
parent_revision_id, producer_agent_id, producing_execution_id,
selection_reason`.

The "current artifact" is a projection, not mutable anonymous content.

### 5. Completion evaluator

Runtime success is not intent completion. After an agent claims completion,
an evaluator receives the original outcome, acceptance criteria, produced
artifact revisions, tests/evidence, and unresolved risks. It emits
`accepted | needs_revision | blocked | requires_human`.

## Recommended proof before choosing the fork

Run a bounded Buzz spike and reject it if any of these fail:

1. Self-host the unmodified production Compose stack without a Block account.
2. Connect one Codex process and one different ACP-compatible agent.
3. Post all user thoughts into one designated intake stream.
4. Add a prototype router subscriber that emits signed routing events.
5. Route one message to an active agent, fork another intent, and launch a
   third agent without the user selecting a channel.
6. Kill and restart the launcher, relay, and agent process independently.
7. Prove no accepted message or launch request is lost or duplicated.
8. Attach a Git/Entire checkpoint and one audio artifact revision to intents.
9. Continue both agents by speaking only into the intake stream.
10. Render progress and completion back into the same chronology.

If Buzz passes, fork/adopt. If its event model or relay architecture makes
durable routing unsafe, retain its client/ACP ideas and use Chief MOA's
PostgreSQL intent plane with Hatchet.

## Source and version caveat

This report reflects primary repositories and documentation reviewed on
2026-07-26. Buzz is new and moving unusually quickly. Its vision documents are
explicit about what is complete and incomplete, but every claimed integration
must still be exercised against a pinned commit. Archive license files and
pin dependencies before adoption. This report recommends a technical spike,
not architectural approval.
