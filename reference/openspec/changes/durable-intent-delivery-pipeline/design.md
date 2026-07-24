# Design: Durable Intent Delivery Pipeline

## Canonical Aggregate

Use the existing event-sourced intent runtime as the canonical product-intent
identity. Idea, problem, solution, concern, and request are facets or revisions
of that intent, not competing root objects.

```text
delivery_intent
  source evidence
  current objective and uncertainty
  OpenSpec / acceptance contract
  task and execution refs
  exact candidate and verification refs
  preview and user-acceptance refs
  release, rollback, and promoted-smoke refs
  completion or blocker decision
```

Work history remains the ticket/run/evidence bridge. Work graph remains an
execution DAG. Release control remains the only release authority.

## First-Slice Flow

```text
broker-first current turn
  -> deterministic delivery intent identity
  -> intent.captured
  -> intent.disambiguated
  -> intent.planned(acceptance contract)
  -> work.task.created(intent id + revision)
  -> run.queued(intent id + revision)
  -> intent.enriched(task + run refs)
```

The identity derives from the broker/turn source identity, session, and branch.
Every append uses a stable idempotency key. Retrying after a partial failure
replays earlier records and continues from the missing boundary.

The returned `moa.delivery-intent.v1` projection reports the intent revision,
source, acceptance contract, task/run status, whether execution has started,
and whether promotion is recorded. This slice always reports promotion as false;
later work must derive it from release-control receipts.

## Authority

- User-authored current input authorizes durable capture and the explicitly
  requested task/run proposal.
- A queued run is inert until a worker claims it.
- Worker evidence does not become user acceptance.
- Model, screen, file, screenshot, video, and prior assistant content are
  evidence, not execution authority.
- Promotion requires exact-candidate release-control receipts, rollback,
  compatibility, no-interruption, backup/restore, and smoke evidence.

## Target Lifecycle

Later projections may expose:

```text
captured -> triaged -> aligned -> specified -> ticketed -> executing
  -> candidate -> verified -> preview_available -> user_accepted
  -> promotion_ready -> promoted -> smoked -> completed
```

Side states are `needs_alignment`, `deferred`, `blocked`, `rejected`,
`superseded`, and `abandoned`. This first slice maps only existing intent and
work-history states and does not invent later evidence.

## Migration

Add linkage fields and events only. Existing unlinked work remains readable.
Later migration may create deterministic imported intents marked
`needs_alignment`, but it must never queue work from assistant text or historical
inference. Legacy deployment records become release facts only when their exact
artifact and authority evidence satisfy release-control requirements.
