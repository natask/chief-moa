## ADDED Requirements

### Requirement: Threads are branches inside the shared session
The gateway SHALL treat a thread as a `branch` inside the one shared session and
SHALL keep durable per-branch lifecycle metadata: a kind (default, new, fork, or
incognito), a short label, and, for a fork, a `parent_branch_id` and a
`fork_point` (the parent's latest turn at fork time). Incognito branches SHALL be
ephemeral and SHALL NOT be written to the thread store.

#### Scenario: List threads merges every store
- **WHEN** a client calls `GET /v1/threads` with a valid gateway token
- **THEN** the response lists every branch merged from the chat, voice, and
  browser stores with its kind, label, last activity, and rolling summary
- **AND** a chat-only or browser-only thread is visible

#### Scenario: Fork records its lineage
- **WHEN** a client calls `POST /v1/threads/switch` with `action` = fork
- **THEN** the gateway mints a `fork-` branch that records the parent branch and
  the parent's latest turn as the fork point
- **AND** the child summary is seeded from the parent

### Requirement: Active thread is shared across devices
The gateway SHALL store the active thread per session (and optionally per
surface) so every device resolves the same thread. An explicit `branch_id`
switch SHALL set that branch active; a new/fork/incognito action SHALL mint a
fresh branch and set it active.

#### Scenario: Active thread resolves after a switch
- **WHEN** a client switches threads and later calls `GET /v1/threads/active`
- **THEN** the response returns the branch it switched to with its kind and label

### Requirement: Mobile follow-ups retain explicit thread and intent scope
After a mobile client creates a fresh thread, later current-thread taps SHALL
reuse that resolved branch across chat, HTTP voice, streaming voice, reconnect,
and service restart. A client SHALL bind an automatic agent-run follow-up only
when an active run belongs to the exact session and branch. If multiple active
intents have runs in that scope, the client SHALL treat the target as ambiguous
and SHALL route the turn through normal intent resolution instead of selecting
an unrelated or globally recent run.

#### Scenario: Single tap continues the double-tap thread
- **WHEN** a double tap resolves a new branch and a later single tap starts a turn
- **THEN** the later turn carries the resolved branch on every transport
- **AND** a reconnect does not reset the branch to `default`

#### Scenario: Concurrent runs do not capture each other's follow-ups
- **WHEN** active runs exist in another branch or multiple active intents exist
  in the current branch
- **THEN** no globally recent run is selected
- **AND** an unambiguous same-intent run may still receive the follow-up

### Requirement: The context_management decision
The gateway SHALL decide where a user turn belongs (continue, new, fork, or
incognito) before answering, on the text-chat path and the cascaded voice
reasoner, via exactly one `context_management` tool call in a dedicated decision
preflight. The preflight SHALL receive only the current user text and bounded
decision instructions, SHALL force that tool, SHALL discard prose, and SHALL
offer no mutation/action tools. The answer SHALL start as a fresh provider
request after scope resolution and SHALL NOT offer `context_management`. A
deterministic prior SHALL run
first: an explicit client `context_action` SHALL always win; otherwise the prior
SHALL default to continue, lift to new/fork by phrasing, and lift to incognito
only on an explicit linguistic warrant. The model tool call MAY override the
prior EXCEPT it MAY only choose incognito when the transcript carries that
explicit warrant. Every decision SHALL be stored as an inspectable record and a
product event, and a decision failure SHALL never fail the turn.

An explicit valid client action SHALL skip preflight. A malformed, absent,
unknown, duplicate, timed-out, or failed preflight tool result SHALL retain the
prior without a preflight plain-answer fallback. The canonical artifact query
SHALL use the valid decision `retrieval_query` when nonblank and otherwise the
current user text.

The gateway SHALL represent the resolved filing identity and fork cutoff as one
immutable plan used by both retrieval and persistence. It SHALL NOT create,
switch, touch, or seed a durable branch before the answer succeeds. A completed
chat or cascaded-voice `turn_id` retry SHALL return the stored response before
preflight and SHALL NOT mint a new branch or repeat a provider request.

#### Scenario: Failed answer leaves no planned branch
- **WHEN** a new or fork filing plan is resolved but the answer does not succeed
- **THEN** no durable branch, active-thread switch, or fork summary seed is written

#### Scenario: Completed retry replays exact filing
- **WHEN** a completed chat or cascaded-voice turn is retried with the same turn id
- **THEN** the stored response and filing branch are returned without preflight
- **AND** no additional branch is minted

#### Scenario: Model overrides the prior
- **WHEN** the model calls `context_management` with `action` = new on a turn
  whose prior was continue
- **THEN** the turn is filed on a fresh `thr-` branch
- **AND** the decision record marks it a model override

#### Scenario: Incognito requires a warrant
- **WHEN** the model calls `context_management` with `action` = incognito on a
  turn whose transcript has no incognito warrant
- **THEN** the gateway denies incognito and the prior stands
- **AND** the turn is persisted normally

#### Scenario: Explicit client choice wins
- **WHEN** a request carries `context_action` = continue and the model calls
  `context_management` with `action` = new
- **THEN** the turn continues on the caller branch and the model action is ignored

### Requirement: Per-query enrichment
The gateway SHALL assemble bounded, read-time (LLM-free) enrichment for the chat
and cascaded voice paths in priority order: standing facts, thread recency scoped
to the active branch with fork-point inheritance, and a bounded semantic recall
block over rolling thread summaries and intent memories, deduped against the
recency block. A new or incognito thread SHALL still load standing facts.

#### Scenario: Fork inherits parent recency
- **WHEN** a turn continues on a fork branch
- **THEN** the recency block includes the parent branch's turns up to the fork
  point plus the fork's own turns, with no data copy

#### Scenario: Semantic recall surfaces a past thread
- **WHEN** a turn's words match a rolling thread summary in the Brain
- **THEN** a bounded "Related past threads" block is injected into the model
  messages

### Requirement: Canonical context artifact
The gateway SHALL assemble the bounded chat and cascaded-voice retrieval inputs
as a canonical context artifact after any decision preflight and before the
fresh answer provider call. No retrieval artifact or source content SHALL be
assembled for or disclosed to the preflight. That artifact SHALL carry
an artifact version, artifact id, deterministic cache identity, stable source
ids, ranking rationale, truncation metadata, and secret-like-text redaction
metadata. The user-visible response `context` block SHALL expose only a bounded
receipt of that artifact rather than the full raw context payload.

#### Scenario: Query or source revision invalidates the cache identity
- **WHEN** the retrieval query changes or any cited source revision changes
- **THEN** the artifact cache identity changes
- **AND** an equivalent query over the same cited source revisions keeps the
  same cache identity

#### Scenario: Deleted or incognito content is excluded from the artifact
- **WHEN** a candidate retrieval item is marked deleted or belongs to an
  incognito branch
- **THEN** the gateway omits it from the context artifact
- **AND** the artifact receipt records the omission without surfacing the hidden
  content

### Requirement: Rolling per-thread summaries
The gateway SHALL maintain a rolling summary per thread, regenerated
asynchronously after the response is sent (never adding turn latency) on a
turn-count cadence and when the user moves off the thread. Summary generation
SHALL use the model when a provider is configured and a deterministic fallback
otherwise; a failure SHALL keep the stale summary. Each summary SHALL be indexed
into gbrain under `moa/memory/thread/<branch>`. Incognito threads SHALL never be
summarized.

#### Scenario: Summary refresh on cadence
- **WHEN** a branch reaches the configured turn cadence
- **THEN** the gateway writes a refreshed summary record and indexes it into
  gbrain thread memory

### Requirement: Incognito persists nothing
The gateway SHALL answer an incognito turn normally and SHALL skip ALL
persistence for it: no chat/voice turn file, no ledger line, no product-event
mirror, no gbrain write, no PCM voice archive, no rolling summary, and no broker
event. The reply SHALL carry a visible marker (`context.action` = incognito,
`context.persisted` = false). This is the one deliberate exception to "no spoken
intent may be treated as ephemeral" and SHALL require an explicit warrant or an
explicit client choice.

#### Scenario: Incognito HTTP voice turn saves nothing
- **WHEN** a voice turn is incognito
- **THEN** no turn file, ledger line, product event, or gbrain fact is written
- **AND** the response reports `persisted: false` on an `inc-` branch
- **AND** standing facts are still read so the answer knows the user

#### Scenario: Incognito streaming turn deletes its audio
- **WHEN** a streaming voice turn is incognito
- **THEN** the buffered PCM archive for the turn is deleted
- **AND** no canonical turn record or product event is written
