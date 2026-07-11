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
