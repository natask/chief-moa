# Implementation Contract: Canonical Intent Runtime

## Boundary

An intent is one desired outcome. It is not a session, thread, repo binding,
work node, task, run, artifact, broker event, or telemetry record. The canonical
record is an append-only `intent.*` stream in the existing product-event
substrate. Existing objects remain projections/adapters and keep their public
routes.

## Domain API

Add a pure CommonJS module backed only by an injected event substrate:

```text
createIntentRuntime({ events, idFactory, now })
  capture(input)
  transition(intentId, command)
  connect(intentId, relation)
  pushFocus({ sessionId, intentId, returnToIntentId, ... })
  completeTransactional(intentId, { outcome, receiptRefs, ... })
  popFocus({ sessionId, intentId, ... })
  get(intentId)
  list(filter)
  rehydrate({ intentId | projectId, limits })
```

The reducer must be deterministic and restart-safe. Commands carry an
idempotency key. Reads paginate the event substrate in bounded 500-event pages
and report truncation rather than claiming completeness.

## Canonical fields

- `intent_id`, `statement`, `normalized_objective`, `project_id`
- source refs: session, branch, turn, broker event, surface, audio/transcript
- lifecycle state, focus state, parent intent, `return_to_intent_id`
- typed relations: related-to, depends-on, blocks, corrects, supersedes,
  evidence-for
- enrichment/plan/run/artifact/action/approval/receipt/lesson refs
- completion criteria, blocker, outcome, next step, version, timestamps

All IDs, text, arrays, and refs are hard-bounded. Unknown event types fail
closed in commands and are ignored-with-diagnostic during forward-compatible
replay.

## Events and state

Events: `intent.captured`, `intent.disambiguated`, `intent.connected`,
`intent.enriched`, `intent.planned`, `intent.execution_started`,
`intent.waiting`, `intent.blocked`, `intent.completed`,
`intent.abandoned`, `intent.superseded`, `intent.lesson_recorded`,
`intent.focus_pushed`, and `intent.focus_popped`.

Lifecycle states: captured, clarified, planned, active, waiting, blocked,
completed, abandoned, superseded. Terminal states cannot restart. A
transactional child must have a parent/return target; it pushes focus, records
its execution receipt/outcome, completes, and pops exactly once back to that
target.

## Route-before-answer rule

At turn admission, resolve the deterministic/client context action before any
thread recency or semantic context is assembled:

- explicit client `context_action` always wins;
- explicit incognito/new/fork wording is resolved before the answer;
- the selected branch is immutable for that admitted turn;
- a later model tool output is enrichment/proposal only and cannot retroactively
  refile a turn after seeing another thread's context.

New and incognito contexts may include standing user facts but must include
zero caller-thread recency or semantic intent history. A failed explicit
new-root/incognito admission fails closed; it never falls back to `default`.
The model's retrieval query must drive the bounded artifact retrieval used for
the turn or be reported as unused.

## Server integration

Serial integration owns `gateway/server.js` and must:

1. Capture every non-incognito ordinary chat/voice/broker turn as an intent
   before route decisions, launches, tools, or answer generation.
2. Persist the broker capture before computing/launching route decisions.
3. Link broker event, work task/node, run, artifacts, and receipts to the
   intent without making them competing authorities.
4. Wrap one existing profile-control action as a transactional child intent:
   focus push -> existing bounded profile tool -> versioned receipt/outcome ->
   complete -> focus pop to the parent.
5. Add authenticated read routes for intent detail/list and a bounded
   project-or-intent rehydration brief.

## Rehydration result

Return objective, current lifecycle/focus, active priorities, recent decisions,
relations, accepted plan refs, active attempts, blockers, artifacts/receipts,
outcome/lessons, next step, and source receipts. Report limits, omitted counts,
and truncation. Do not generate an ungrounded LLM summary in this slice.

## Reuse

- Integrate all six M3 context-artifact commits, then repair its route-before-
  answer audit blocker and rerun its focused privacy/complexity gates.
- Integrate M5's pure Aggie protocol commit after a fresh security audit; expose
  additive intent/focus/brief event types only. Do not claim its HTTP/WS facade
  tasks complete merely because the pure module exists.

## Gates

- Focused intent reducer, transition, idempotency, restart, focus, and bounded
  rehydration tests.
- Explicit new/incognito context-isolation tests.
- Broker fault injection proving capture is durable before launch.
- Profile child-intent focus push/receipt/complete/pop test.
- M3 focused tests/smoke/quality gate; M5 focused tests/smoke.
- Full `cd gateway && npm run check`.

## Forbidden shortcuts

No second JSON intent store, provider-memory authority, model-executable action,
telemetry-as-state, silent default-branch fallback, unbounded replay, invented
source claims, or live deployment.

