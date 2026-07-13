## Why

Users need to control where a message goes. A turn can continue the current
thread, start a new unrelated thread, fork off the current thread while keeping
its history, or run incognito with nothing saved. Today every non-incognito turn
rides a single `branch` key with no lifecycle, chat-only sessions are invisible
in the session list, and the gateway has no way to answer a turn without saving
it. Most turns should be classified by the model in one tool call, with an
explicit client choice always winning.

## What Changes

- Add a thread store: durable per-session branch metadata (kind, label, fork
  lineage), the active-thread pointer per surface, and rolling per-thread
  summaries. Threads are branches inside the one shared session.
- Add `GET /v1/threads`, `POST /v1/threads/switch`, and `GET /v1/threads/active`.
  The thread list merges the chat, voice, and browser stores, fixing the
  chat-only-session-invisible bug in `sessionSummaryPayload`.
- Add the `context_management` tool on the text-chat path and the cascaded voice
  reasoner. A deterministic prior runs first (explicit client `context_action`
  always wins; otherwise continue, lifted to new/fork by phrasing and to
  incognito only on an explicit linguistic warrant). The model tool call may
  override the prior, EXCEPT it may only choose incognito with that same warrant.
  Every decision is stored as an inspectable record and product event. A decision
  failure never fails the turn.
- Fork = a child branch carrying `parent_branch_id` + `fork_point`. Its recency
  inherits the parent's turns up to the fork point plus its own, with no data
  copy. New = a fresh cold branch (standing facts still load). Incognito = an
  ephemeral `inc-` branch.
- Add per-query enrichment (LLM-free at read time): standing facts, thread
  recency scoped to the active branch with fork-point inheritance, and a new
  bounded semantic recall block over rolling thread summaries + intent memories.
- Emit a canonical bounded context artifact for chat and cascaded voice
  retrieval: versioned artifact id, cache identity, source ids, ranking
  rationale, truncation/redaction metadata, and a bounded receipt on the
  response `context` block.
- Add rolling per-thread summaries, regenerated asynchronously (never adding turn
  latency) on a turn-count cadence and when the user moves off a thread. A fork
  seeds its summary from the parent. Incognito is never summarized.
- Incognito skips ALL persistence: no chat/voice turn file or ledger line, no
  product event, no gbrain write, no PCM voice archive, no rolling summary, no
  broker event. The reply carries `context: { action: "incognito", persisted:
  false }`.

## Boundaries

- A thread is a branch inside the one shared session; this change adds lifecycle
  metadata over the existing turn ledgers, not a new store of record.
- Server/model output stays a proposal: the context decision routes and files a
  turn; it does not execute anything.
- History stays shared across devices via the gateway. The active-thread pointer
  is durable so every surface resolves the same thread.
- Incognito is the one deliberate, documented exception to "no spoken intent may
  be treated as ephemeral". It requires an explicit warrant or an explicit client
  choice.

## Verification

- `cd gateway && npm run check` (chains `smoke-threads`, `smoke-context-decision`,
  `smoke-thread-enrichment`, `smoke-incognito`).
