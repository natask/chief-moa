# Gateway integration implementation contract

## Runtime construction and HTTP

- Construct `intentRuntime` beside `eventSubstrate`; it is canonical and any
  required append failure fails the request closed.
- Construct `voiceDraftStore` under `DATA_DIR` with product-event mirroring that
  is explicitly additive/loss-tolerant.
- Mount authenticated bounded intent list/detail/rehydration routes after the
  existing event routes. Mount voice-draft create/list/detail/segment/action/
  audio routes beside `audio-notes`, without reusing audio-note storage.
- Return stable 4xx conflict/authority/quota errors; never echo filesystem paths,
  raw credentials, or discarded content.

## Intent admission order

- Chat: resolve the immutable context action/thread, skip incognito, then await
  `capture` before context retrieval, model calls, tools, or persistence of an
  answer. Carry `intent_id` into the turn/product-event response refs.
- HTTP and cascaded/streaming voice: capture after immutable branch admission
  and before classification/routing, memory mutation, tools, broker fan-out,
  provider reasoning, or answer generation. Incognito creates no intent.
- Broker: build the bounded broker envelope, await intent capture, then and only
  then compute decisions/context packs or call `launchBrokerRunsIfRequested`.
  Store/link the broker event, decisions, runs, work history, artifacts, and
  receipts as refs on the intent rather than alternate intent authorities.
- Retries use source-derived deterministic idempotency keys. An existing
  conflicting payload is an error, not a second intent.

## Transactional profile child

- Wrap one existing `applyAgentProfilePatch` path. The parent is the admitted
  turn intent. Create a transactional child with `parent_intent_id` and
  `return_to_intent_id`, push focus, run the unchanged bounded sanitizer, record
  the versioned profile receipt/outcome, complete the child, then pop focus.
- Failure still records a bounded blocker/outcome and restores focus. Never
  execute a profile write based only on screen/context evidence.

## Draft WebSocket boundary

- The one canonical wire shape is:
  - health: `capabilities.voice_drafts_v1: true`;
  - start/resume: `session_start` with
    `voice_draft_mode:"voice_drafts_v1"`, optional draft ID/revision, exact
    draft session/branch (which must equal the top-level authority), stable
    common `idempotency_key`, and `context_action`. Exact field names are
    `voice_draft_id`, `voice_draft_revision`, `voice_draft_session_id`, and
    `voice_draft_branch_id`;
  - readiness: only `voice_draft_ready`, action `create|resume`, exact
    session/branch/turn, and `draft:{id,revision,state,session_id,branch_id}`;
  - control: only `voice_draft_control`, action `pause|park|discard`, draft ID,
    `voice_draft_id`, `expected_revision`, common `idempotency_key`, and exact
    `session_id`/`branch_id`/`turn_id` (top-level `draft_id` is invalid);
  - acknowledgement: only `voice_draft_control_ack` with the same action and
    authority plus a strictly newer authoritative draft revision;
  - SEND: draft-mode `commit_turn` with `voice_draft_id`, `expected_revision`,
    common `idempotency_key`, and session/branch/turn authority; terminal
    `turn_done` carries the sent/retryable draft
    receipt. No compatibility aliases are accepted in v1.
- A draft-mode `session_start` is an admission/control session, not a canonical
  voice turn. It creates or resumes a draft with exact session/branch/revision
  authority and MUST NOT create a provider session, context prompt, turn file,
  model call, tool call, or canonical voice event.
- Buffer PCM into bounded chunks (target 15 seconds, below the store's segment
  byte cap), then append immutable ordered segments. Do not make each 20ms
  transport frame a segment. Flush before every control, SEND, and close.
- Controls carry draft ID, expected revision, stable idempotency key, session,
  and branch. Acknowledgements carry a known event type/action, exact authority,
  and the authoritative strictly newer revision.
- Pause/park/discard bypass `cancel_turn`. Unexpected close flushes and parks;
  cleanup failure remains visible/retryable.
- SEND first makes the draft `send_ready`, then claims exact authority. Only at
  that point construct a canonical voice turn from the store's verified audio
  and enter the existing `handleCommitTurn` orchestration once. Do not duplicate
  provider orchestration in an HTTP handler.
- If canonical processing fails before `markSent`, release or version an exact
  claim-failure receipt so the same audio remains `send_ready` and can be
  claimed safely by a later attempt. A retry cannot overwrite or double-send a
  successful canonical turn.
- Mark sent and remove draft content only after canonical acceptance succeeds;
  retain a content-free receipt/tombstone.

## Resource and compatibility limits

- Preserve legacy sessions exactly when draft metadata is absent.
- Bound per-connection draft memory, frame/chunk bytes, duration, controls,
  response sizes, list pages, and retry history.
- Do not advertise `voice_drafts_v1` until all HTTP and WS handlers are mounted
  and the store startup recovery succeeds.

## Required proof

- Provider/model/tool counters remain zero through create/capture/pause/park/
  resume/discard and unexpected close.
- Ordered multi-segment audio enters one canonical turn after SEND.
- Provider failure leaves exact bytes and a retryable state; retry produces at
  most one successful sent receipt.
- Broker capture fault produces no decisions, context packs, or launched run.
- Transactional profile test proves push -> receipt -> complete -> pop, including
  the failure path.
- Legacy voice, chat, broker, context, and full gateway gates remain green.
