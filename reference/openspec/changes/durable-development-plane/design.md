# Design

The development plane uses the existing product event substrate. It adds no
second database. One stream owns one intent:

```text
development.intent.captured
  -> development.plan.defined
  -> development.task.claimed
  -> development.task.completed | development.task.failed
  -> development.candidate.ready
  -> development.user.accepted | development.user.rejected
```

Each task names dependencies, path claims, an acceptance check, a memory
estimate, and whether it may run beside other work. A task is runnable when all
dependencies passed and its path claims do not overlap running work. The
scheduler also respects the work and memory budgets supplied by the caller.

The coordinator turns only those runnable tasks into stable agent runs. Existing
worker-pull leases and heartbeats remain the execution authority. The
coordinator reports that live state beside each task and folds terminal run
receipts back into the graph before it schedules more work.

Integration tasks also enter one global event-backed queue. One expiring lease
may own integration authority across all intents. A terminal run releases that
lease before the next queued integration task may start.

The gateway serves a separate development and QA page. It captures the raw riff
and can launch browser screen recording without taking over the user's active
work surface. It shows task, worker heartbeat, integration, QA, and exact
candidate evidence. Accept and reject actions bind the displayed digest.

Acceptance atomically creates a release-policy handoff containing the frozen
candidate ref, digest, and QA evidence. The handoff is a proposal for the
existing active-promotion policy. It does not grant direct deployment authority.

The first dispatch asks the configured model for a JSON-only task graph. The
development plane validates that untrusted output before storing or running it.
Terminal agent-run receipts trigger reconciliation and dispatch of the next
dependency-safe batch without requiring the QA page to remain open.

Exit code zero is not acceptance evidence. Every worker must emit a structured
development receipt. Implementation and integration name output refs. QA and
integration name verification refs. Missing or failed evidence blocks the graph.
The integration receipt must name a Git commit. Once final QA completes, that
commit and the accumulated QA refs become the frozen candidate automatically.

Development dispatch writes queued agent runs directly. It never invokes a
local harness in the gateway's active checkout. Worker-pull owns the durable
worktree, heartbeat, cancellation, and terminal-result boundary in every mode.

QA is a task kind. A candidate cannot become ready until every planned task has
completed and at least one QA task exists. User acceptance binds the exact
candidate digest. The development plane can launch bounded workers. It does not
grant them merge, publish, or deployment authority.
