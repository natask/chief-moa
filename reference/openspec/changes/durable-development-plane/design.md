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

QA is a task kind. A candidate cannot become ready until every planned task has
completed and at least one QA task exists. User acceptance binds the exact
candidate digest. This first slice records authority and scheduling state. It
does not launch workers, mutate Git, merge, publish, or deploy.
