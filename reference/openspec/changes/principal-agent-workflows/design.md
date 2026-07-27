# Design: Principal Agent Workflow Profiles

## Reused Runtime

The message broker remains the only selection and launch boundary:

```text
spoken/text broker event
  -> deterministic workflow recommendation
  -> checked-in launcher profile
  -> stored bounded context pack
  -> no execution by default
  -> explicit launch: one wait=false agent_run
```

The profile registry is `gateway/agent-launcher-profiles.json`; workflow
instructions live under `gateway/agent-workflows/<role>/WORKFLOW.md`. The
context pack adds `principal_role`, `execution_policy`, role-specific
constraints, and an optional `repair_handoff`. These fields inform the worker
contract but grant no execution, device, merge, or deployment authority.

Principal runs are bounded leaf workers by default. Top-level coordination and
lane splitting remain with the user-facing coordinator. A principal may only
delegate recursively when its checked-in launcher profile names a specific
delegation ticket and the generated context pack carries that grant; broker
message text alone is never a delegation grant.

## Role Boundaries

### Security

`security` uses `audit_only`. It identifies the exact candidate, runs bounded
read-only probes, deduplicates findings, and emits repair contracts. It cannot
edit the candidate. A separate repair run implements accepted fixes and a
different verifier replays the original probes against the repaired candidate.

### Simplification

`simplification` uses `behavior_preserving_changes`. It covers deslop, line and
complexity reduction, behavior-preserving rearchitecture, and quality cleanup.
Each run freezes focused behavior checks, performs one bounded change, records
before/after evidence, and stops if the desired result requires a feature or
policy change. It may edit, test, and commit only that candidate in its isolated
branch/worktree. It cannot weaken checks, verify or accept its own candidate,
merge, deploy, promote, publish, push master, or modify active deployment refs
or services. It hands the commit and unchanged checks to a separate independent
verifier; only the coordinator may later integrate or release a passing result.

### Fuzzing

`fuzzing` uses `isolated_evaluation_only`. It records exact candidate,
configuration, harness, corpus, seed, and resource bounds; minimizes and
deduplicates reproducible failures; and produces one bounded repair handoff per
unique finding. It cannot edit the candidate or launch repairs.

## Worker And Evidence Boundary

The existing worker workspace can create a detached per-run worktree, and work
history can record before/after snapshots, diffs, and verification artifacts.
This first slice does not wire broker runs to those primitives automatically.
Until that later integration is complete, each workflow contract requires the
worker to establish and report exact-candidate isolation as evidence; absence
is a blocker, never an inferred pass.

## Peter/Natstack Lessons Applied

The intent-runtime run demonstrated that green narrow tests do not replace a
separate hostile audit, repair work must not rewrite the auditor's acceptance
contract, and each lane needs an isolated worktree, exact handoff, and serial
integration ledger. The principal contracts preserve those separations without
copying Peter's orchestration into the broker.

## Staged Follow-Ups

1. Bind principal broker launches to configured worker projects and per-run
   worker-isolated worktrees, recording exact before snapshots before execution.
2. Store structured finding, repair-contract, minimized-reproducer, diff, and
   independent-verification artifacts in work history.
3. Add user-approved bounded repair launch from one accepted finding; never let
   the audit principal edit the repair candidate or acceptance predicate.
4. Add a separate independent verifier role/assignment policy and enforce
   distinct run/worker identity where required.
5. Add multi-principal planning and concurrency only after ownership, budgets,
   result joining, and conflict/merge policy are explicit.
6. Add recurring schedules only after pause/cancel, resource budgets, quiet
   periods, retained evidence, and notification policy are proven.

No follow-up is authorized by completion of this first slice.
