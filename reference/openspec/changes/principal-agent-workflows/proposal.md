# Principal Agent Workflow Profiles

## Why

Chief Moa has a durable message broker, focused launcher context packs,
non-blocking agent runs, work-history evidence primitives, and worker-isolated
worktrees. It does not yet expose the user's recurring security, simplification,
and fuzzing responsibilities as stable selectable roles. Without checked-in
contracts, those requests fall into generic coding or QA and can mix auditing,
repair, and acceptance in one unauditable run.

## User Outcome

A spoken or typed request for a security audit, behavior-preserving cleanup, or
fuzzing selects a named principal workflow with an inspectable context pack.
When the caller explicitly requests activation, the existing broker launches
one non-blocking principal run. The user can inspect the role, exact scope,
constraints, expected evidence, and repair handoff before broader autonomous
coordination exists.

## First Slice

- Add checked-in `security`, `simplification`, and `fuzzing` launcher profiles
  and directory-backed workflow instructions.
- Route explicit spoken/text role intent deterministically through the existing
  broker.
- Include role, execution policy, role constraints, and repair handoff in the
  stored launcher context pack and prompt.
- Keep explicit activation limited to one selected launchable route, using the
  existing non-blocking `agent_run` path.

## Non-Goals

- No recurring scheduler, always-on maintenance loop, or automatic triggering.
- No multi-principal concurrent launch in this slice.
- No automatic repair fanout or merge/promotion authority.
- No new run store, worker protocol, or worktree implementation.
- No security or fuzzing principal repairing or accepting its own findings.

## Success Criteria

- Explicit security, simplification/deslop/LOC/rearchitecture, and fuzzing
  phrases select their exact workflow profile ahead of generic QA/coding.
- Context packs carry checked-in workflow paths and role-specific policy.
- Selection alone launches nothing; explicit launch starts exactly one
  non-blocking run.
- Security findings require a separate repair plus an independent re-verifier.
- Fuzzing binds evidence to an isolated exact candidate, minimizes and
  deduplicates findings, and emits bounded repair handoffs.
- Simplification may edit, test, and commit one isolated behavior-preserving
  candidate and reports before/after evidence, but cannot weaken checks, accept
  itself, merge, deploy, promote, publish, push master, or change active state.
