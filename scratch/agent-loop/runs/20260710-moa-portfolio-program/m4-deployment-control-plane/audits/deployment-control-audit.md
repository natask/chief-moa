# Independent local audit: deployment control slice

Date: 2026-07-10

## Verdict

- PASS: typed proposals remain non-executable in the implemented slice
- PASS: apply cannot be recorded for a request except through an immutable
  receipt path
- PASS: stale apply claims can expire and be re-claimed without duplicating the
  eventual effect receipt
- PASS: duplicate apply effects are rejected once one effect is observed
- PASS: rollback is explicit, receipted, and rebuildable from events
- BLOCK: no live deploy adapter, preview URL reachability, or active-service
  drain/resume proof exists in this deterministic-only lane

## Evidence

- [gateway/lib/work-history.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/lib/work-history.js:589)
  adds explicit deployment review/claim/verification/effect/receipt methods.
- [gateway/lib/work-history.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/lib/work-history.js:1526)
  blocks apply until review, preview, and passed verification exist.
- [gateway/lib/work-history.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/lib/work-history.js:1589)
  allows re-claim after lease expiry instead of freezing the request forever.
- [gateway/lib/work-history.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/lib/work-history.js:1657)
  requires backup/restore, drain, compatibility, smoke, and rollback refs on
  apply effect observation.
- [gateway/test/work-history-deployment-control.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/test/work-history-deployment-control.test.js:87)
  proves stale-claim rejection and fresh re-claim.
- [gateway/test/work-history-deployment-control.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane/gateway/test/work-history-deployment-control.test.js:164)
  proves immutable apply receipt replay and rollback convergence.

## Measured vs architecture confidence

- Measured: focused node test, `node --check`, and `npm run smoke:work-history-intent`.
- Architecture confidence only: live preview/apply/rollback adapters, target
  drain/resume, active URL cutover, backup restore on a real target, and
  post-apply smoke against a running deployment.

## Environment blockers

- `npm run smoke:work-history` is blocked here by `listen EPERM` on
  `127.0.0.1`.
- `npm run check` is blocked by missing local Node dependencies (`pg`, `ws`,
  `@executor-js/sdk`, `livekit-server-sdk`) and the same `listen EPERM`
  restriction in server-start smokes.
