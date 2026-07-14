## Object boundaries

- Session: cross-surface container.
- Thread: conversational branch and context view.
- Project: durable goal/portfolio container; the existing working-directory
  project record is a repo binding.
- Intent: one desired outcome.
- Work node/task: decomposition or execution projection of an intent.
- Run: one execution attempt.
- Artifact/receipt: evidence.
- Telemetry: derived, loss-tolerant operations data.

## Canonical record

The existing product event substrate stores `intent.*` events. A deterministic
reducer reconstructs current state. Events are idempotent, bounded, versioned,
and portable across JSONL and Postgres adapters.

Core transitions:

```text
captured -> clarified -> planned -> active
active -> waiting | blocked | completed | abandoned | superseded
waiting | blocked -> active | completed | abandoned | superseded
```

Terminal intents cannot restart. Typed relation edges are `related_to`,
`depends_on`, `blocks`, `corrects`, `supersedes`, and `evidence_for`.

## Focus and transactional children

A temporary configuration command is captured as a child intent with
`return_to_intent_id`. The gateway appends focus-pushed, runs the existing
bounded tool, records its versioned receipt/outcome, completes the child, and
appends focus-popped. Replay makes this exactly-once from an idempotency key.

## Admission and context

The client/deterministic context action is resolved before recency or semantic
recall. The selected target is immutable for the admitted turn. A later model
proposal can enrich or propose future routing but cannot retroactively refile a
turn after seeing another thread's data. Explicit new/incognito receives
standing facts and no caller-thread recency.

## Rehydration

The read model returns bounded objective, lifecycle/focus, priorities,
decisions, relations, plans, attempts, blockers, artifacts/receipts, outcome,
lessons, and next step with source receipts and truncation metadata. It does not
claim completeness after hitting replay bounds.

## Compatibility and migration

Existing broker, thread, work, and run routes remain. New intent IDs and links
are additive. The event stream can be mirrored before reads switch; no
destructive migration is coupled to deployment.
