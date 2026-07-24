# Tasks

## 1. Canonical Linkage Spine

- [x] 1.1 Add an idempotent bridge from current-turn work intent to the intent
  runtime and work-history store.
- [x] 1.2 Store `intent_id`, `intent_revision`, and
  `acceptance_contract_ref` on tasks and queued runs.
- [x] 1.3 Return and expose a `moa.delivery-intent.v1` projection.
- [x] 1.4 Prove retries create no duplicate intent, task, or run and that no
  claim, execution, deployment request, or promotion occurs.

Acceptance: posting the same explicit work-history turn twice produces one
durable intent, one linked work task, and one linked queued run. The delivery
projection traces every ID and the acceptance contract. Nothing executes.

Verification:

```sh
cd gateway
node --test test/intent-workflow.test.js test/work-history-handlers.test.js
node --test test/intent-runtime-routes.test.js
npm run smoke:work-history-intent
npm run check
```

## 2. Repository Contract And Candidate Evidence

- [ ] 2.1 Add an immutable machine-readable acceptance contract per approved
  OpenSpec ticket.
- [ ] 2.2 Bind worker isolation, before/after snapshots, diff, commit, and
  verification evidence to the intent revision and exact candidate.
- [ ] 2.3 Mark earlier candidate evidence stale when objective or acceptance
  revisions change.

## 3. User-Testable Preview And Release

- [ ] 3.1 Link device-reachable preview records and exact candidate digests.
- [ ] 3.2 Record explicit user acceptance/rejection against the same candidate.
- [ ] 3.3 Derive promotion-ready, promoted, smoked, and completed only from
  release-control and exact-artifact evidence.

## 4. Historical Import

- [ ] 4.1 Add cursor-based bounded history export and immutable evidence
  manifests.
- [ ] 4.2 Materialize only currently approved historical candidates.
- [ ] 4.3 Import legacy tasks/runs as non-executable linked evidence and keep
  unresolved records visible.

## 5. Product Surfaces

- [ ] 5.1 Show the delivery projection in the Android full app and browser
  inspection surface.
- [ ] 5.2 Keep compact status and handoff only in the overlay.
- [ ] 5.3 Link typed video/file evidence to the source intent without granting
  execution authority.
