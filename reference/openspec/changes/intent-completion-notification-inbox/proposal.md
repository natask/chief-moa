# Intent Completion Notification Inbox

## Why

The user can already launch an agent-owned intent through the broker
completion spine (`gateway/lib/broker-completion-spine.js`), watch it run
through the intent runtime's durable lifecycle
(`gateway/lib/intent-runtime.js`: `captured -> clarified -> planned -> active
-> {waiting, blocked, completed, abandoned, superseded}`), and see a pending
notification appear on that intent. What does not exist is a way to *manage*
that: a stalled intent is never actively re-driven, a finished intent's
announcement has no rule that stops it from cutting off whatever the user was
doing, and there is no single place to review, silence, or dismiss what
finished — only a per-intent notification embedded in that intent's own
projection.

This change specifies the gap precisely instead of re-deriving the whole
system: what exists, what is missing, and the smallest slice worth shipping
now.

## What Already Exists (do not rebuild)

- **Agent switchboard** (`agent_switchboard/`): defines what tools/capability
  an agent may use; routes a message to a route/session/workflow.
- **Intent lifecycle + durable storage**: `gateway/lib/intent-runtime.js`
  (capture/transition/connect/focus/claim/progress/notify), backed by the one
  shared product-event log (`eventSubstrate`, `gateway/lib/event-substrate.js`)
  that also backs work-history and the intent plane. `GET
  /v1/intent-runtime/neglected` already computes which active intents have no
  current run or an expired run lease (`gateway/lib/intent-runtime.js:753`).
- **Sub-agent launch + linkage**: `gateway/lib/broker-completion-spine.js`
  creates one idempotent chain (broker event -> route decision -> context pack
  -> intent -> task -> work-history run -> `agent_run`) and links terminal
  agent-run results back to that same intent and work-history run
  (`work-history-completion.js`).
- **A notification store with receipts**: `gateway/lib/intent-plane.js`
  already has `createNotification`/`receiveNotification`, keyed by intent, with
  a durable receipt (`actor`, `note`, `at`) over the same event substrate. It
  auto-fires on `completed`/`needs_user` intent-plane transitions
  (`intent-plane.js:187-197`) and is reachable at
  `POST /v1/intent-plane/notifications/:id/receipt`.
- **A device-hub notification bridge pattern**: `gateway/lib/account-connections.js`
  shows the established dependency-inversion shape for "a durable record
  optionally bridges to a device/UI surface" (`onUserActionNotification` hook,
  best-effort, never fails the caller) that this change reuses rather than
  inventing a new bridging convention.

## The Gaps This Change Specifies

1. **No active forward-progress loop.** `neglected()` is a read-only query.
   Nothing calls it on a schedule, nothing re-pings a stalled intent's owning
   agent/launcher, and nothing caps retries so a stuck intent isn't pinged
   forever.
2. **No non-interrupting completion delivery contract.** The broker completion
   spine calls `intentRuntime.notify()` (an intent-scoped durable record) but
   nothing decides *how* that reaches the user without cutting off an
   in-flight reply or the user speaking. A separate lane
   (`feat/voice-spine-20260729`) is building a delivery arbiter with
   `overlay` / `interject` / `defer` modes and the rule that a background
   completion may never take the floor from an in-flight reply. This change
   must not build a second, competing delivery mechanism — it specifies intent
   completion as one **producer** into that arbiter.
3. **No cross-surface, filterable, reviewable inbox.** `intent-plane`
   notifications exist, but the only way to read them is bundled inside
   `projection()`/`explain()`, scoped to whichever intents are on the current
   page. There is no `GET` that answers "show me my unread notifications"
   directly, no `dismiss` distinct from `receive` (native paradigms
   distinguish "swiped away" from "opened and acted on"), and completions
   produced by the intent-runtime/broker-completion-spine pipeline never reach
   this store at all — only intent-plane's own `updateIntent` transitions do.
   There is also no per-surface delivery record (Android channel, browser
   Notification, silent-vs-visible) for adapters to key off.

## Scope Of This Change

- Specify the intent lifecycle and its scheduler/ping contract precisely
  (states, wake condition, backoff, give-up).
- Specify intent completion as a producer into the (not-yet-merged) delivery
  arbiter, naming the priority tier and the requirement this change needs from
  that arbiter if it doesn't already offer it.
- Specify the notification record, the inbox, and native per-surface delivery
  (Android channels respecting the user's own settings, the browser's own
  Notification mechanism, voice agent read/act access).
- **Implement the smallest genuinely useful slice**: generalize the existing
  `intent-plane` notification store into the one cross-surface inbox —
  directly listable/filterable, dismissible distinct from received, carrying a
  `silent` hint — and wire the broker-completion-spine's terminal result into
  it (best-effort, non-blocking) so completions from *either* lifecycle system
  land in the same inbox. This is implemented in this change; see Tasks.
- The active scheduler/ping loop and the arbiter integration itself are
  specified but **not implemented** in this change (see Non-Goals and the
  dependency on `feat/voice-spine-20260729`).

## Non-Goals

- No new parallel intent store, event log, or notification store. Everything
  here is additive to `intent-plane.js` and the shared `eventSubstrate`.
- No scheduler/cron implementation in this change — the wake/backoff/give-up
  contract is specified so it can be implemented once (not duplicated) against
  the existing `neglected()` projection.
- No delivery-arbiter implementation — that lane owns `overlay`/`interject`/
  `defer` and the no-interrupt guarantee. This change only specifies the
  producer contract and the priority tier it needs.
- No Android/browser client code in this change. The notification record and
  its `silent` hint are the contract those clients build channel/Notification
  adapters against.
- No override of the user's OS notification settings from the gateway. The
  gateway only ever suggests urgency; the surface and the OS decide what is
  actually shown, sounded, or suppressed.

## Success Criteria (this change)

- `GET /v1/intent-plane/notifications` lists and filters
  (`receipt_state`, `kind`, `intent_id`) without requiring the caller to page
  through intents.
- `POST /v1/intent-plane/notifications/:id/dismiss` records a distinct
  terminal state from `receive`, and never downgrades a received notification.
- A terminal `agent_run` linked through the broker completion spine produces
  exactly one inbox entry (idempotent on retry), tagged `agent_output_ready`
  (silent) or `agent_run_stopped` (non-silent), independent of whether the
  intent-plane's own intent record for that id exists.
- A broken/unavailable notification inbox never fails the completion event it
  is reporting on (best-effort, matching the existing credential-notification
  bridge shape).
