# Claims ledger

| Implementer claim | Status | Evidence checked | Auditor verdict |
|---|---|---|---|
| Deployment proposals stay typed and non-executable | verified for deterministic store slice | `gateway/lib/work-history.js` request/review/claim/effect payloads are bounded typed fields; no shell string execution path added | pass for unit; live deploy infra still out of scope |
| Preview, verify, claim, guarded apply, receipt, and rollback rebuild from product events alone | verified for deterministic store slice | `cd gateway && node --test test/work-history-deployment-control.test.js`; rebuild assertion after reopening the JSONL event log | pass for unit |
| Duplicate claim/effect attempts converge to one immutable receipt | verified for deterministic store slice | focused test covers stale claim recovery, duplicate apply-effect rejection, and idempotent repeated receipt | pass for unit |
| Guarded apply rejects missing preview, verification, backup, restore, drain, or compatibility evidence | verified for deterministic store slice | `deploymentApplyGuard`, `assertDeploymentObservedEffect`, and focused test transitions | pass for unit |
| Fake adapters prove live deployment safety | refuted by contract | deterministic adapters are non-live by design | no live claim allowed |

Measured evidence in this packet is limited to file/jsonl store tests and
non-listening unit/smoke commands. Live deployment safety, target-specific
drain/resume, backup/restore, and preview URL behavior remain architecture
confidence only.

## Repair cycle 001

| Claim | Status | Evidence | Verdict |
|---|---|---|---|
| Requestless apply is impossible | verified | hostile direct-record test and listening smoke | pass |
| Preview/verification authority is bound and fresh | verified | wrong deployment/worker and expired-claim attacks | fresh audit pending |
| Effect recovery is explicit and durable | verified | effect expiry -> adoption -> receipt test | fresh audit pending |
| Idempotency is domain-separated and returned events validated | verified | cross-target collision attack and validators | fresh audit pending |
| Rebuild includes events after 500 | verified | 505 events; restarted first/last/count assertions | fresh audit pending |
| Receipt id reaches deployment record | verified | normal and recovery receipt assertions | fresh audit pending |
| Deployment refs reject objects, secrets and shell syntax | verified | focused hostile inputs | fresh audit pending |

Measured: focused 6/6, both work-history smokes pass, full gateway 178 pass,
1 skip, 0 fail. The skipped integration suite and every real target operation
remain unmeasured. No paid benchmark or external evaluation ran.

Architecture-confidence only: deterministic invariants support the source
design; they do not prove real drain, backup, restore, apply, rollback or
compatibility behavior.

Fresh audit cycle 1 returned two source blockers before its final report:
preview claims could expire after preview creation with no recovery path, and a
same-turn request replay could mutate non-target fields without detection.
Repair cycle 2 added preview re-claim/rebind, full semantic request fingerprints,
and a stable `event_id` pagination tie-break for JSON and Postgres. A fresh
separate-context gpt-5.4 re-audit returned PASS with no surviving source blocker.
