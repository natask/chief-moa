# Independent local audit: deployment control slice

Date: 2026-07-10

## Verdict

- REPAIR APPLIED: requestless applied records are blocked; only request-bound
  guarded apply can emit applied state
- REPAIR APPLIED: preview records, preview verification, effect receipts, and
  recovery adoption are now bound to typed claims, workers, and deployment ids
- REPAIR APPLIED: idempotency is domain-separated inside the deployment slice
  and hostile replay mismatches now throw instead of silently returning a stale
  event
- REPAIR APPLIED: event-log rebuild paginates past 500 deployment events and
  hostile ref inputs now reject objects, secrets, and shell payloads
- PASS: second fresh gpt-5.4 read-only audit found no surviving source blocker
  after preview rebind, full request fingerprints, explicit effect adoption,
  receipt propagation and stable paginated rebuild.
- BLOCK: no live deploy adapter, preview URL reachability, or active-service
  drain/resume proof exists in this deterministic-only lane

## Evidence

- [gateway/lib/work-history.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/lib/work-history.js)
  now blocks requestless applied records, binds preview verification to the
  current preview claim, forces explicit `deployment.effect_adopted` recovery
  before replacement receipt, paginates rebuilds, and rejects non-string refs.
- [gateway/lib/event-substrate.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/lib/event-substrate.js)
  now honors ascending pagination offsets during event replay.
- [gateway/test/work-history-deployment-control.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/test/work-history-deployment-control.test.js)
  now covers preview-binding failures, crash-after-effect adoption across
  restart, hostile idempotent replay, hostile refs, and 501-event rebuilds.

## Measured vs architecture confidence

- Measured by the manager: focused 6/6; work-history intent and listening HTTP
  smokes pass; full gateway 178 pass, 1 skip, 0 fail.
- Architecture confidence only: live preview/apply/rollback adapters, target
  drain/resume, active URL cutover, backup restore on a real target, and
  post-apply smoke against a running deployment.

## Remaining blockers

- The read-only audit sandbox cannot create temp files, so its execution attempt
  reports EPERM; the manager's unrestricted isolated-worktree commands above are
  the measured test evidence.
- No live adapter, isolated target preview, drain/resume, target backup/restore,
  apply, rollback, or post-apply smoke was run.
