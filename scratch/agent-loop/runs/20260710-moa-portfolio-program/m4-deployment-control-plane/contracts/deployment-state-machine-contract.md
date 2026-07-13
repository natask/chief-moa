# M4 deployment-control implementation contract

## Objective and non-negotiables

Implement a typed deployment-control state machine behind the existing
work-history store. Models and voice turns may create typed proposals only. A
deploy worker may claim, preview, verify, apply, receipt, and roll back through
bounded deterministic records. No raw shell commands, credentials, or live
promotion.

## Owned paths

- `gateway/lib/work-history.js`
- `gateway/scripts/smoke-work-history-intent.js`
- `gateway/scripts/smoke-work-history.js`
- focused gateway tests added for this slice
- `scratch/agent-loop/runs/20260710-moa-portfolio-program/m4-deployment-control-plane/`

Do not touch deployment scripts, remote servers, Android, browser extension,
worker-pull authority, or active environment config.

## Required behavior and edges

- Typed deployment proposals with explicit ids, target, mode, candidate/provenance
  refs, review state, and guarded-apply status.
- Deterministic preview/apply/rollback state transitions reconstructed from
  product events alone.
- Claim semantics that dedupe duplicate claims and reject stale or double-apply
  attempts.
- Guarded apply requires preview availability, successful verification, backup,
  restore-check, compatibility/drain evidence, and explicit approval markers.
- Immutable effect receipts: once apply or rollback is receipted, later retries
  return the original receipt instead of inventing a second effect.
- Crash-after-effect recovery path modeled by separate `effect_observed` and
  `receipt_recorded` evidence so replay can converge without duplicate effects.

## Forbidden shortcuts

- shell strings or executable scripts in proposals
- apply-before-preview or apply-before-verification
- mutable receipts or in-memory-only leases
- unbounded retry loops
- live deploy triggers presented as proof of apply
- fake adapters presented as live deployment success

## Quality and resource targets

Transition/guard helpers target cyclomatic complexity <=10 and CRAP <=15.
Retries, claims, candidate refs, and evidence refs stay constant-bounded.
Restart safety is measured only through deterministic fault tests in this slice;
real deployment safety remains architecture-confidence only.

## Acceptance commands

```sh
cd gateway
node --test test/work-history-deployment-control.test.js
npm run smoke:work-history-intent
npm run smoke:work-history
npm run check
```

Block on duplicate effects, stale-claim acceptance, mutable receipts,
apply-before-preview, or a state projection that cannot rebuild from events
alone.
