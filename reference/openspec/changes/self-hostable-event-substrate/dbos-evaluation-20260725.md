# DBOS Architecture Evaluation — 2026-07-25

## Question

Could DBOS serve as Chief Moa's durable execution layer for agent/tool
workflows while the product event log remains the authoritative domain record?

This is a research result, not an adoption decision, implementation, deployed
pilot, or performance result.

## Primary sources

- DBOS architecture: <https://docs.dbos.dev/architecture>
- Workflow recovery: <https://docs.dbos.dev/production/workflow-recovery>
- Python queue reference: <https://docs.dbos.dev/python/reference/queues>

These URLs were the official sources retained by the producer report and
checked by an independent verifier. Product behavior, licensing, and hosting
terms can change and must be rechecked before adoption.

## Facts supported by the sources

- DBOS persists workflow execution state in Postgres and uses that state to
  recover interrupted workflows.
- DBOS queues can bound concurrency and provide queue-oriented execution
  controls.
- DBOS is an application-level durable execution system. It does not replace
  the operating-system process supervisor, sandbox, filesystem, or Chief Moa's
  product event log.
- Durable workflow recovery does not by itself make arbitrary external side
  effects exactly once. A step can perform an external effect and fail before
  its durable completion is recorded, so mutations still need idempotency keys,
  transactional coupling where possible, or reconciliation.

## Chief Moa interpretation

The producer concluded that DBOS is a credible candidate for checkpointed agent
and tool runs, waits, retries, recovery, and bounded queues. This is an
architectural inference from the official behavior, not proof that DBOS meets
Chief Moa's workload, operational, self-hosting, or failure-recovery needs.

If adopted, the intended boundary would remain:

```text
Chief Moa domain event log
  -> authoritative product history, audit, projections, receipts

DBOS durable execution state
  -> workflow checkpoints, queueing, waits, retries, recovery

local execution supervisor
  -> processes, descriptors, resource limits, sandboxing, replacement
```

DBOS would not remedy the observed local Codex file-descriptor retention. It
could durably schedule and recover work around workers, but process cleanup and
resource governance remain supervisor responsibilities.

## Independent verification and corrections

The verifier agreed with the architectural fit as a research conclusion and
required these corrections and limits:

- Say "credible candidate," not selected platform or operating system.
- Keep DBOS execution checkpoints separate from canonical Chief Moa domain
  events and device-owned action receipts.
- Do not claim exactly-once external effects; require idempotency or
  reconciliation at side-effect boundaries.
- Do not infer a production-ready distributed deployment from local workflow
  recovery documentation.
- Treat any claim about DBOS Conductor availability, proprietary production
  coordination, or licensing as unresolved until current official commercial
  terms are checked directly.

## Uncertainties and remaining work

- No equal-rubric comparison against Graphile Worker, Absurd, or a minimal
  Postgres checkpoint implementation has been preserved.
- No Chief Moa DBOS pilot has been implemented.
- Restart/resume, cancellation, idempotent side effects, operational burden,
  backup/restore, and self-hosted deployment have not been tested.
- Node/TypeScript integration fit and current licensing/commercial constraints
  remain unverified.

The next valid evidence is an alternative comparison followed by one bounded
pilot that interrupts and resumes a real agent/tool workflow without duplicating
its linked domain event or external side effect.
